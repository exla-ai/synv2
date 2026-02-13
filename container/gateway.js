// Synv2 Gateway Bridge — translates synv2 WS protocol to OpenClaw gateway protocol
// Sits between the control plane proxy and the OpenClaw gateway running locally

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');

const PORT = parseInt(process.env.GATEWAY_PORT || '18789');
const OPENCLAW_PORT = parseInt(process.env.OPENCLAW_GATEWAY_PORT || '18790');
const OPENCLAW_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const PROJECT_NAME = process.env.PROJECT_NAME || 'project';

// ── HTTP health endpoint ──────────────────────────────────────
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

wss.on('connection', (clientWs) => {
  console.log('Client connected — opening OpenClaw session');

  let openclawWs = null;
  let connected = false;
  let pendingMessages = [];
  let sessionKey = `main:webchat:synv2-${PROJECT_NAME}`;
  let currentRunId = null;

  function send(obj) {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(obj));
    }
  }

  // Connect to local OpenClaw gateway
  openclawWs = new WebSocket(`ws://127.0.0.1:${OPENCLAW_PORT}`, {
    headers: { 'Origin': `http://127.0.0.1:${OPENCLAW_PORT}` },
  });

  openclawWs.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'event') {
      if (msg.event === 'connect.challenge') {
        // Respond with connect handshake
        openclawWs.send(JSON.stringify({
          type: 'req',
          id: crypto.randomUUID(),
          method: 'connect',
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: 'webchat',
              version: '0.1.0',
              platform: 'linux',
              mode: 'webchat',
            },
            role: 'operator',
            scopes: ['operator.read', 'operator.write'],
            caps: [],
            auth: { token: OPENCLAW_TOKEN },
            userAgent: 'synv2-gateway/0.1.0',
          },
        }));
      }

      // Chat events — text streaming
      else if (msg.event === 'chat') {
        const p = msg.payload || {};
        if (p.state === 'delta') {
          // Extract text from message content
          const text = extractText(p.message);
          if (text) send({ type: 'text_delta', text });
        } else if (p.state === 'final') {
          send({ type: 'done' });
          currentRunId = null;
        } else if (p.state === 'error') {
          send({ type: 'error', error: p.errorMessage || 'Chat error' });
          currentRunId = null;
        } else if (p.state === 'aborted') {
          send({ type: 'done' });
          currentRunId = null;
        }
      }

      // Agent events — tool use
      else if (msg.event === 'agent') {
        const p = msg.payload || {};
        if (p.stream === 'tool' && p.data) {
          const d = p.data;
          const phase = d.phase || '';
          const name = d.name || 'tool';

          if (phase === 'start') {
            send({ type: 'tool_start', tool: name });
            send({ type: 'tool_use', tool: name, input: typeof d.args === 'string' ? d.args : JSON.stringify(d.args || {}) });
          } else if (phase === 'result') {
            const output = typeof d.result === 'string' ? d.result : JSON.stringify(d.result || '');
            send({ type: 'tool_result', tool: name, output });
          }
        }
      }
    }

    else if (msg.type === 'res') {
      if (msg.ok && msg.payload?.type === 'hello-ok') {
        console.log('Connected to OpenClaw gateway (protocol', msg.payload.protocol + ')');
        connected = true;
        // Flush pending messages
        for (const text of pendingMessages) {
          sendToAgent(text);
        }
        pendingMessages = [];
      } else if (msg.ok && msg.payload?.runId) {
        currentRunId = msg.payload.runId;
      } else if (!msg.ok && msg.error) {
        console.error('OpenClaw error:', JSON.stringify(msg.error));
        send({ type: 'error', error: msg.error?.message || msg.error?.code || 'OpenClaw error' });
      }
    }
  });

  function extractText(message) {
    if (!message) return null;
    if (typeof message === 'string') return message;
    // message can be an array of content blocks
    if (Array.isArray(message)) {
      return message
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
    }
    if (message.content) return extractText(message.content);
    if (message.text) return message.text;
    return null;
  }

  function sendToAgent(text) {
    if (!openclawWs || openclawWs.readyState !== WebSocket.OPEN) return;
    openclawWs.send(JSON.stringify({
      type: 'req',
      id: crypto.randomUUID(),
      method: 'chat.send',
      params: {
        sessionKey,
        message: text,
        deliver: false,
        idempotencyKey: crypto.randomUUID(),
      },
    }));
  }

  openclawWs.on('error', (err) => {
    console.error('OpenClaw WS error:', err.message);
    send({ type: 'error', error: `OpenClaw connection error: ${err.message}` });
  });

  openclawWs.on('close', () => {
    console.log('OpenClaw connection closed');
  });

  clientWs.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'user_message' && msg.content) {
      if (connected) {
        sendToAgent(msg.content);
      } else {
        pendingMessages.push(msg.content);
      }
    }
  });

  clientWs.on('close', () => {
    console.log('Client disconnected');
    try { if (openclawWs?.readyState === WebSocket.OPEN) openclawWs.close(); } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`Synv2 bridge gateway listening on :${PORT}`);
  console.log(`OpenClaw gateway at :${OPENCLAW_PORT}`);
  console.log(`Project: ${PROJECT_NAME}`);
});
