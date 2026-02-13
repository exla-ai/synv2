import { createInterface, Interface } from 'readline';
import type { StreamDelta } from './types.js';

// ANSI color helpers
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
  bgGray: '\x1b[48;5;236m',
};

const TOOL_ICONS: Record<string, string> = {
  bash: '$',
  read_file: 'R',
  write_file: 'W',
  edit_file: 'E',
  list_files: 'L',
};

export class ChatUI {
  private rl: Interface;
  private streaming = false;
  private onMessage: (text: string) => void;
  private onExit: () => void;
  private projectName: string;
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private currentTool = '';

  constructor(opts: { onMessage: (text: string) => void; onExit: () => void; projectName?: string }) {
    this.onMessage = opts.onMessage;
    this.onExit = opts.onExit;
    this.projectName = opts.projectName || 'project';

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
      this.streaming = true;
      this.onMessage(text);
    });
  }

  prompt(): void {
    if (!this.streaming) {
      this.rl.setPrompt(`${c.cyan}${c.bold}> ${c.reset}`);
      this.rl.prompt();
    }
  }

  private startSpinner(label: string): void {
    this.stopSpinner();
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    this.spinnerFrame = 0;
    this.spinnerInterval = setInterval(() => {
      const frame = frames[this.spinnerFrame % frames.length];
      process.stdout.write(`\r${c.yellow}${frame}${c.reset} ${c.dim}${label}${c.reset}\x1b[K`);
      this.spinnerFrame++;
    }, 80);
  }

  private stopSpinner(): void {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
      process.stdout.write('\r\x1b[K');
    }
  }

  handleDelta(delta: StreamDelta): void {
    switch (delta.type) {
      case 'text_delta':
        this.stopSpinner();
        if (!this.streaming) {
          this.streaming = true;
        }
        process.stdout.write(delta.text || '');
        break;

      case 'tool_start':
        this.stopSpinner();
        this.currentTool = delta.tool || '';
        this.startSpinner(`Running ${delta.tool}...`);
        break;

      case 'tool_use': {
        this.stopSpinner();
        const icon = TOOL_ICONS[delta.tool || ''] || '>';
        if (delta.input) {
          let display = '';
          try {
            const parsed = JSON.parse(delta.input);
            if (delta.tool === 'bash' && parsed.command) {
              display = parsed.command;
            } else if (delta.tool === 'read_file' && parsed.path) {
              display = parsed.path;
            } else if (delta.tool === 'write_file' && parsed.path) {
              display = parsed.path;
            } else if (delta.tool === 'edit_file' && parsed.path) {
              display = parsed.path;
            } else if (delta.tool === 'list_files' && parsed.path) {
              display = parsed.path + (parsed.recursive ? ' (recursive)' : '');
            } else {
              display = delta.input;
            }
          } catch {
            display = delta.input;
          }
          process.stdout.write(`\n  ${c.yellow}${icon}${c.reset} ${c.dim}${display}${c.reset}\n`);
        }
        break;
      }

      case 'tool_result':
        this.stopSpinner();
        if (delta.output) {
          const lines = delta.output.split('\n');
          const maxLines = 15;
          const display = lines.length > maxLines
            ? [...lines.slice(0, maxLines), `${c.dim}... (${lines.length - maxLines} more lines)${c.reset}`]
            : lines;
          const indented = display.map(l => `  ${c.gray}${l}${c.reset}`).join('\n');
          process.stdout.write(`${indented}\n`);
        }
        break;

      case 'error':
        this.stopSpinner();
        process.stdout.write(`\n${c.red}Error: ${delta.error}${c.reset}\n`);
        this.endStream();
        break;

      case 'done':
        this.stopSpinner();
        this.endStream();
        break;
    }
  }

  private endStream(): void {
    if (this.streaming) {
      process.stdout.write('\n\n');
      this.streaming = false;
    }
    this.prompt();
  }

  showBanner(): void {
    process.stdout.write(`\n${c.cyan}${c.bold}  synv2${c.reset} ${c.dim}— ${this.projectName}${c.reset}\n`);
    process.stdout.write(`${c.dim}  Type /quit to disconnect\n${c.reset}\n`);
  }

  showStatus(text: string): void {
    process.stdout.write(`${c.dim}${text}${c.reset}\n`);
  }

  destroy(): void {
    this.stopSpinner();
    this.rl.close();
  }
}
