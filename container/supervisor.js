// Supervisor — keeps the OpenClaw agent working continuously
// Connects via WS, sends prompts, waits for completion, re-prompts
// Runs inside the container alongside the bridge gateway

const { WebSocket } = require('ws');
const fs = require('fs');

const BRIDGE_PORT = parseInt(process.env.GATEWAY_PORT || '18789');
const PROJECT_NAME = process.env.PROJECT_NAME || 'project';
const LOOP_DELAY_MS = 10_000; // 10s between turns
const TURN_TIMEOUT_MS = 15 * 60 * 1000; // 15 min max per turn
const LOG_FILE = '/tmp/supervisor.log';

let turnCount = 0;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function getInitialPrompt() {
  // Read plan.md if it exists
  let planContent = '';
  try {
    planContent = fs.readFileSync('/workspace/plan.md', 'utf-8');
  } catch {
    planContent = '(plan.md not found — check /workspace)';
  }

  return `You are an autonomous AI agent working on the Hutter Prize compression challenge. Your workspace is /workspace.

**READ plan.md FIRST** — it is your master plan. Here it is for reference:

<plan>
${planContent}
</plan>

**YOUR MISSION**: Execute plan.md to build a compression system that beats the Hutter Prize record. Compress enwik9 (1GB Wikipedia XML) below 109,685,197 bytes.

**CRITICAL RULES**:

1. **ALWAYS PARALLELIZE**: Use tmux sessions, background jobs (&), parallel make, etc. Never block on one task when you could be doing multiple. Example: \`tmux new-session -d -s train 'python train.py' && tmux new-session -d -s preprocess 'python preprocess.py'\`

2. **NEVER IDLE**: There should ALWAYS be at least one background process running. Before ending your turn, start a long-running task in tmux/background.

3. **USE SUDO FREELY**: You have passwordless sudo. \`sudo apt-get install -y <pkg>\` works. Install anything you need.

4. **MEMORY FILES**: Create and update /workspace/LONG_TERM_MEMORY.md (architecture decisions, results, learnings) and /workspace/SHORT_TERM_MEMORY.md (current task, active experiments, next steps). Read them at the start of every turn to remember context.

5. **MEASURE EVERYTHING**: Always benchmark. Track compression ratio, speed, memory. Log results to memory files.

6. **GIT COMMIT REGULARLY**: Commit meaningful progress. Push milestones.

7. **TOOLS AVAILABLE**: git, Python 3, pip, uv, clang, gcc, cmake, tmux, curl, wget, Modal (GPU compute), sudo, build-essential. Full Linux environment.

**START NOW**: Read your memory files, check what's running (tmux ls, ps aux), pick up where you left off or start fresh from the plan. Be aggressive. Go.`;
}

function getContinuePrompt() {
  return `Continue working on the Hutter Prize challenge.

**FIRST**: Read /workspace/SHORT_TERM_MEMORY.md and /workspace/LONG_TERM_MEMORY.md to remember where you left off.

**THEN**: Check what's running: \`tmux ls\`, \`ps aux | grep -v grep | grep python\`

**THEN**: Pick up the next task from plan.md. Parallelize. Keep background processes running.

**REMEMBER**:
- You have sudo access — install anything with \`sudo apt-get install -y\`
- Use tmux for long-running tasks so they survive between turns
- Update your memory files before ending your turn
- Commit progress to git regularly
- Target: compress enwik9 below 109,685,197 bytes

Have you beaten the benchmark yet? If not, what's the current best compression ratio and what's your next optimization? Go.`;
}

function getCheckInPrompt() {
  return `Status check. Read /workspace/SHORT_TERM_MEMORY.md.

1. What's your current best compression result on enwik8 and/or enwik9?
2. What background processes are running? (\`tmux ls\` and \`ps aux | grep python\`)
3. What's blocking progress?
4. What are you working on next?

If nothing is running, START SOMETHING. There should always be a process running — training, benchmarking, or building. Use tmux for long tasks. Update your memory files. Go.`;
}

function runTurn() {
  return new Promise((resolve) => {
    turnCount++;
    const isFirst = turnCount === 1;
    const isCheckIn = turnCount % 5 === 0; // Every 5th turn is a check-in

    const prompt = isFirst ? getInitialPrompt() :
                   isCheckIn ? getCheckInPrompt() :
                   getContinuePrompt();

    log(`=== Turn ${turnCount} (${isFirst ? 'initial' : isCheckIn ? 'check-in' : 'continue'}) ===`);

    const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`);
    let done = false;
    let msgCount = 0;
    let textChars = 0;
    let tools = [];

    const timeout = setTimeout(() => {
      if (!done) {
        log(`Turn ${turnCount} timed out after ${TURN_TIMEOUT_MS / 1000}s (${msgCount} msgs, ${textChars} chars, tools: ${tools.join(',')})`);
        done = true;
        try { ws.close(); } catch {}
        resolve();
      }
    }, TURN_TIMEOUT_MS);

    ws.on('open', () => {
      log(`Connected, sending prompt (${prompt.length} chars)`);
      ws.send(JSON.stringify({ type: 'user_message', content: prompt }));
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      msgCount++;

      if (msg.type === 'tool_start' && msg.tool) {
        tools.push(msg.tool);
      }
      if (msg.type === 'text_delta') {
        textChars += (msg.text || '').length;
      }

      if (msg.type === 'done') {
        log(`Turn ${turnCount} complete: ${msgCount} msgs, ${textChars} text chars, ${tools.length} tool calls [${tools.slice(0, 10).join(',')}${tools.length > 10 ? '...' : ''}]`);
        done = true;
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        resolve();
      }
      if (msg.type === 'error') {
        log(`Turn ${turnCount} error: ${msg.error}`);
        done = true;
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        resolve();
      }
    });

    ws.on('error', (err) => {
      log(`WS error: ${err.message}`);
      if (!done) {
        done = true;
        clearTimeout(timeout);
        resolve();
      }
    });

    ws.on('close', () => {
      if (!done) {
        done = true;
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

async function main() {
  log(`Supervisor starting for project: ${PROJECT_NAME}`);
  log(`Bridge gateway: ws://127.0.0.1:${BRIDGE_PORT}`);
  log(`Turn timeout: ${TURN_TIMEOUT_MS / 1000}s, delay between turns: ${LOOP_DELAY_MS / 1000}s`);

  // Wait for bridge gateway to be ready
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`);
      if (res.ok) {
        log('Bridge gateway is ready');
        break;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }

  // Main loop — run forever
  while (true) {
    try {
      await runTurn();
    } catch (err) {
      log(`Turn error: ${err.message}`);
    }

    log(`Waiting ${LOOP_DELAY_MS / 1000}s before next turn...`);
    await new Promise(r => setTimeout(r, LOOP_DELAY_MS));
  }
}

main().catch(err => {
  log(`Supervisor fatal error: ${err.message}`);
  process.exit(1);
});
