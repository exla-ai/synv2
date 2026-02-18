// Synv2 Worker Agent — thin HTTP/WS server running on each worker EC2 instance.
// Manages the local Docker container and proxies requests from the control plane.

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ── Configuration ─────────────────────────────────────────────
const CONFIG_PATH = process.env.WORKER_CONFIG || '/opt/synv2/worker-config.json';
let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (err) {
  console.error(`Failed to read worker config from ${CONFIG_PATH}: ${err.message}`);
  process.exit(1);
}

const PORT = config.port || 18800;
const PROJECT_NAME = config.projectName;
const CONTROL_PLANE_HOST = config.controlPlaneHost;
const WORKER_TOKEN = config.workerToken;
const CONTAINER_NAME = `synv2-${PROJECT_NAME}`;
const VOLUME_NAME = `synv2-${PROJECT_NAME}-workspace`;
const NETWORK_NAME = 'synv2-net';
const IMAGE_NAME = 'synv2-project';
const GATEWAY_PORT = 18789;
const SUPERVISOR_LOG_FILE = '/workspace/.supervisor.log';

console.log(`Worker agent starting for project: ${PROJECT_NAME}`);
console.log(`Port: ${PORT}`);

// ── Auth middleware ───────────────────────────────────────────
function requireAuth(req, res) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }
  const token = auth.slice(7);
  if (token !== WORKER_TOKEN) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden' }));
    return false;
  }
  return true;
}

// ── Docker helpers ────────────────────────────────────────────
function getContainerIp() {
  try {
    const inspect = JSON.parse(execSync(`docker inspect ${CONTAINER_NAME}`, { timeout: 10000 }).toString());
    return inspect[0]?.NetworkSettings?.Networks?.[NETWORK_NAME]?.IPAddress || null;
  } catch {
    return null;
  }
}

function isContainerRunning() {
  try {
    const state = execSync(`docker inspect -f '{{.State.Running}}' ${CONTAINER_NAME}`, { timeout: 5000 }).toString().trim();
    return state === 'true';
  } catch {
    return false;
  }
}

