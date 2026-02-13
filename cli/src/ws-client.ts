import WebSocket from 'ws';
import type { StreamDelta } from './types.js';

export type WSEventHandler = {
  onDelta: (delta: StreamDelta) => void;
  onOpen: () => void;
  onClose: (code: number, reason: string) => void;
  onError: (err: Error) => void;
};

export class WSClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: WSEventHandler;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(url: string, handlers: WSEventHandler) {
    this.url = url;
    this.handlers = handlers;
  }

  connect(): void {
    this.ws = new WebSocket(this.url, {
      headers: {},
      rejectUnauthorized: false,
    });

    this.ws.on('open', () => {
      this.handlers.onOpen();
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handlers.onDelta(msg as StreamDelta);
      } catch {
        // ignore malformed messages
      }
    });

    this.ws.on('close', (code, reason) => {
      this.handlers.onClose(code, reason.toString());
    });

    this.ws.on('error', (err) => {
      this.handlers.onError(err);
    });
  }

  send(message: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  sendMessage(text: string): void {
    this.send({ type: 'user_message', content: text });
  }

  identify(role: 'human' | 'supervisor'): void {
    this.send({ type: 'identify', role });
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'client disconnect');
      this.ws = null;
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
