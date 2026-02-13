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
  let sessionKey = null;

  // Connect to local OpenClaw gateway
  openclawWs = new WebSocket(`ws://127.0.0.1:${OPENCLAW_PORT}`);

  openclawWs.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // Handle OpenClaw protocol messages
    switch (msg.type) {
      case 'event':
        if (msg.event === 'connect.challenge') {
          // Respond with connect request
          const connectReq = {
            type: 'req',
            id: crypto.randomUUID(),
            method: 'connect',
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: `synv2-${PROJECT_NAME}`,
                version: '0.1.0',
                platform: 'linux',
                mode: 'operator',
              },
              role: 'operator',
              scopes: ['operator.read', 'operator.write'],
              caps: [],
              commands: [],
              permissions: {},
              auth: { token: OPENCLAW_TOKEN },
              locale: 'en-US',
              userAgent: `synv2-gateway/0.1.0`,
            },
          };
          openclawWs.send(JSON.stringify(connectReq));
        } else if (msg.event === 'agent.text') {
          // Stream text delta to client
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'text_delta', text: msg.payload?.text || '' }));
          }
        } else if (msg.event === 'agent.tool_call') {
          // Tool call started
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'tool_start',
              tool: msg.payload?.name || msg.payload?.tool || 'tool',
            }));
          }
        } else if (msg.event === 'agent.tool_result') {
          // Tool result
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
              type: 'tool_result',
              tool: msg.payload?.name || '',
              output: msg.payload?.output || msg.payload?.result || '',
            }));
          }
        } else if (msg.event === 'agent.done' || msg.event === 'agent.end') {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'done' }));
          }
        } else if (msg.event === 'agent.error') {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'error', error: msg.payload?.message || 'Agent error' }));
          }
        }
        // Forward any other events as raw for debugging
        break;

      case 'res':
        if (msg.ok && msg.payload?.type === 'hello-ok') {
          console.log('Connected to OpenClaw gateway');
          connected = true;
          // Send any pending messages
          for (const pendingMsg of pendingMessages) {
            sendToAgent(pendingMsg);
          }
          pendingMessages = [];
        } else if (msg.ok && msg.payload?.sessionKey) {
          sessionKey = msg.payload.sessionKey;
        } else if (!msg.ok && msg.error) {
          console.error('OpenClaw error:', msg.error);
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'error', error: msg.error?.message || 'OpenClaw error' }));
          }
        }
        break;
    }
  });

  function sendToAgent(text) {
    if (!openclawWs || openclawWs.readyState !== WebSocket.OPEN) return;

    const req = {
      type: 'req',
      id: crypto.randomUUID(),
      method: 'chat.send',
      params: {
        message: text,
        session: sessionKey || `synv2:${PROJECT_NAME}`,
      },
    };
    openclawWs.send(JSON.stringify(req));
  }

  openclawWs.on('error', (err) => {
    console.error('OpenClaw WS error:', err.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'error', error: `OpenClaw connection error: ${err.message}` }));
    }
  });

  openclawWs.on('close', () => {
    console.log('OpenClaw connection closed');
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'done' }));
    }
  });

  // Handle incoming messages from synv2 client
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
    if (openclawWs && openclawWs.readyState === WebSocket.OPEN) {
      try { openclawWs.close(); } catch {}
    }
  });
});

server.listen(PORT, () => {
  console.log(`Synv2 bridge gateway listening on :${PORT}`);
  console.log(`OpenClaw gateway at :${OPENCLAW_PORT}`);
  console.log(`Project: ${PROJECT_NAME}`);
});
