import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { requireAuth, authenticateWsToken } from './routes/auth.js';
import { projectsRouter } from './routes/projects.js';
import { statusRouter } from './routes/status.js';
import { handleUpgrade } from './services/openclaw-proxy.js';
import { getDb } from './db/index.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

// Health check (no auth)
app.get('/health', (_req, res) => res.json({ ok: true }));

// All API routes require auth
app.use('/api', requireAuth);
app.use('/api/projects', projectsRouter);
app.use('/api/status', statusRouter);

const server = http.createServer(app);

// WebSocket server for chat relay
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);

  // Authenticate via query param
  const token = url.searchParams.get('token');
  if (!token || !authenticateWsToken(token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  handleUpgrade(wss, req, socket, head);
});

const PORT = process.env.PORT || 4000;

// Initialize database on startup
getDb();

server.listen(PORT, () => {
  console.log(`Control plane listening on :${PORT}`);
});
