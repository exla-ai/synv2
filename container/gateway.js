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
const PROJECT_NAME = process.env.PROJECT_NAME || 'project';
const MAX_TOKENS = 16384;
const MAX_TOOL_TURNS = 25;

if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY is required');
  process.exit(1);
}

// ── Detect available services from env ──────────────────────────
function detectServices() {
  const services = [];
  if (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) {
    services.push('Modal (serverless GPU/CPU compute) — `modal` CLI is available. You can create and deploy Modal apps, run functions on cloud GPUs, etc.');
  }
  if (process.env.VERCEL_TOKEN) {
    services.push('Vercel — deploy frontend apps with `npx vercel --token $VERCEL_TOKEN`');
  }
  if (process.env.FLY_API_TOKEN) {
    services.push('Fly.io — deploy backend services with `flyctl`');
  }
  if (process.env.SUPABASE_ACCESS_TOKEN) {
    services.push('Supabase — database and auth platform. `supabase` Python SDK is available.');
  }
  if (process.env.GITHUB_TOKEN) {
    services.push('GitHub — `git` is available with authentication. You can clone repos, create branches, push code.');
  }
  if (process.env.EXA_API_KEY) {
    services.push('Exa — AI-powered web search API. Use via HTTP: `curl -H "x-api-key: $EXA_API_KEY" https://api.exa.ai/search`');
  }
  if (process.env.DISCORD_BOT_TOKEN) {
    services.push('Discord — bot token available for building Discord bots.');
  }
  return services;
}

function buildSystemPrompt() {
  const services = detectServices();
  const serviceBlock = services.length > 0
    ? `\n\nYou have the following services authenticated and ready to use:\n${services.map(s => `- ${s}`).join('\n')}`
    : '';

  return `You are Synv2, an AI software engineer. You are working on project "${PROJECT_NAME}".

Your workspace is ${WORKSPACE}. You have full access to a Linux environment with bash, Node.js 22, Python 3, pnpm, git, and standard dev tools.

You can:
- Execute any bash command (install packages, run scripts, use git, etc.)
- Read and write files anywhere in the workspace
- Search code with ripgrep (\`rg\`)
- Build and deploy applications
- Create and run Modal serverless functions (if configured)${serviceBlock}

Guidelines:
- Be direct and concise. Show what you're doing, not what you're about to do.
- When asked to build something, just build it. Write the code, install deps, run it.
- When using tools, chain multiple operations efficiently — don't ask for permission.
- For errors, debug and fix them autonomously. Read logs, check output, iterate.
- When writing code, use modern best practices. No unnecessary boilerplate.
- Format code output with proper syntax. Keep explanations brief.`;
}

