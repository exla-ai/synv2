// Supervisor — keeps the OpenClaw agent working continuously
// Each turn uses a FRESH OpenClaw session (gateway generates unique session keys)
// so the agent never runs out of context. Memory files provide continuity.

const { WebSocket } = require('ws');
const fs = require('fs');

const BRIDGE_PORT = parseInt(process.env.GATEWAY_PORT || '18789');
const PROJECT_NAME = process.env.PROJECT_NAME || 'project';
const LOG_FILE = '/tmp/supervisor.log';

const TURN_TIMEOUT_MS = 15 * 60 * 1000;   // 15 min max per turn
const MIN_DELAY_MS = 15_000;               // 15s between turns normally
const BACKOFF_DELAY_MS = 120_000;          // 2 min after empty/error turns
const MAX_BACKOFF_MS = 600_000;            // 10 min max backoff
const EMPTY_THRESHOLD = 3;                 // after 3 consecutive empty turns, back off

let turnCount = 0;
let consecutiveEmpty = 0;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function readFile(path) {
  try { return fs.readFileSync(path, 'utf-8'); } catch { return null; }
}

function getSystemContext() {
  const shortMem = readFile('/workspace/SHORT_TERM_MEMORY.md') || '(no short-term memory file found)';
  const longMem = readFile('/workspace/LONG_TERM_MEMORY.md') || '(no long-term memory file found)';
  const plan = readFile('/workspace/plan.md') || '(no plan.md found)';

  // Check what's running
  let processInfo = '';
  try {
    const { execSync } = require('child_process');
    const tmux = execSync('tmux ls 2>/dev/null || echo "no tmux sessions"', { timeout: 5000 }).toString().trim();
    const procs = execSync('ps aux 2>/dev/null | grep -E "python|paq|cmix|zpaq|compress|train" | grep -v grep | head -10 || echo "no matching processes"', { timeout: 5000 }).toString().trim();
    processInfo = `\n## Currently Running Processes\n\`\`\`\n${tmux}\n\n${procs}\n\`\`\``;
  } catch {}

  // Check compression output if it exists
  let compressionStatus = '';
  try {
    const { execSync } = require('child_process');
    const files = execSync('find /workspace -name "*.paq8px*" -o -name "*.compressed" -o -name "*.archive" 2>/dev/null | head -5', { timeout: 5000 }).toString().trim();
    if (files) {
      const sizes = execSync(`ls -la ${files.split('\n').join(' ')} 2>/dev/null`, { timeout: 5000 }).toString().trim();
      compressionStatus = `\n## Compression Output Files\n\`\`\`\n${sizes}\n\`\`\``;
    }
  } catch {}

  return { shortMem, longMem, plan, processInfo, compressionStatus };
}

function buildPrompt() {
  const ctx = getSystemContext();

  return `You are an autonomous AI agent working on the Hutter Prize compression challenge.
Your workspace is /workspace. You have passwordless sudo. You have uv, clang, gcc, cmake, tmux, Python 3.

THIS IS A FRESH SESSION — you have no memory of previous turns. Your memory files are your continuity:

## Your Short-Term Memory
${ctx.shortMem}

## Your Long-Term Memory
${ctx.longMem}
${ctx.processInfo}
${ctx.compressionStatus}

## The Plan (plan.md)
${ctx.plan}

## INSTRUCTIONS

1. Read your memory files above carefully — they contain your progress and decisions.
2. Check what's currently running (tmux ls, ps aux). Do NOT restart processes that are already working.
3. Identify the highest-priority task that isn't already running.
4. Execute it. Parallelize where possible using tmux sessions and background jobs.
5. BEFORE YOUR TURN ENDS: Update /workspace/SHORT_TERM_MEMORY.md and /workspace/LONG_TERM_MEMORY.md with what you did and learned.

## GOAL
Compress enwik9 below 109,685,197 bytes (1% better than the SOTA of 110,793,128 bytes).
Current SOTA holder: fx2-cmix (Kaido Orav & Byron Knoll, Sept 2024).

## KEY RULES
- Use sudo freely: \`sudo apt-get install -y <pkg>\`
- Use tmux for long tasks: \`tmux new-session -d -s <name> '<command>'\`
- ALWAYS update memory files before finishing
- If compression is running and nothing else to do, work on optimizing the pipeline, testing alternatives, or improving preprocessing
- Git commit progress regularly

Go.`;
}

