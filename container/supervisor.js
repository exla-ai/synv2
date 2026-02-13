// Supervisor — keeps the OpenClaw agent working continuously via a persistent
// gateway connection. Pauses when humans are attached, resumes when they leave.

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
const HUMAN_RESUME_DELAY_MS = 10_000;      // 10s after last human disconnects before resuming

// ── State machine ───────────────────────────────────────────────
// INIT → PROMPTING → WAITING → DELAY → PROMPTING...
// PAUSED (when humans attached) — resumes to DELAY when they leave
const STATE = {
  INIT: 'INIT',
  PROMPTING: 'PROMPTING',
  WAITING: 'WAITING',
  DELAY: 'DELAY',
  PAUSED: 'PAUSED',
};

let state = STATE.INIT;
let turnCount = 0;
let consecutiveEmpty = 0;
let humanCount = 0;
let agentBusy = false;
let ws = null;
let connected = false;
let turnTimer = null;
let delayTimer = null;
let resumeTimer = null;
let turnTextChars = 0;
let turnToolCount = 0;
let turnMsgCount = 0;
let firstPromptSent = false;

function log(msg) {
  const line = `[${new Date().toISOString()}] [${state}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function readFile(path) {
  try { return fs.readFileSync(path, 'utf-8'); } catch { return null; }
}

function setState(newState) {
  const old = state;
  state = newState;
  if (old !== newState) log(`State: ${old} → ${newState}`);
}

// ── Prompt builders ─────────────────────────────────────────────
function getSystemContext() {
  const shortMem = readFile('/workspace/SHORT_TERM_MEMORY.md') || '(no short-term memory file found)';
  const longMem = readFile('/workspace/LONG_TERM_MEMORY.md') || '(no long-term memory file found)';
  const plan = readFile('/workspace/plan.md') || '(no plan.md found)';

  let processInfo = '';
  try {
    const { execSync } = require('child_process');
    const tmux = execSync('tmux ls 2>/dev/null || echo "no tmux sessions"', { timeout: 5000 }).toString().trim();
    const procs = execSync('ps aux 2>/dev/null | grep -E "python|paq|cmix|zpaq|compress|train" | grep -v grep | head -10 || echo "no matching processes"', { timeout: 5000 }).toString().trim();
    processInfo = `\n## Currently Running Processes\n\`\`\`\n${tmux}\n\n${procs}\n\`\`\``;
  } catch {}

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

