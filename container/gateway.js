// Synv2 Agent Gateway — WebSocket server that wraps Claude API with tool use
// Listens on port 18789, accepts WS connections, relays to Anthropic API

const http = require('http');
const { WebSocketServer } = require('ws');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.GATEWAY_PORT || '18789');
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';
const WORKSPACE = process.env.WORKSPACE || '/workspace';
const MAX_TOKENS = 16384;

if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY is required');
  process.exit(1);
}

// ── Tools available to Claude ───────────────────────────────────
const tools = [
  {
    name: 'bash',
    description: 'Execute a bash command and return stdout/stderr. Working directory is the project workspace.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to workspace or absolute)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file (creates directories as needed)',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to workspace or absolute)' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_files',
    description: 'List files and directories at a path',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (relative to workspace or absolute)' },
        recursive: { type: 'boolean', description: 'List recursively (default false)' },
      },
      required: ['path'],
    },
  },
];

function resolvePath(p) {
  if (path.isAbsolute(p)) return p;
  return path.join(WORKSPACE, p);
}

function executeTool(name, input) {
  try {
    switch (name) {
      case 'bash': {
        const timeout = input.timeout || 30000;
        const result = execSync(input.command, {
          cwd: WORKSPACE,
          timeout,
          maxBuffer: 1024 * 1024,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return result || '(no output)';
      }
      case 'read_file': {
        const fp = resolvePath(input.path);
        return fs.readFileSync(fp, 'utf-8');
      }
      case 'write_file': {
        const fp = resolvePath(input.path);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, input.content);
        return `Written to ${fp}`;
      }
      case 'list_files': {
        const fp = resolvePath(input.path);
        if (input.recursive) {
          const result = execSync(`find "${fp}" -maxdepth 3 -type f 2>/dev/null | head -200`, {
            encoding: 'utf-8',
            cwd: WORKSPACE,
          });
          return result || '(empty)';
        }
        return fs.readdirSync(fp).join('\n') || '(empty)';
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err.message}${err.stderr ? '\nstderr: ' + err.stderr : ''}`;
  }
}

// ── Anthropic API streaming ─────────────────────────────────────
async function streamChat(messages, sendDelta) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: `You are a helpful AI assistant working on a software project. Your workspace is ${WORKSPACE}. You have tools to execute bash commands, read/write files, and list directories. Be concise and helpful.`,
    tools,
    messages,
  };

  while (true) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ ...body, stream: true }),
    });

    if (!res.ok) {
      const errText = await res.text();
      sendDelta({ type: 'error', error: `API error ${res.status}: ${errText}` });
      return messages;
    }

    // Parse SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentToolUse = null;
    let currentToolInput = '';
    let assistantContent = [];
    let stopReason = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        switch (event.type) {
          case 'content_block_start':
            if (event.content_block?.type === 'tool_use') {
              currentToolUse = { id: event.content_block.id, name: event.content_block.name };
              currentToolInput = '';
              sendDelta({ type: 'tool_use', tool: event.content_block.name });
            }
            break;

          case 'content_block_delta':
            if (event.delta?.type === 'text_delta') {
              sendDelta({ type: 'text_delta', text: event.delta.text });
            } else if (event.delta?.type === 'input_json_delta') {
              currentToolInput += event.delta.partial_json || '';
            }
            break;

          case 'content_block_stop':
            if (currentToolUse) {
              let toolInput = {};
              try {
                toolInput = JSON.parse(currentToolInput);
              } catch {}
              sendDelta({ type: 'tool_use', tool: currentToolUse.name, input: JSON.stringify(toolInput) });
              assistantContent.push({
                type: 'tool_use',
                id: currentToolUse.id,
                name: currentToolUse.name,
                input: toolInput,
              });
              currentToolUse = null;
              currentToolInput = '';
            }
            break;

          case 'message_start':
            break;

          case 'message_delta':
            if (event.delta?.stop_reason) {
              stopReason = event.delta.stop_reason;
            }
            break;
        }
      }
    }

    // Collect text blocks from what we streamed
    // We need to reconstruct the assistant message from the stream
    // Text was streamed via deltas, but we also need it in the messages array
    // Let's gather it by re-reading — actually, let's track it during streaming
    // For simplicity, let's do a non-streaming follow-up if there were tool uses

    if (stopReason === 'tool_use' && assistantContent.length > 0) {
      // Build the full assistant message (text + tool_use blocks)
      // We need to add any text that was streamed too
      // Since we streamed text deltas, we need to reconstruct
      // For now, do a non-streaming call to get the full message for tool use loops

      const nonStreamRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      if (!nonStreamRes.ok) {
        sendDelta({ type: 'error', error: `API error on tool loop` });
        return messages;
      }

      const fullMsg = await nonStreamRes.json();
      messages.push({ role: 'assistant', content: fullMsg.content });

      // Execute tools and add results
      const toolResults = [];
      for (const block of fullMsg.content) {
        if (block.type === 'tool_use') {
          const result = executeTool(block.name, block.input);
          sendDelta({ type: 'tool_result', output: result });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
      body.messages = messages;
      // Loop back for next turn
      continue;
    }

    // No more tool use — we're done
    sendDelta({ type: 'done' });
    return messages;
  }
}

// ── HTTP + WebSocket server ─────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, gateway: 'synv2' }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Client connected');
  let conversationMessages = [];

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      return;
    }

    if (msg.type === 'user_message' && msg.content) {
      conversationMessages.push({ role: 'user', content: msg.content });

      const sendDelta = (delta) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify(delta));
        }
      };

      try {
        conversationMessages = await streamChat(conversationMessages, sendDelta);
      } catch (err) {
        sendDelta({ type: 'error', error: err.message });
      }
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

server.listen(PORT, () => {
  console.log(`Synv2 gateway listening on :${PORT}`);
});