function runTurn() {
  return new Promise((resolve) => {
    turnCount++;
    log(`=== Turn ${turnCount} ===`);

    const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`);
    let done = false;
    let msgCount = 0;
    let textChars = 0;
    let toolCount = 0;

    const timeout = setTimeout(() => {
      if (!done) {
        log(`Turn ${turnCount} timed out after ${TURN_TIMEOUT_MS / 1000}s (${msgCount} msgs, ${textChars} chars, ${toolCount} tools)`);
        done = true;
        consecutiveEmpty = 0; // timeout means it was working
        try { ws.close(); } catch {}
        resolve('timeout');
      }
    }, TURN_TIMEOUT_MS);

    ws.on('open', () => {
      const prompt = buildPrompt();
      log(`Sending prompt (${prompt.length} chars)`);
      ws.send(JSON.stringify({ type: 'user_message', content: prompt }));
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      msgCount++;

      if (msg.type === 'text_delta') textChars += (msg.text || '').length;
      if (msg.type === 'tool_start') toolCount++;

      if (msg.type === 'done') {
        const wasEmpty = textChars === 0 && toolCount === 0;
        log(`Turn ${turnCount} done: ${msgCount} msgs, ${textChars} chars, ${toolCount} tools${wasEmpty ? ' (EMPTY)' : ''}`);
        done = true;
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        resolve(wasEmpty ? 'empty' : 'ok');
      }
      if (msg.type === 'error') {
        log(`Turn ${turnCount} error: ${msg.error}`);
        done = true;
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        resolve('error');
      }
    });

    ws.on('error', (err) => {
      log(`WS error: ${err.message}`);
      if (!done) {
        done = true;
        clearTimeout(timeout);
        resolve('ws_error');
      }
    });

    ws.on('close', () => {
      if (!done) {
        done = true;
        clearTimeout(timeout);
        resolve('closed');
      }
    });
  });
}

async function waitForBridge() {
  log('Waiting for bridge gateway...');
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`);
      if (res.ok) {
        log('Bridge gateway ready');
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Bridge gateway never became ready');
}

async function main() {
  log(`Supervisor starting for project: ${PROJECT_NAME}`);
  log(`Turn timeout: ${TURN_TIMEOUT_MS / 1000}s`);

  await waitForBridge();

  // Main loop — runs forever
  while (true) {
    let result;
    try {
      result = await runTurn();
    } catch (err) {
      log(`Turn crashed: ${err.message}`);
      result = 'crash';
    }

    // Decide delay based on result
    let delay;
    if (result === 'ok' || result === 'timeout') {
      consecutiveEmpty = 0;
      delay = MIN_DELAY_MS;
    } else {
      consecutiveEmpty++;
      if (consecutiveEmpty >= EMPTY_THRESHOLD) {
        // Exponential backoff: 2min, 4min, 8min, max 10min
        delay = Math.min(BACKOFF_DELAY_MS * Math.pow(2, consecutiveEmpty - EMPTY_THRESHOLD), MAX_BACKOFF_MS);
        log(`${consecutiveEmpty} consecutive empty turns — backing off ${delay / 1000}s`);
      } else {
        delay = BACKOFF_DELAY_MS;
      }
    }

    log(`Next turn in ${delay / 1000}s (result: ${result}, consecutiveEmpty: ${consecutiveEmpty})`);
    await new Promise(r => setTimeout(r, delay));
  }
}

// Handle uncaught errors — restart instead of dying
process.on('uncaughtException', (err) => {
  log(`UNCAUGHT ERROR: ${err.message} — restarting in 30s`);
  setTimeout(() => main().catch(e => log(`FATAL: ${e.message}`)), 30000);
});

process.on('unhandledRejection', (err) => {
  log(`UNHANDLED REJECTION: ${err} — continuing`);
});

main().catch(err => {
  log(`Supervisor fatal error: ${err.message} — restarting in 30s`);
  setTimeout(() => main().catch(e => log(`FATAL: ${e.message}`)), 30000);
});
