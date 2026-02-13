import WebSocket, { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import { getGatewayUrl } from './container-manager.js';

export function handleUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: Socket, head: Buffer): void {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const match = url.pathname.match(/^\/ws\/projects\/([^/]+)\/chat$/);
  if (!match) {
    socket.destroy();
    return;
  }

  const projectName = decodeURIComponent(match[1]);

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    relay(clientWs, projectName);
  });
}

async function relay(clientWs: WebSocket, projectName: string): Promise<void> {
  const gatewayUrl = await getGatewayUrl(projectName);
  if (!gatewayUrl) {
    clientWs.close(4004, `Project "${projectName}" gateway not available`);
    return;
  }

  const upstreamWs = new WebSocket(gatewayUrl);

  upstreamWs.on('open', () => {
    // Relay: client → upstream
    clientWs.on('message', (data) => {
      if (upstreamWs.readyState === WebSocket.OPEN) {
        upstreamWs.send(data);
      }
    });

    // Relay: upstream → client
    upstreamWs.on('message', (data) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data);
      }
    });
  });

  upstreamWs.on('error', (err) => {
    clientWs.close(4500, `Upstream error: ${err.message}`);
  });

  upstreamWs.on('close', (code, reason) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(code, reason.toString());
    }
  });

  clientWs.on('close', () => {
    if (upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.close();
    }
  });

  clientWs.on('error', () => {
    if (upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.close();
    }
  });
}