function buildFullPrompt() {
  const ctx = getSystemContext();

  return `You are an autonomous AI agent working on the Hutter Prize compression challenge.
Your workspace is /workspace. You have passwordless sudo. You have uv, clang, gcc, cmake, tmux, Python 3.

This is a PERSISTENT SESSION — you share this session with a supervisor that sends you prompts.
Your memory files provide continuity across context compaction:

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

function buildContinuationPrompt() {
  const ctx = getSystemContext();

  return `Continue working on your task. Here is your current memory state:

## Short-Term Memory
${ctx.shortMem}

## Long-Term Memory
${ctx.longMem}
${ctx.processInfo}
${ctx.compressionStatus}

Check running processes, pick up where you left off, and keep making progress.
Update your memory files before your turn ends.`;
}

// ── Turn management ─────────────────────────────────────────────
function sendPrompt() {
  if (!connected || agentBusy) {
    log(`Cannot send prompt: connected=${connected}, agentBusy=${agentBusy}`);
    scheduleTurnDelay(MIN_DELAY_MS);
    return;
  }

  turnCount++;
  turnTextChars = 0;
  turnToolCount = 0;
  turnMsgCount = 0;

  const prompt = firstPromptSent ? buildContinuationPrompt() : buildFullPrompt();
  firstPromptSent = true;

  log(`=== Turn ${turnCount} === Sending prompt (${prompt.length} chars)`);
  setState(STATE.PROMPTING);

  ws.send(JSON.stringify({ type: 'user_message', content: prompt }));
  setState(STATE.WAITING);

  // Turn timeout
  turnTimer = setTimeout(() => {
    log(`Turn ${turnCount} timed out after ${TURN_TIMEOUT_MS / 1000}s (${turnMsgCount} msgs, ${turnTextChars} chars, ${turnToolCount} tools)`);
    consecutiveEmpty = 0; // timeout means it was working
    onTurnEnd('timeout');
  }, TURN_TIMEOUT_MS);
}

function onTurnEnd(result) {
  if (turnTimer) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }

  let delay;
  if (result === 'ok' || result === 'timeout') {
    consecutiveEmpty = 0;
    delay = MIN_DELAY_MS;
  } else {
    consecutiveEmpty++;
    if (consecutiveEmpty >= EMPTY_THRESHOLD) {
      delay = Math.min(BACKOFF_DELAY_MS * Math.pow(2, consecutiveEmpty - EMPTY_THRESHOLD), MAX_BACKOFF_MS);
      log(`${consecutiveEmpty} consecutive empty turns — backing off ${delay / 1000}s`);
    } else {
      delay = BACKOFF_DELAY_MS;
    }
  }

  log(`Turn ${turnCount} result: ${result} (${turnMsgCount} msgs, ${turnTextChars} chars, ${turnToolCount} tools) — next in ${delay / 1000}s`);

  // If humans are attached, go to PAUSED instead of scheduling next turn
  if (humanCount > 0) {
    setState(STATE.PAUSED);
    log(`Humans attached (${humanCount}) — pausing autonomous prompts`);
  } else {
    scheduleTurnDelay(delay);
  }
}

function scheduleTurnDelay(delay) {
  setState(STATE.DELAY);
  delayTimer = setTimeout(() => {
    delayTimer = null;
    if (humanCount > 0) {
      setState(STATE.PAUSED);
      log(`Humans attached — pausing`);
    } else {
      sendPrompt();
    }
  }, delay);
}

// ── Human presence management ───────────────────────────────────
function onHumanCountChange(newCount) {
  const oldCount = humanCount;
  humanCount = newCount;

  if (newCount > 0 && oldCount === 0) {
    // Humans just connected — pause if in DELAY
    log(`Human(s) connected (${newCount}) — will pause after current turn`);
    if (state === STATE.DELAY && delayTimer) {
      clearTimeout(delayTimer);
      delayTimer = null;
      setState(STATE.PAUSED);
    }
  } else if (newCount === 0 && oldCount > 0) {
    // All humans left — resume after delay
    log(`All humans disconnected — resuming in ${HUMAN_RESUME_DELAY_MS / 1000}s`);
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      if (humanCount === 0 && state === STATE.PAUSED) {
        log('Resuming autonomous prompts');
        if (agentBusy) {
          // Agent is mid-turn from a human message, wait for it
          setState(STATE.WAITING);
        } else {
          sendPrompt();
        }
      }
    }, HUMAN_RESUME_DELAY_MS);
  }
}

// ── WebSocket connection to gateway ─────────────────────────────
function connectToGateway() {
  log('Connecting to gateway...');
  ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`);

  ws.on('open', () => {
    connected = true;
    log('Connected to gateway');
    // Identify as supervisor
    ws.send(JSON.stringify({ type: 'identify', role: 'supervisor' }));
  });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // Status update from gateway
    if (msg.type === 'status') {
      agentBusy = msg.agentBusy || false;
      humanCount = msg.humanCount || 0;
      log(`Status: agentBusy=${agentBusy}, humans=${humanCount}, ocConnected=${msg.ocConnected}`);

      // Start the first prompt if agent isn't busy and no humans
      if (state === STATE.INIT && !agentBusy && humanCount === 0 && msg.ocConnected) {
        sendPrompt();
      } else if (state === STATE.INIT && (agentBusy || humanCount > 0)) {
        setState(STATE.PAUSED);
        log('Agent busy or humans present at startup — waiting');
      } else if (state === STATE.INIT && !msg.ocConnected) {
        log('OpenClaw not yet connected — waiting for status update');
      }
    }

    // Client change — human connect/disconnect
    else if (msg.type === 'client_change') {
      onHumanCountChange(msg.humans || 0);
    }

    // History — ignore (we don't need replay as supervisor)
    else if (msg.type === 'history') {
      // noop
    }

    // Agent stream events — track for turn metrics
    else if (msg.type === 'text_delta') {
      turnTextChars += (msg.text || '').length;
      turnMsgCount++;
    }
    else if (msg.type === 'tool_start') {
      turnToolCount++;
      turnMsgCount++;
    }
    else if (msg.type === 'tool_use' || msg.type === 'tool_result') {
      turnMsgCount++;
    }

    // Turn end signals
    else if (msg.type === 'done') {
      turnMsgCount++;
      if (state === STATE.WAITING) {
        const wasEmpty = turnTextChars === 0 && turnToolCount === 0;
        onTurnEnd(wasEmpty ? 'empty' : 'ok');
      } else if (state === STATE.PAUSED) {
        // Done came from a human's message — agent finished, stay paused
        agentBusy = false;
        log('Agent finished (human-initiated turn) — staying paused');
      }
    }
    else if (msg.type === 'error') {
      turnMsgCount++;
      if (state === STATE.WAITING) {
        onTurnEnd('error');
      } else {
        agentBusy = false;
      }
    }
  });

  ws.on('error', (err) => {
    log(`Gateway WS error: ${err.message}`);
  });

  ws.on('close', () => {
    connected = false;
    agentBusy = false;
    log('Gateway connection lost — reconnecting in 5s');
    if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
    if (delayTimer) { clearTimeout(delayTimer); delayTimer = null; }
    setState(STATE.INIT);
    setTimeout(connectToGateway, 5000);
  });
}

// ── Wait for gateway to be ready ────────────────────────────────
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

// ── Main ────────────────────────────────────────────────────────
async function main() {
  log(`Supervisor starting for project: ${PROJECT_NAME}`);
  log(`Turn timeout: ${TURN_TIMEOUT_MS / 1000}s`);

  await waitForBridge();
  connectToGateway();
}

// Handle uncaught errors — restart instead of dying
process.on('uncaughtException', (err) => {
  log(`UNCAUGHT ERROR: ${err.message} — restarting in 30s`);
  try { if (ws) ws.close(); } catch {}
  setTimeout(() => main().catch(e => log(`FATAL: ${e.message}`)), 30000);
});

process.on('unhandledRejection', (err) => {
  log(`UNHANDLED REJECTION: ${err} — continuing`);
});

main().catch(err => {
  log(`Supervisor fatal error: ${err.message} — restarting in 30s`);
  setTimeout(() => main().catch(e => log(`FATAL: ${e.message}`)), 30000);
});
