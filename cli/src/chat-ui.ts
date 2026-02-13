import { createInterface, Interface } from 'readline';
import type { StreamDelta } from './types.js';

export class ChatUI {
  private rl: Interface;
  private streaming = false;
  private currentLine = '';
  private onMessage: (text: string) => void;
  private onExit: () => void;

  constructor(opts: { onMessage: (text: string) => void; onExit: () => void }) {
    this.onMessage = opts.onMessage;
    this.onExit = opts.onExit;

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    this.rl.on('close', () => {
      this.onExit();
    });

    this.rl.on('line', (line) => {
      const text = line.trim();
      if (!text) {
        this.prompt();
        return;
      }
      if (text === '/quit' || text === '/exit') {
        this.onExit();
        return;
      }
      this.onMessage(text);
    });
  }

  prompt(): void {
    if (!this.streaming) {
      this.rl.setPrompt('> ');
      this.rl.prompt();
    }
  }

  handleDelta(delta: StreamDelta): void {
    switch (delta.type) {
      case 'text_delta':
        if (!this.streaming) {
          this.streaming = true;
          process.stdout.write('\n');
        }
        process.stdout.write(delta.text || '');
        this.currentLine += delta.text || '';
        break;

      case 'tool_use':
        if (!this.streaming) {
          this.streaming = true;
          process.stdout.write('\n');
        }
        process.stdout.write(`\x1b[90m[${delta.tool}]\x1b[0m ${delta.input || ''}\n`);
        break;

      case 'tool_result':
        if (delta.output) {
          const lines = delta.output.split('\n');
          const display = lines.length > 10 ? [...lines.slice(0, 10), `... (${lines.length - 10} more lines)`].join('\n') : delta.output;
          process.stdout.write(`\x1b[90m${display}\x1b[0m\n`);
        }
        break;

      case 'error':
        process.stdout.write(`\x1b[31mError: ${delta.error}\x1b[0m\n`);
        this.endStream();
        break;

      case 'done':
        this.endStream();
        break;
    }
  }

  private endStream(): void {
    if (this.streaming) {
      process.stdout.write('\n\n');
      this.streaming = false;
      this.currentLine = '';
    }
    this.prompt();
  }

  showStatus(text: string): void {
    process.stdout.write(`\x1b[90m${text}\x1b[0m\n`);
  }

  destroy(): void {
    this.rl.close();
  }
}