// ── Tools available to Claude ───────────────────────────────────
const tools = [
  {
    name: 'bash',
    description: 'Execute a bash command in the workspace. Use for: running scripts, installing packages, git operations, deploying, searching code, and any shell task. Commands run with a 120s default timeout.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file. Returns the full contents. Use for examining source code, configs, logs, etc.',
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
    description: 'Write content to a file. Creates parent directories automatically. Use for creating new files or completely replacing file contents.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to workspace or absolute)' },
        content: { type: 'string', description: 'Complete file content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Make targeted edits to a file by replacing specific text. More precise than write_file for modifying existing files. old_text must match exactly (including whitespace).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to workspace or absolute)' },
        old_text: { type: 'string', description: 'Exact text to find and replace' },
        new_text: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'list_files',
    description: 'List files in a directory. Use recursive=true to see the full tree (capped at 200 entries, max depth 4).',
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
        const timeout = input.timeout || 120000;
        try {
          const result = execSync(input.command, {
            cwd: WORKSPACE,
            timeout,
            maxBuffer: 4 * 1024 * 1024,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          return result || '(no output)';
        } catch (err) {
          // Include both stdout and stderr for failed commands
          let output = '';
          if (err.stdout) output += err.stdout;
          if (err.stderr) output += (output ? '\n' : '') + err.stderr;
          if (!output) output = err.message;
          return `Exit code ${err.status || 1}\n${output}`;
        }
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
      case 'edit_file': {
        const fp = resolvePath(input.path);
        const content = fs.readFileSync(fp, 'utf-8');
        if (!content.includes(input.old_text)) {
          return `Error: old_text not found in ${fp}`;
        }
        const newContent = content.replace(input.old_text, input.new_text);
        fs.writeFileSync(fp, newContent);
        return `Edited ${fp}`;
      }
      case 'list_files': {
        const fp = resolvePath(input.path);
        if (input.recursive) {
          const result = execSync(`find "${fp}" -maxdepth 4 -type f 2>/dev/null | head -200`, {
            encoding: 'utf-8',
            cwd: WORKSPACE,
          });
          return result || '(empty)';
        }
        const entries = fs.readdirSync(fp, { withFileTypes: true });
        return entries.map(e => e.isDirectory() ? e.name + '/' : e.name).join('\n') || '(empty)';
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// ── Anthropic API with proper streaming + tool loop ─────────────
async function streamChat(messages, sendDelta) {
  const systemPrompt = buildSystemPrompt();
  let turns = 0;

  while (turns < MAX_TOOL_TURNS) {
    turns++;

    const body = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      tools,
      messages,
      stream: true,
    };

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      sendDelta({ type: 'error', error: `API error ${res.status}: ${errText}` });
      return messages;
    }

    // Parse SSE stream and build full assistant response
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let assistantContent = [];
    let currentText = '';
    let currentToolUse = null;
    let currentToolInput = '';
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
        try { event = JSON.parse(data); } catch { continue; }

        switch (event.type) {
          case 'content_block_start':
            if (event.content_block?.type === 'tool_use') {
              // Flush accumulated text
              if (currentText) {
                assistantContent.push({ type: 'text', text: currentText });
                currentText = '';
              }
              currentToolUse = { id: event.content_block.id, name: event.content_block.name };
              currentToolInput = '';
              sendDelta({ type: 'tool_start', tool: event.content_block.name });
            }
            break;

          case 'content_block_delta':
            if (event.delta?.type === 'text_delta') {
              sendDelta({ type: 'text_delta', text: event.delta.text });
              currentText += event.delta.text;
            } else if (event.delta?.type === 'input_json_delta') {
              currentToolInput += event.delta.partial_json || '';
            }
            break;

          case 'content_block_stop':
            if (currentToolUse) {
              let toolInput = {};
              try { toolInput = JSON.parse(currentToolInput); } catch {}
              assistantContent.push({
                type: 'tool_use',
                id: currentToolUse.id,
                name: currentToolUse.name,
                input: toolInput,
              });
              sendDelta({ type: 'tool_use', tool: currentToolUse.name, input: JSON.stringify(toolInput) });
              currentToolUse = null;
              currentToolInput = '';
            }
            break;

          case 'message_delta':
            if (event.delta?.stop_reason) {
              stopReason = event.delta.stop_reason;
            }
            break;
        }
      }
    }

    // Flush any remaining text
    if (currentText) {
      assistantContent.push({ type: 'text', text: currentText });
    }

    // Add assistant message to conversation
    messages.push({ role: 'assistant', content: assistantContent });

    // If no tool use, we're done
    if (stopReason !== 'tool_use') {
      sendDelta({ type: 'done' });
      return messages;
    }

    // Execute tools and build tool results
    const toolResults = [];
    for (const block of assistantContent) {
      if (block.type === 'tool_use') {
        const result = executeTool(block.name, block.input);
        // Truncate very long results
        const truncated = result.length > 50000
          ? result.substring(0, 50000) + '\n... (truncated)'
          : result;
        sendDelta({ type: 'tool_result', tool: block.name, output: truncated });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: truncated,
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
    // Continue loop for next turn
  }

  sendDelta({ type: 'error', error: 'Max tool turns reached' });
  return messages;
}

// ── HTTP + WebSocket server ─────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, gateway: 'synv2', project: PROJECT_NAME }));
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
  console.log(`Project: ${PROJECT_NAME}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Services: ${detectServices().length} configured`);
});