async function createContainer(env) {
  // Ensure network exists
  try { execSync(`docker network create ${NETWORK_NAME} 2>/dev/null`); } catch {}

  // Ensure volume exists
  try { execSync(`docker volume create ${VOLUME_NAME}`); } catch {}

  // Remove existing container if any
  try {
    execSync(`docker stop ${CONTAINER_NAME} 2>/dev/null && docker rm ${CONTAINER_NAME} 2>/dev/null`);
  } catch {}

  // Build env args
  const envArgs = Object.entries(env).map(([k, v]) => `-e "${k}=${v}"`).join(' ');

  const limits = resolveContainerLimits(env);
  console.log(
    `[container-limits] project=${PROJECT_NAME}` +
    ` host_cpus=${limits.hostCpus}` +
    ` host_memory_mb=${limits.hostMemoryMb}` +
    ` requested_cpus=${String(limits.requestedCpus)}` +
    ` requested_memory_mb=${String(limits.requestedMemoryMb)}` +
    ` applied_cpus=${limits.cpus}` +
    ` applied_memory_mb=${limits.memoryMb}`
  );

  const cmd = `docker run -d --name ${CONTAINER_NAME}` +
    ` --network ${NETWORK_NAME}` +
    ` --restart unless-stopped` +
    ` --memory ${limits.memoryMb}m` +
    ` --cpus ${limits.cpus}` +
    ` -v ${VOLUME_NAME}:/workspace` +
    ` ${envArgs}` +
    ` ${IMAGE_NAME}`;

  execSync(cmd, { timeout: 60000 });

  // Wait for gateway health
  const start = Date.now();
  while (Date.now() - start < 120000) {
    const ip = getContainerIp();
    if (ip) {
      try {
        const res = await fetch(`http://${ip}:${GATEWAY_PORT}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) return { ok: true, containerId: CONTAINER_NAME };
      } catch {}
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  throw new Error('Container gateway health check timed out');
}

async function destroyContainer(removeVolume = false) {
  try {
    execSync(`docker stop ${CONTAINER_NAME}`, { timeout: 15000 });
  } catch {}
  try {
    execSync(`docker rm -f ${CONTAINER_NAME}`, { timeout: 10000 });
  } catch {}

  if (removeVolume) {
    try {
      execSync(`docker volume rm ${VOLUME_NAME}`, { timeout: 10000 });
    } catch {}
  }
}

function execInContainer(cmd) {
  return execSync(`docker exec ${CONTAINER_NAME} ${cmd}`, { timeout: 30000 }).toString();
}

function resolveContainerLimits(env) {
  const hostCpus = Math.max(1, os.cpus().length || 1);
  const hostMemoryMb = Math.max(1024, Math.floor(os.totalmem() / (1024 * 1024)));
  const requestedCpus = Number.parseFloat(env.INSTANCE_CPUS || '');
  const requestedMemoryMb = Number.parseInt(env.INSTANCE_MEMORY_MB || '', 10);

  const cpus = Math.max(1, Math.min(hostCpus, Number.isFinite(requestedCpus) ? requestedCpus : hostCpus));
  const memoryMbCap = Math.max(1024, Math.floor(hostMemoryMb * 0.9));
  const memoryMb = Math.max(1024, Math.min(memoryMbCap, Number.isFinite(requestedMemoryMb) ? requestedMemoryMb : memoryMbCap));

  return { cpus, memoryMb, hostCpus, hostMemoryMb, requestedCpus, requestedMemoryMb };
}

// ── HTTP request body parser ─────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// ── HTTP Server ──────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '', `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  // Health endpoint — no auth needed
  if (path === '/health' && method === 'GET') {
    const running = isContainerRunning();
    let gatewayHealth = null;

    if (running) {
      const ip = getContainerIp();
      if (ip) {
        try {
          const gRes = await fetch(`http://${ip}:${GATEWAY_PORT}/health`, {
            signal: AbortSignal.timeout(3000),
          });
          if (gRes.ok) gatewayHealth = await gRes.json();
        } catch {}
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      worker: 'synv2',
      project: PROJECT_NAME,
      containerRunning: running,
      gateway: gatewayHealth,
    }));
    return;
  }

  // All other endpoints require auth
  if (!requireAuth(req, res)) return;

  try {
    // POST /container/create — create project container
    if (path === '/container/create' && method === 'POST') {
      const body = await parseBody(req);
      const env = body.env || {};
      const result = await createContainer(env);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }

    // POST /container/restart — restart container
    else if (path === '/container/restart' && method === 'POST') {
      const body = await parseBody(req);
      const env = body.env || {};
      await destroyContainer(false);
      const result = await createContainer(env);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }

    // POST /container/destroy — destroy container
    else if (path === '/container/destroy' && method === 'POST') {
      const body = await parseBody(req);
      const removeVolume = body.removeVolume || false;
      await destroyContainer(removeVolume);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }

    // GET /container/health — check container gateway health
    else if (path === '/container/health' && method === 'GET') {
      const ip = getContainerIp();
      if (!ip) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'container_not_running' }));
        return;
      }

      try {
        const gRes = await fetch(`http://${ip}:${GATEWAY_PORT}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        const health = await gRes.json();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
      } catch (err) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'gateway_unreachable', message: err.message }));
      }
    }

    // POST /task — write .task.json to container volume
    else if (path === '/task' && method === 'POST') {
      const body = await parseBody(req);
      const json = JSON.stringify(body, null, 2);
      execInContainer(`bash -c 'cat > /workspace/.task.json << '"'"'TASKEOF'"'"'\n${json}\nTASKEOF'`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }

    // GET /memory — read memory files from container
    else if (path === '/memory' && method === 'GET') {
      let short = '', long = '', plan = '';
      try { short = execInContainer('cat /workspace/SHORT_TERM_MEMORY.md'); } catch {}
      try { long = execInContainer('cat /workspace/LONG_TERM_MEMORY.md'); } catch {}
      try { plan = execInContainer('cat /workspace/plan.md'); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ short_term: short, long_term: long, plan }));
    }

    // GET /logs — tail supervisor logs
    else if (path === '/logs' && method === 'GET') {
      const lines = url.searchParams.get('lines') || '100';
      let logs = '';
      try { logs = execInContainer(`tail -n ${lines} ${SUPERVISOR_LOG_FILE}`); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ logs }));
    }

    // POST /exec — execute arbitrary command in container
    else if (path === '/exec' && method === 'POST') {
      const body = await parseBody(req);
      const cmd = body.cmd;
      if (!cmd || !Array.isArray(cmd)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'cmd must be an array of strings' }));
        return;
      }
      const output = execInContainer(cmd.join(' '));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ output }));
    }

    // POST /supervisor/control — proxy supervisor control to container gateway
    else if (path === '/supervisor/control' && method === 'POST') {
      const body = await parseBody(req);
      const action = body.action;
      if (!action) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'action required' }));
        return;
      }

      const ip = getContainerIp();
      if (!ip) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'container_not_running' }));
        return;
      }

      const gRes = await fetch(`http://${ip}:${GATEWAY_PORT}/supervisor/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
        signal: AbortSignal.timeout(10000),
      });

      const result = await gRes.json();
      res.writeHead(gRes.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }

    // POST /message — send message to agent via gateway
    else if (path === '/message' && method === 'POST') {
      const body = await parseBody(req);
      const message = body.message;
      if (!message) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'message required' }));
        return;
      }

      const ip = getContainerIp();
      if (!ip) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'container_not_running' }));
        return;
      }

      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${ip}:${GATEWAY_PORT}`);
        const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);

        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'user_message', content: message }));
          clearTimeout(timeout);
          ws.close();
          resolve();
        });
        ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sent: true }));
    }

    else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    }
  } catch (err) {
    console.error(`Error handling ${method} ${path}:`, err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// ── WebSocket proxy to container gateway ─────────────────────
const wss = new WebSocketServer({ server, path: '/gateway' });

wss.on('connection', (clientWs, req) => {
  // Verify auth via query param
  const url = new URL(req.url || '', `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');
  if (token !== WORKER_TOKEN) {
    clientWs.close(4001, 'Unauthorized');
    return;
  }

  const ip = getContainerIp();
  if (!ip) {
    clientWs.close(4004, 'Container not running');
    return;
  }

  // Proxy to container gateway
  const upstreamWs = new WebSocket(`ws://${ip}:${GATEWAY_PORT}`);

  upstreamWs.on('open', () => {
    clientWs.on('message', (data) => {
      if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.send(data);
    });
    upstreamWs.on('message', (data) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
    });
  });

  upstreamWs.on('error', (err) => {
    try { clientWs.close(1011, `Upstream error: ${err.message}`.slice(0, 123)); } catch {}
  });

  upstreamWs.on('close', (code, reason) => {
    const safeCode = (code >= 3000 && code <= 4999) || code === 1000 ? code : 1000;
    try { clientWs.close(safeCode, reason?.toString().slice(0, 123)); } catch {}
  });

  clientWs.on('close', () => {
    try { if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.close(); } catch {}
  });

  clientWs.on('error', () => {
    try { if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.close(); } catch {}
  });
});

// ── Heartbeat to control plane ───────────────────────────────
async function sendHeartbeat() {
  try {
    await fetch(`${CONTROL_PLANE_HOST}/api/workers/${PROJECT_NAME}/heartbeat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WORKER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        containerRunning: isContainerRunning(),
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.error(`Heartbeat failed: ${err.message}`);
  }
}

// Send heartbeat every 60 seconds
setInterval(sendHeartbeat, 60_000);
// Initial heartbeat after 10s (give time for network)
setTimeout(sendHeartbeat, 10_000);

// ── Start server ─────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Worker agent listening on :${PORT}`);
  console.log(`Project: ${PROJECT_NAME}`);
});
