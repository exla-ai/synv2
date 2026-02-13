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
  private supervisorConnected = false;
  private agentBusy = false;

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

      case 'history':
        // Replay buffered events from gateway as dimmed text
        if (delta.events && delta.events.length > 0) {
          process.stdout.write(`${c.dim}── recent activity ──${c.reset}\n`);
          for (const event of delta.events) {
            this.renderHistoryEvent(event);
          }
          process.stdout.write(`${c.dim}── live ──${c.reset}\n\n`);
        }
        break;

      case 'status':
        this.supervisorConnected = delta.supervisorConnected || false;
        this.agentBusy = delta.agentBusy || false;
        break;

      case 'client_change':
        if (delta.supervisorConnected !== undefined) {
          this.supervisorConnected = delta.supervisorConnected;
        }
        break;
    }
  }

  private renderHistoryEvent(event: StreamDelta): void {
    switch (event.type) {
      case 'text_delta':
        process.stdout.write(`${c.dim}${event.text || ''}${c.reset}`);
        break;
      case 'tool_start':
        process.stdout.write(`\n${c.dim}  [${event.tool}]${c.reset}`);
        break;
      case 'tool_use': {
        const icon = TOOL_ICONS[event.tool || ''] || '>';
        if (event.input) {
          let display = '';
          try {
            const parsed = JSON.parse(event.input);
            if (event.tool === 'bash' && parsed.command) display = parsed.command;
            else if (parsed.path) display = parsed.path;
            else display = event.input;
          } catch { display = event.input; }
          process.stdout.write(`${c.dim}  ${icon} ${display}${c.reset}\n`);
        }
        break;
      }
      case 'tool_result':
        if (event.output) {
          const lines = event.output.split('\n');
          const maxLines = 5;
          const display = lines.length > maxLines
            ? [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more)`]
            : lines;
          process.stdout.write(`${c.dim}${display.map(l => `  ${l}`).join('\n')}${c.reset}\n`);
        }
        break;
      case 'done':
        process.stdout.write(`${c.dim}\n---${c.reset}\n`);
        break;
      default:
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
    const supervisorStatus = this.supervisorConnected
      ? `${c.green}active${c.reset}${c.dim} (paused while you're attached)${c.reset}`
      : `${c.dim}not connected${c.reset}`;
    process.stdout.write(`${c.dim}  Supervisor: ${supervisorStatus}\n`);
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
