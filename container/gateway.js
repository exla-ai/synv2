// Synv2 Gateway Bridge — persistent OpenClaw connection with multi-client broadcast
// Owns a single OpenClaw session per project. All clients (supervisor + humans) share it.

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');

const PORT = parseInt(process.env.GATEWAY_PORT || '18789');
const OPENCLAW_PORT = parseInt(process.env.OPENCLAW_GATEWAY_PORT || '18790');
const OPENCLAW_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const PROJECT_NAME = process.env.PROJECT_NAME || 'project';

const SESSION_KEY = `main:webchat:synv2-${PROJECT_NAME}`;
const EVENT_BUFFER_SIZE = 50;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

// ── Shared state ────────────────────────────────────────────────
let openclawWs = null;
let ocConnected = false;
let agentBusy = false;
let reconnectAttempts = 0;
let reconnectTimer = null;

// Event buffer — last N events for late-joining clients
const eventBuffer = [];

// Connected clients: { ws, role: 'supervisor'|'human'|null }
const clients = new Set();

function getHumanCount() {
  let count = 0;
  for (const c of clients) {
    if (c.role === 'human') count++;
  }
  return count;
}

function isSupervisorConnected() {
  for (const c of clients) {
    if (c.role === 'supervisor') return true;
  }
  return false;
}

// ── Broadcast to all connected clients ──────────────────────────
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  }
}

function sendTo(client, msg) {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(msg));
  }
}

function bufferAndBroadcast(event) {
  eventBuffer.push(event);
  if (eventBuffer.length > EVENT_BUFFER_SIZE) {
    eventBuffer.shift();
  }
  broadcast(event);
}

// ── OpenClaw message extraction helpers ─────────────────────────
function extractText(message) {
  if (!message) return null;
  if (typeof message === 'string') return message;
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

// ── Persistent OpenClaw connection ──────────────────────────────
function connectToOpenClaw() {
  if (openclawWs && openclawWs.readyState === WebSocket.OPEN) return;

  console.log(`Connecting to OpenClaw on :${OPENCLAW_PORT} (session: ${SESSION_KEY})...`);

  openclawWs = new WebSocket(`ws://127.0.0.1:${OPENCLAW_PORT}`, {
    headers: { 'Origin': `http://127.0.0.1:${OPENCLAW_PORT}` },
  });

  openclawWs.on('open', () => {
    console.log('OpenClaw WS connected, waiting for challenge...');
  });

  openclawWs.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'event') {
      if (msg.event === 'connect.challenge') {
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

      // Chat events — broadcast to all clients
      else if (msg.event === 'chat') {
        const p = msg.payload || {};
        if (p.state === 'delta') {
          const text = extractText(p.message);
          if (text) bufferAndBroadcast({ type: 'text_delta', text });
        } else if (p.state === 'final') {
          agentBusy = false;
          bufferAndBroadcast({ type: 'done' });
        } else if (p.state === 'error') {
          agentBusy = false;
          bufferAndBroadcast({ type: 'error', error: p.errorMessage || 'Chat error' });
        } else if (p.state === 'aborted') {
          agentBusy = false;
          bufferAndBroadcast({ type: 'done' });
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
            bufferAndBroadcast({ type: 'tool_start', tool: name });
            bufferAndBroadcast({ type: 'tool_use', tool: name, input: typeof d.args === 'string' ? d.args : JSON.stringify(d.args || {}) });
          } else if (phase === 'result') {
            const output = typeof d.result === 'string' ? d.result : JSON.stringify(d.result || '');
            bufferAndBroadcast({ type: 'tool_result', tool: name, output });
          }
        }
      }
    }

    else if (msg.type === 'res') {
      if (msg.ok && msg.payload?.type === 'hello-ok') {
        console.log(`OpenClaw handshake complete (protocol ${msg.payload.protocol})`);
        ocConnected = true;
        reconnectAttempts = 0;
        // Notify all clients that we're connected
        broadcast({ type: 'status', agentBusy, humanCount: getHumanCount(), supervisorConnected: isSupervisorConnected(), ocConnected: true });
      } else if (msg.ok && msg.payload?.runId) {
        // chat.send acknowledged
        agentBusy = true;
      } else if (!msg.ok && msg.error) {
        console.error('OpenClaw error:', JSON.stringify(msg.error));
        bufferAndBroadcast({ type: 'error', error: msg.error?.message || msg.error?.code || 'OpenClaw error' });
      }
    }
  });

  openclawWs.on('error', (err) => {
    console.error('OpenClaw WS error:', err.message);
  });

  openclawWs.on('close', (code) => {
    console.log(`OpenClaw WS closed (code: ${code})`);
    ocConnected = false;
    agentBusy = false;
    openclawWs = null;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
  reconnectAttempts++;
  console.log(`Reconnecting to OpenClaw in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToOpenClaw();
  }, delay);
}

function sendToAgent(text) {
  if (!openclawWs || openclawWs.readyState !== WebSocket.OPEN || !ocConnected) {
    console.log('Cannot send to agent: OpenClaw not connected');
    return false;
  }
  openclawWs.send(JSON.stringify({
    type: 'req',
    id: crypto.randomUUID(),
    method: 'chat.send',
    params: {
      sessionKey: SESSION_KEY,
      message: text,
      deliver: false,
      idempotencyKey: crypto.randomUUID(),
    },
  }));
  agentBusy = true;
  return true;
}

// ── HTTP health endpoint ────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      gateway: 'synv2',
      project: PROJECT_NAME,
      ocConnected,
      agentBusy,
      clients: clients.size,
      humans: getHumanCount(),
      supervisorConnected: isSupervisorConnected(),
    }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ── Client WebSocket server ─────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (clientWs) => {
  const client = { ws: clientWs, role: null };
  clients.add(client);
  console.log(`Client connected (${clients.size} total)`);

  // Send buffered history so late-joiners see recent context
  sendTo(client, { type: 'history', events: [...eventBuffer] });

  // Send current status
  sendTo(client, {
    type: 'status',
    agentBusy,
    humanCount: getHumanCount(),
    supervisorConnected: isSupervisorConnected(),
    ocConnected,
  });

  clientWs.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'identify' && msg.role) {
      const oldRole = client.role;
      client.role = msg.role;
      console.log(`Client identified as: ${msg.role}`);

      // Broadcast human count change if a human connected
      if (msg.role === 'human' || oldRole === 'human') {
        broadcast({
          type: 'client_change',
          humans: getHumanCount(),
          supervisorConnected: isSupervisorConnected(),
        });
      }
    }

    else if (msg.type === 'user_message' && msg.content) {
      if (ocConnected) {
        sendToAgent(msg.content);
      } else {
        sendTo(client, { type: 'error', error: 'OpenClaw not connected yet, please wait' });
      }
    }
  });

  clientWs.on('close', () => {
    const wasHuman = client.role === 'human';
    clients.delete(client);
    console.log(`Client disconnected (${clients.size} remaining, was ${client.role || 'unidentified'})`);

    // Broadcast human count change if a human disconnected
    if (wasHuman) {
      broadcast({
        type: 'client_change',
        humans: getHumanCount(),
        supervisorConnected: isSupervisorConnected(),
      });
    }
  });
});

// ── Startup ─────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Synv2 gateway listening on :${PORT}`);
  console.log(`OpenClaw gateway at :${OPENCLAW_PORT}`);
  console.log(`Project: ${PROJECT_NAME}`);
  console.log(`Session key: ${SESSION_KEY}`);

  // Connect to OpenClaw immediately
  connectToOpenClaw();
});
