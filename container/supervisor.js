// Supervisor — keeps the OpenClaw agent working continuously via a persistent
// gateway connection. Pauses when humans are attached, resumes when they leave.
// Reads task config from /workspace/.task.json for goal-aware prompts and auto-stop.
// No .task.json = backward-compatible forever-running mode with generic prompts.

const { WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BRIDGE_PORT = parseInt(process.env.GATEWAY_PORT || '18789');
const PROJECT_NAME = process.env.PROJECT_NAME || 'project';
const LOG_FILE = '/tmp/supervisor.log';
const TASK_FILE = '/workspace/.task.json';
const ARCHIVE_DIR = '/workspace/.task-archive';

const TURN_TIMEOUT_MS = 15 * 60 * 1000;   // 15 min max per turn
const MIN_DELAY_MS = 15_000;               // 15s after productive turns
const IDLE_DELAY_MS = 300_000;             // 5 min when agent is idle
const MAX_IDLE_DELAY_MS = 600_000;         // 10 min max idle delay
const BACKOFF_DELAY_MS = 120_000;          // 2 min after empty/error turns
const MAX_BACKOFF_MS = 600_000;            // 10 min max backoff
const EMPTY_THRESHOLD = 3;                 // after 3 consecutive empty turns, back off
const RECOVERY_FULL_THRESHOLD = 5;         // after 5 empty turns, resend full prompt
const RECOVERY_DIRECTIVE_THRESHOLD = 10;   // after 10 empty turns, send directive recovery prompt
const RECOVERY_RESET_THRESHOLD = 20;       // after 20 empty turns, full reset + fresh session
const HUMAN_RESUME_DELAY_MS = 10_000;      // 10s after last human disconnects
const NEEDS_INPUT_POLL_MS = 120_000;       // 2 min polling when blocked on questions
const VERIFY_EVERY_N_TURNS = 10;           // run verify_command every N productive turns
const MEMORY_WARN_TURNS = 3;              // warn after N productive turns without memory update

// Thresholds for classifying turn productivity
const IDLE_CHARS_THRESHOLD = 200;
const PRODUCTIVE_TOOL_THRESHOLD = 1;

// ── State machine ───────────────────────────────────────────────
const STATE = {
  INIT: 'INIT',
  PROMPTING: 'PROMPTING',
  WAITING: 'WAITING',
  DELAY: 'DELAY',
  PAUSED: 'PAUSED',
  NEEDS_INPUT: 'NEEDS_INPUT',
  COMPLETED: 'COMPLETED',
};

let state = STATE.INIT;
let turnCount = 0;
let consecutiveEmpty = 0;
let consecutiveIdle = 0;
let humanCount = 0;
let agentBusy = false;
let ws = null;
let connected = false;
let turnTimer = null;
let delayTimer = null;
let resumeTimer = null;
let taskPollTimer = null;
let turnTextChars = 0;
let turnToolCount = 0;
let turnMsgCount = 0;
let turnText = '';
let firstPromptSent = false;
let lastMemoryHash = '';
let turnsSinceMemoryUpdate = 0;
let productiveTurnsSinceVerify = 0;
let currentTask = null;              // Loaded from .task.json
let lastSeenAnswers = {};            // { questionId: answered_at|null } for detecting new answers
let needsInputTimer = null;

function log(msg) {
  const line = `[${new Date().toISOString()}] [${state}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function readFile(p) {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

function setState(newState) {
  const old = state;
  state = newState;
  if (old !== newState) log(`State: ${old} → ${newState}`);
}

function hashMemory() {
  const short = readFile('/workspace/SHORT_TERM_MEMORY.md') || '';
  const long = readFile('/workspace/LONG_TERM_MEMORY.md') || '';
  return `${short.length}:${long.length}:${short.slice(0, 100)}`;
}

// ── Task file management ────────────────────────────────────────
function loadTask() {
  const raw = readFile(TASK_FILE);
  if (!raw) return null;
  try {
    const task = JSON.parse(raw);
    return task;
  } catch (e) {
    log(`Failed to parse .task.json: ${e.message}`);
    return null;
  }
}

function saveTask(task) {
  try {
    fs.writeFileSync(TASK_FILE, JSON.stringify(task, null, 2) + '\n');
  } catch (e) {
    log(`Failed to write .task.json: ${e.message}`);
  }
}

function archiveMemory(task) {
  const archiveDir = path.join(ARCHIVE_DIR, task.id);
  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    const files = ['SHORT_TERM_MEMORY.md', 'LONG_TERM_MEMORY.md', 'plan.md', '.task.json'];
    for (const f of files) {
      const src = path.join('/workspace', f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(archiveDir, f));
      }
    }
    log(`Archived memory to ${archiveDir}`);
  } catch (e) {
    log(`Failed to archive memory: ${e.message}`);
  }
}

// ── Question helpers ────────────────────────────────────────────
function getUnansweredQuestions(task) {
  if (!task || !Array.isArray(task.questions)) return [];
  return task.questions.filter(q => q.answer === null || q.answer === undefined);
}

function getNewlyAnsweredQuestions(task) {
  if (!task || !Array.isArray(task.questions)) return [];
  const answered = [];
  for (const q of task.questions) {
    if (q.answer !== null && q.answer !== undefined && lastSeenAnswers[q.id] === null) {
      answered.push(q);
    }
  }
  return answered;
}

function snapshotAnswers(task) {
  lastSeenAnswers = {};
  if (!task || !Array.isArray(task.questions)) return;
  for (const q of task.questions) {
    lastSeenAnswers[q.id] = q.answered_at || null;
  }
}

function timeAgo(isoStr) {
  if (!isoStr) return 'unknown';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ── Auto-stop checks ────────────────────────────────────────────
function runVerification(task) {
  if (!task.goal || !task.goal.verify_command) return null;
  try {
    const output = execSync(task.goal.verify_command, {
      timeout: 30000,
      cwd: '/workspace',
    }).toString().trim();

    const value = parseFloat(output);
    if (isNaN(value)) {
      log(`Verification output not numeric: "${output}"`);
      return { passed: false, output, value: null };
    }

    const target = task.goal.target_value;
    const direction = task.goal.direction || 'below';
    const passed = direction === 'below' ? value < target : value > target;
    log(`Verification: ${value} ${direction} ${target} → ${passed ? 'PASSED' : 'not yet'}`);
    return { passed, output, value };
  } catch (e) {
    log(`Verification command failed: ${e.message}`);
    return { passed: false, output: e.message, value: null };
  }
}

function checkTaskCompletion(task, classification) {
  if (!task || task.status !== 'running') return false;

  // A) Agent declared completion — reload fresh from disk in case agent wrote it
  const freshTask = loadTask();
  if (freshTask && freshTask.status === 'completed') {
    log('Agent declared task complete');
    // If there's a verify_command, validate
    if (freshTask.goal && freshTask.goal.verify_command) {
      const result = runVerification(freshTask);
      if (result && result.passed) {
        completeTask(freshTask, 'agent_declared_verified', result.value);
        return true;
      } else {
        // Agent said done but verification failed — tell it to continue
        log('Agent declared complete but verification failed — will inform agent');
        freshTask.status = 'running';
        saveTask(freshTask);
        currentTask = freshTask;
        return false;
      }
    }
    // No verify_command — trust the agent
    completeTask(freshTask, 'agent_declared');
    return true;
  }

  // B) Periodic verification (every N productive turns)
  if (classification === 'productive') {
    productiveTurnsSinceVerify++;
    if (task.goal && task.goal.verify_command && productiveTurnsSinceVerify >= VERIFY_EVERY_N_TURNS) {
      productiveTurnsSinceVerify = 0;
      const result = runVerification(task);
      if (result && result.passed) {
        completeTask(task, 'verification_passed', result.value);
        return true;
      }
      if (result && result.value !== null) {
        task.progress.latest_metric = result.value;
        saveTask(task);
      }
    }
  }

  // C) Idle timeout
  const maxIdle = (task.limits && task.limits.max_idle_turns) || 20;
  if (consecutiveIdle >= maxIdle) {
    stopTask(task, 'idle_timeout');
    return true;
  }

  // D) Time limit
  if (task.limits && task.limits.max_duration_hours && task.started_at) {
    const elapsed = (Date.now() - new Date(task.started_at).getTime()) / (1000 * 60 * 60);
    if (elapsed >= task.limits.max_duration_hours) {
      stopTask(task, 'time_limit');
      return true;
    }
  }

  // E) Turn limit
  if (task.limits && task.limits.max_turns && task.progress.turns_completed >= task.limits.max_turns) {
    stopTask(task, 'turn_limit');
    return true;
  }

  return false;
}

function completeTask(task, reason, metricValue) {
  task.status = 'completed';
  task.completed_at = new Date().toISOString();
  task.completion_reason = reason;
  if (metricValue !== undefined) {
    task.progress.latest_metric = metricValue;
  }
  saveTask(task);
  currentTask = task;
  archiveMemory(task);
  broadcastTaskStatus(task);
  log(`Task COMPLETED: ${reason} (metric=${metricValue})`);
  setState(STATE.COMPLETED);
}

function stopTask(task, reason) {
  task.status = 'stopped';
  task.completed_at = new Date().toISOString();
  task.completion_reason = reason;
  saveTask(task);
  currentTask = task;
  archiveMemory(task);
  broadcastTaskStatus(task);
  log(`Task STOPPED: ${reason}`);
  setState(STATE.COMPLETED);
}

function broadcastTaskStatus(task) {
  if (!connected || !ws) return;
  const unanswered = getUnansweredQuestions(task);
  const blocking = unanswered.filter(q => q.priority === 'blocking');
  const status = {
    type: 'task_status',
    task: task ? {
      id: task.id,
      name: task.name,
      status: task.status,
      completion_reason: task.completion_reason || null,
      turns_completed: task.progress ? task.progress.turns_completed : 0,
      latest_metric: task.progress ? task.progress.latest_metric : null,
      summary: task.progress ? task.progress.summary : '',
      pending_questions: unanswered.length,
      blocked: blocking.length > 0,
      questions: unanswered,
    } : null,
  };
  ws.send(JSON.stringify(status));
}

// ── System context gathering ────────────────────────────────────
function getProcessInfo(task) {
  try {
    const tmux = execSync('tmux ls 2>/dev/null || echo "no tmux sessions"', { timeout: 5000 }).toString().trim();
    const mem = execSync('free -h 2>/dev/null | grep Mem', { timeout: 5000 }).toString().trim();
    const cores = execSync('nproc 2>/dev/null', { timeout: 5000 }).toString().trim();
    const freeGb = execSync("free -m 2>/dev/null | awk '/Mem:/ {printf \"%.1f\", $2/1024}'", { timeout: 5000 }).toString().trim();

    // Instance metadata (injected by control plane)
    const instanceType = process.env.INSTANCE_TYPE || 'unknown';
    const containerCpus = process.env.INSTANCE_CPUS || cores;
    const containerMemMb = process.env.INSTANCE_MEMORY_MB || '?';

    // Build process grep pattern from task config or use generic defaults
    let processPattern = 'python|node|cargo|make|gcc|clang|train|compress';
    if (task && task.context && task.context.process_monitor && task.context.process_monitor.length > 0) {
      processPattern = task.context.process_monitor.join('|');
    }
    const procs = execSync(`ps aux 2>/dev/null | grep -E "${processPattern}" | grep -v grep | head -15 || echo "no matching processes"`, { timeout: 5000 }).toString().trim();

    return `\n## System Resources\nInstance: ${instanceType} | Container: ${containerCpus} CPUs, ${containerMemMb} MB RAM\nRuntime: ${cores} CPUs (nproc), ${freeGb} GB (free)\n${mem}\n\n## Running Processes\n\`\`\`\n${tmux}\n\n${procs}\n\`\`\``;
  } catch { return ''; }
}

function getTaskProgress(task) {
  if (!task || !task.context || !task.context.progress_commands || task.context.progress_commands.length === 0) {
    return '';
  }
  try {
    const outputs = [];
    for (const cmd of task.context.progress_commands) {
      try {
        const out = execSync(cmd, { timeout: 10000, cwd: '/workspace' }).toString().trim();
        if (out) outputs.push(out);
      } catch {}
    }
    return outputs.length > 0 ? `\n## Task Progress\n\`\`\`\n${outputs.join('\n')}\n\`\`\`` : '';
  } catch { return ''; }
}

// ── Operator directives ─────────────────────────────────────────
const DIRECTIVES_FILE = '/workspace/.operator-directives.json';

function loadDirectives() {
  const raw = readFile(DIRECTIVES_FILE);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function buildDirectivesSection(compact) {
  const directives = loadDirectives();
  if (directives.length === 0) return '';

  if (compact) {
    const items = directives.map(d => d.instruction).join('; ');
    return `\nOPERATOR DIRECTIVES (MANDATORY): ${items}`;
  }

  const numbered = directives.map((d, i) => `${i + 1}. ${d.instruction}`).join('\n');
  return `\n## OPERATOR DIRECTIVES (MANDATORY — DO NOT OVERRIDE)\nThese instructions come from the human operator. They take precedence over all other instructions. You MUST follow them and MUST NOT modify, revert, or work around them.\n${numbered}`;
}

// ── Prompt builders ─────────────────────────────────────────────
function buildFullPrompt() {
  const task = currentTask;
  const shortMem = readFile('/workspace/SHORT_TERM_MEMORY.md') || '(empty)';
  const longMem = readFile('/workspace/LONG_TERM_MEMORY.md') || '(empty)';
  const plan = readFile('/workspace/plan.md') || '(no plan)';
  const processInfo = getProcessInfo(task);
  const progress = getTaskProgress(task);

  lastMemoryHash = hashMemory();
  turnsSinceMemoryUpdate = 0;

  // Build goal section from task or use generic
  let goalSection;
  let completionInstructions;
  if (task && task.status === 'running') {
    goalSection = `## GOAL\n${task.name}${task.description ? '\n' + task.description : ''}`;
    if (task.goal && task.goal.description) {
      goalSection += `\n\nSuccess criteria: ${task.goal.description}`;
    }
    if (task.goal && task.goal.verify_command) {
      goalSection += `\nVerification: \`${task.goal.verify_command}\` ${task.goal.direction || 'below'} ${task.goal.target_value}`;
    }
    completionInstructions = `\n## TASK COMPLETION
When the task is fully complete, update /workspace/.task.json — set "status" to "completed" and write a summary in "progress.summary".
The supervisor will verify your work${task.goal && task.goal.verify_command ? ' by running the verification command' : ''}.`;
  } else {
    goalSection = `## GOAL\nWork on project ${PROJECT_NAME}. Check your memory files and plan for current objectives.`;
    completionInstructions = '';
  }

  // System prompt prepend/append from task config
  const prepend = (task && task.context && task.context.system_prompt_prepend) || '';
  const append = (task && task.context && task.context.system_prompt_append) || '';

  return `${prepend ? prepend + '\n\n' : ''}[${new Date().toISOString()}] You are an autonomous AI agent working on project: ${PROJECT_NAME}.
Your workspace is /workspace. You have passwordless sudo, uv, clang-16, gcc, cmake, tmux, Python 3, scikit-learn, numpy, scipy.

This is a PERSISTENT SESSION — a supervisor sends you periodic prompts to keep you working.
Your memory files in /workspace/ provide continuity across context compaction.

## Your Short-Term Memory
${shortMem}

## Your Long-Term Memory
${longMem}
${processInfo}
${progress}

## Plan
${plan}

## INSTRUCTIONS

1. Read your memory files carefully — they contain your progress and decisions.
2. Check running processes (tmux ls, ps aux). Do NOT restart processes that are already working.
3. Identify the highest-priority task that isn't already running.
4. Execute it. **Maximize parallelism** — use tmux sessions and background jobs to use ALL available CPUs.
5. BEFORE YOUR TURN ENDS: Update /workspace/SHORT_TERM_MEMORY.md and /workspace/LONG_TERM_MEMORY.md.

${goalSection}

## KEY RULES
- Use sudo freely for package installation
- Use tmux for long tasks: \`tmux new-session -d -s <name> '<command>'\`
- ALWAYS update memory files before finishing your turn
- Use ALL available CPU cores — run parallel experiments!
- Git commit progress regularly
${completionInstructions}

## ASKING FOR HELP
If you need human input, add a question to /workspace/.task.json in the "questions" array:
- priority "question": non-blocking, you'll keep working on other things
- priority "blocking": you truly cannot proceed without this answer
Format: { "id": "q_<timestamp>", "text": "...", "context": "...", "priority": "question"|"blocking", "asked_at": "<ISO>", "answered_at": null, "answer": null }
Read the current .task.json first, add to the questions array (create it if missing), then write back.
${buildDirectivesSection(false)}
${append ? '\n' + append : ''}
Go.`;
}

function buildContinuationPrompt() {
  const task = currentTask;
  const currentHash = hashMemory();
  const memoryChanged = currentHash !== lastMemoryHash;

  if (memoryChanged) {
    turnsSinceMemoryUpdate = 0;
  }
  lastMemoryHash = currentHash;

  const processInfo = getProcessInfo(task);
  const progress = getTaskProgress(task);

  let memorySection = '';
  if (memoryChanged) {
    const shortMem = readFile('/workspace/SHORT_TERM_MEMORY.md') || '(empty)';
    const longMem = readFile('/workspace/LONG_TERM_MEMORY.md') || '(empty)';
    memorySection = `\n## Updated Memory Files\n### Short-Term\n${shortMem}\n### Long-Term\n${longMem}`;
  }

  // Memory update reminder
  let memoryReminder = '';
  if (turnsSinceMemoryUpdate >= MEMORY_WARN_TURNS) {
    memoryReminder = '\n**IMPORTANT: You have not updated your memory files in several turns. Update /workspace/SHORT_TERM_MEMORY.md and /workspace/LONG_TERM_MEMORY.md NOW before continuing.**';
  }

  // Task-specific continuation
  let taskNote = '';
  if (task && task.status === 'running') {
    taskNote = `\nTask: ${task.name}`;
    if (task.progress && task.progress.latest_metric !== null && task.progress.latest_metric !== undefined) {
      taskNote += ` (latest metric: ${task.progress.latest_metric})`;
    }
  }

  // Question sections
  let questionsSection = '';
  let answersSection = '';
  if (task) {
    const freshTask = loadTask() || task;
    const newlyAnswered = getNewlyAnsweredQuestions(freshTask);
    const unanswered = getUnansweredQuestions(freshTask);
    snapshotAnswers(freshTask);

    if (newlyAnswered.length > 0) {
      answersSection = '\n## Human Responses\n' + newlyAnswered.map(q =>
        `- ${q.id}: "${q.answer}"\n  → Process this answer and update your plan accordingly.`
      ).join('\n');
    }

    if (unanswered.length > 0) {
      questionsSection = '\n## Pending Questions (awaiting human input)\n' + unanswered.map(q =>
        `- [${q.priority}] ${q.id}: "${q.text}" (asked ${timeAgo(q.asked_at)})\n  → ${q.priority === 'blocking' ? 'Work on other items until this is answered.' : 'Non-blocking, use your best judgment if needed.'}`
      ).join('\n');
    }
  }

  return `[${new Date().toISOString()}] Continue working.${taskNote} ${memoryChanged ? 'Memory files were updated externally.' : 'You already have your memory in context.'}
${processInfo}
${progress}
${memorySection}
${memoryReminder}${answersSection}${questionsSection}${buildDirectivesSection(true)}
Keep making progress. If all experiments are running and stable, look for NEW optimizations to try.
Update memory files before your turn ends.${task && task.status === 'running' ? '\nWhen task is fully complete, update /workspace/.task.json status to "completed".' : ''}`;
}

function buildIdleCheckPrompt() {
  const task = currentTask;
  const processInfo = getProcessInfo(task);
  const progress = getTaskProgress(task);

  let taskNote = '';
  if (task && task.status === 'running') {
    taskNote = `\nTask: ${task.name}`;
    if (task.progress && task.progress.latest_metric !== null && task.progress.latest_metric !== undefined) {
      taskNote += ` (latest metric: ${task.progress.latest_metric})`;
    }
  }

  return `[${new Date().toISOString()}] Periodic check-in.${taskNote} Review your running processes and progress:
${processInfo}
${progress}

If everything is running fine, just confirm status briefly. If anything needs attention (process died, new results, etc.), take action.
If you have idle CPU/RAM capacity, consider launching additional experiments or optimizations.`;
}

function buildVerificationFailedPrompt(result) {
  const task = currentTask;
  return `[${new Date().toISOString()}] You declared the task complete, but verification FAILED.

Task: ${task ? task.name : 'unknown'}
Verification command output: ${result ? result.output : 'N/A'}
${result && result.value !== null ? `Current value: ${result.value}, Target: ${task && task.goal ? task.goal.target_value : 'N/A'} (${task && task.goal ? task.goal.direction : 'below'})` : ''}

Please continue working to meet the goal criteria. Update /workspace/.task.json status back to "running" if needed.`;
}

function buildRecoveryPrompt() {
  const task = currentTask;
  const shortMem = readFile('/workspace/SHORT_TERM_MEMORY.md') || '(empty)';
  const longMem = readFile('/workspace/LONG_TERM_MEMORY.md') || '(empty)';

  // Gather live system state
  let tmuxOutput = '', psOutput = '', diskOutput = '';
  try { tmuxOutput = execSync('tmux ls 2>/dev/null || echo "no tmux sessions"', { timeout: 5000 }).toString().trim(); } catch {}
  try { psOutput = execSync('ps aux 2>/dev/null | grep -v grep | grep -vE "^USER|supervisor|gateway|node.*openclaw" | tail -20 || echo "no processes"', { timeout: 5000 }).toString().trim(); } catch {}
  try { diskOutput = execSync('df -h /workspace 2>/dev/null | tail -1', { timeout: 5000 }).toString().trim(); } catch {}

  let taskNote = '';
  if (task && task.status === 'running') {
    taskNote = `Task: ${task.name}\n${task.description || ''}`;
  }

  return `[${new Date().toISOString()}] RECOVERY CHECK — You have been unresponsive for ${consecutiveEmpty} turns. This is a fresh re-initialization.

Project: ${PROJECT_NAME}
${taskNote}

## LIVE SYSTEM STATE (gathered just now)

### tmux sessions
\`\`\`
${tmuxOutput}
\`\`\`

### Running processes
\`\`\`
${psOutput}
\`\`\`

### Disk usage
\`\`\`
${diskOutput}
\`\`\`

## Your Short-Term Memory
${shortMem}

## Your Long-Term Memory
${longMem}

${buildDirectivesSection(false)}

## WHAT YOU MUST DO RIGHT NOW

1. **Check each tmux session**: Run \`tmux capture-pane -t <session> -p | tail -20\` for EVERY session listed above to see their current output.
2. **Report findings**: Tell me what each process is doing — is it running, stuck, completed, errored?
3. **If processes finished**: Collect their output, check results, update memory files, and plan next steps.
4. **If processes are still running**: Note their progress and estimate completion time.
5. **If no processes are running**: Review your memory files and start the next task.
6. **Update /workspace/SHORT_TERM_MEMORY.md** with current status BEFORE your turn ends.

You MUST take action and produce output. Do not return an empty response.`;
}

// ── Turn management ─────────────────────────────────────────────
function sendPrompt() {
  if (state === STATE.COMPLETED || state === STATE.NEEDS_INPUT) {
    log(`In ${state} state — not sending prompt`);
    return;
  }

  if (!connected || agentBusy) {
    log(`Cannot send prompt: connected=${connected}, agentBusy=${agentBusy}`);
    scheduleTurnDelay(MIN_DELAY_MS);
    return;
  }

  // Reload task in case it was modified externally
  currentTask = loadTask();
  if (currentTask) snapshotAnswers(currentTask);

  // Check if task was resumed (status changed back to running while in COMPLETED state)
  if (currentTask && currentTask.status !== 'running' && currentTask.status !== undefined) {
    if (state !== STATE.COMPLETED) {
      log(`Task status is "${currentTask.status}" — entering COMPLETED state`);
      setState(STATE.COMPLETED);
    }
    return;
  }

  turnCount++;
  turnTextChars = 0;
  turnToolCount = 0;
  turnMsgCount = 0;
  turnText = '';

  // Update task progress
  if (currentTask && currentTask.progress) {
    currentTask.progress.turns_completed = (currentTask.progress.turns_completed || 0) + 1;
    currentTask.progress.last_active_at = new Date().toISOString();
    saveTask(currentTask);
  }

  let prompt;
  let promptType;
  if (!firstPromptSent) {
    prompt = buildFullPrompt();
    firstPromptSent = true;
    promptType = 'full';
  } else if (consecutiveEmpty >= RECOVERY_RESET_THRESHOLD) {
    // Nuclear option: full reset after 20+ empty turns
    log(`Recovery reset: ${consecutiveEmpty} consecutive empty turns — full re-initialization`);
    firstPromptSent = false;
    consecutiveEmpty = 0;
    consecutiveIdle = 0;
    prompt = buildFullPrompt();
    firstPromptSent = true;
    promptType = 'recovery-reset';
  } else if (consecutiveEmpty >= RECOVERY_DIRECTIVE_THRESHOLD) {
    // Strong recovery: directive prompt with live system state
    prompt = buildRecoveryPrompt();
    promptType = 'recovery-directive';
  } else if (consecutiveEmpty >= RECOVERY_FULL_THRESHOLD) {
    // Mild recovery: resend full context prompt
    prompt = buildFullPrompt();
    promptType = 'recovery-full';
  } else if (consecutiveIdle >= 3) {
    prompt = buildIdleCheckPrompt();
    promptType = 'idle-check';
  } else {
    prompt = buildContinuationPrompt();
    promptType = 'continuation';
  }

  log(`=== Turn ${turnCount} === Sending ${promptType} prompt (${prompt.length} chars, empty=${consecutiveEmpty}, idle=${consecutiveIdle}${currentTask ? ', task=' + currentTask.status : ''})`);
  setState(STATE.PROMPTING);

  ws.send(JSON.stringify({ type: 'user_message', content: prompt }));
  setState(STATE.WAITING);

  // Turn timeout
  turnTimer = setTimeout(() => {
    log(`Turn ${turnCount} timed out after ${TURN_TIMEOUT_MS / 1000}s (${turnMsgCount} msgs, ${turnTextChars} chars, ${turnToolCount} tools)`);
    consecutiveEmpty = 0;
    consecutiveIdle = 0;
    onTurnEnd('timeout');
  }, TURN_TIMEOUT_MS);
}

function classifyTurn() {
  if (turnTextChars === 0 && turnToolCount === 0) return 'empty';
  if (turnToolCount >= PRODUCTIVE_TOOL_THRESHOLD) return 'productive';
  if (turnTextChars < IDLE_CHARS_THRESHOLD && turnToolCount === 0) return 'idle';
  return 'ok';
}

function onTurnEnd(result) {
  if (turnTimer) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }

  const classification = result === 'timeout' ? 'productive' : (result === 'error' ? 'error' : classifyTurn());

  // Track memory updates
  const currentHash = hashMemory();
  if (currentHash !== lastMemoryHash) {
    turnsSinceMemoryUpdate = 0;
    lastMemoryHash = currentHash;
  } else if (classification === 'productive' || classification === 'ok') {
    turnsSinceMemoryUpdate++;
  }

  // Check task auto-stop conditions
  if (currentTask && currentTask.status === 'running') {
    const stopped = checkTaskCompletion(currentTask, classification);
    if (stopped) {
      log('Task auto-stopped — entering COMPLETED state');
      return; // Don't schedule next turn
    }
  }

  // Check for unanswered blocking questions
  if (currentTask && currentTask.status === 'running') {
    const freshTask = loadTask() || currentTask;
    const unanswered = getUnansweredQuestions(freshTask);
    const blocking = unanswered.filter(q => q.priority === 'blocking');
    snapshotAnswers(freshTask);

    if (blocking.length > 0 && (classification === 'idle' || classification === 'empty')) {
      log(`Blocked on ${blocking.length} question(s) — entering NEEDS_INPUT`);
      currentTask = freshTask;
      broadcastTaskStatus(currentTask);
      setState(STATE.NEEDS_INPUT);
      startNeedsInputPoll();
      return;
    }
  }

  let delay;
  switch (classification) {
    case 'productive':
      consecutiveEmpty = 0;
      consecutiveIdle = 0;
      delay = MIN_DELAY_MS;
      break;

    case 'ok':
      consecutiveEmpty = 0;
      consecutiveIdle = 0;
      delay = MIN_DELAY_MS * 2;
      break;

    case 'idle':
      consecutiveEmpty = 0;
      consecutiveIdle++;
      delay = Math.min(IDLE_DELAY_MS * consecutiveIdle, MAX_IDLE_DELAY_MS);
      break;

    case 'empty':
      consecutiveEmpty++;
      consecutiveIdle++;
      if (consecutiveEmpty >= EMPTY_THRESHOLD) {
        delay = Math.min(BACKOFF_DELAY_MS * Math.pow(2, consecutiveEmpty - EMPTY_THRESHOLD), MAX_BACKOFF_MS);
      } else {
        delay = BACKOFF_DELAY_MS;
      }
      break;

    case 'error':
      consecutiveEmpty++;
      delay = BACKOFF_DELAY_MS;
      break;

    default:
      delay = MIN_DELAY_MS;
  }

  log(`Turn ${turnCount}: ${classification} (${turnMsgCount} msgs, ${turnTextChars} chars, ${turnToolCount} tools, empty=${consecutiveEmpty}) — next in ${Math.round(delay / 1000)}s`);

  // Broadcast updated task status
  if (currentTask) broadcastTaskStatus(currentTask);

  if (humanCount > 0) {
    setState(STATE.PAUSED);
    log(`Humans attached (${humanCount}) — pausing autonomous prompts`);
  } else {
    scheduleTurnDelay(delay);
  }
}

// ── NEEDS_INPUT polling ──────────────────────────────────────────
function startNeedsInputPoll() {
  stopNeedsInputPoll();
  needsInputTimer = setInterval(() => {
    if (state !== STATE.NEEDS_INPUT) {
      stopNeedsInputPoll();
      return;
    }

    const freshTask = loadTask();
    if (!freshTask) {
      log('Task file removed while in NEEDS_INPUT — resuming');
      stopNeedsInputPoll();
      currentTask = null;
      sendPrompt();
      return;
    }

    // Check if task status changed externally
    if (freshTask.status !== 'running') {
      log(`Task status changed to "${freshTask.status}" while in NEEDS_INPUT`);
      stopNeedsInputPoll();
      currentTask = freshTask;
      setState(STATE.COMPLETED);
      return;
    }

    const unanswered = getUnansweredQuestions(freshTask);
    const blocking = unanswered.filter(q => q.priority === 'blocking');
    const newlyAnswered = getNewlyAnsweredQuestions(freshTask);

    if (newlyAnswered.length > 0 || blocking.length === 0) {
      log(`Exiting NEEDS_INPUT: ${newlyAnswered.length} new answer(s), ${blocking.length} blocking remaining`);
      stopNeedsInputPoll();
      currentTask = freshTask;
      consecutiveIdle = 0;
      consecutiveEmpty = 0;
      broadcastTaskStatus(currentTask);
      if (humanCount > 0) {
        setState(STATE.PAUSED);
      } else {
        sendPrompt();
      }
      return;
    }

    log(`NEEDS_INPUT poll: still ${blocking.length} blocking question(s) unanswered`);
  }, NEEDS_INPUT_POLL_MS);
}

function stopNeedsInputPoll() {
  if (needsInputTimer) {
    clearInterval(needsInputTimer);
    needsInputTimer = null;
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

// ── Task resume polling (detect status changed back to "running") ──
function startTaskPoll() {
  if (taskPollTimer) return;
  taskPollTimer = setInterval(() => {
    if (state !== STATE.COMPLETED && state !== STATE.NEEDS_INPUT) return;
    const task = loadTask();
    if (task && task.status === 'running') {
      log('Task resumed (status set back to running) — restarting prompt loop');
      currentTask = task;
      consecutiveIdle = 0;
      consecutiveEmpty = 0;
      productiveTurnsSinceVerify = 0;
      firstPromptSent = false;
      if (humanCount > 0) {
        setState(STATE.PAUSED);
      } else {
        sendPrompt();
      }
    } else if (!task) {
      // .task.json was removed — go back to forever-running mode
      log('Task file removed — reverting to forever-running mode');
      currentTask = null;
      consecutiveIdle = 0;
      consecutiveEmpty = 0;
      firstPromptSent = false;
      if (humanCount > 0) {
        setState(STATE.PAUSED);
      } else {
        sendPrompt();
      }
    }
  }, 15_000); // Check every 15s
}

// ── Human presence management ───────────────────────────────────
function onHumanCountChange(newCount) {
  const oldCount = humanCount;
  humanCount = newCount;

  if (newCount > 0 && oldCount === 0) {
    log(`Human(s) connected (${newCount}) — will pause after current turn`);
    if (state === STATE.DELAY && delayTimer) {
      clearTimeout(delayTimer);
      delayTimer = null;
      setState(STATE.PAUSED);
    } else if (state === STATE.NEEDS_INPUT) {
      stopNeedsInputPoll();
      setState(STATE.PAUSED);
    }
  } else if (newCount === 0 && oldCount > 0) {
    if (state === STATE.COMPLETED) {
      log('All humans disconnected but task is completed — staying in COMPLETED');
      return;
    }
    log(`All humans disconnected — resuming in ${HUMAN_RESUME_DELAY_MS / 1000}s`);
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      if (humanCount === 0 && state === STATE.PAUSED) {
        // Check if we should re-enter NEEDS_INPUT
        const freshTask = loadTask();
        if (freshTask && freshTask.status === 'running') {
          const blocking = getUnansweredQuestions(freshTask).filter(q => q.priority === 'blocking');
          if (blocking.length > 0) {
            log(`Resuming into NEEDS_INPUT (${blocking.length} blocking questions)`);
            currentTask = freshTask;
            snapshotAnswers(freshTask);
            setState(STATE.NEEDS_INPUT);
            startNeedsInputPoll();
            return;
          }
        }
        log('Resuming autonomous prompts');
        consecutiveIdle = 0;
        if (agentBusy) {
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
    ws.send(JSON.stringify({ type: 'identify', role: 'supervisor' }));

    // Broadcast current task status on connect
    if (currentTask) broadcastTaskStatus(currentTask);
  });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'status') {
      agentBusy = msg.agentBusy || false;
      humanCount = msg.humanCount || 0;
      log(`Status: agentBusy=${agentBusy}, humans=${humanCount}, ocConnected=${msg.ocConnected}`);

      if (state === STATE.COMPLETED) {
        log('In COMPLETED state — not starting prompt loop');
      } else if (state === STATE.INIT && !agentBusy && humanCount === 0 && msg.ocConnected) {
        sendPrompt();
      } else if (state === STATE.INIT && (agentBusy || humanCount > 0)) {
        setState(STATE.PAUSED);
        log('Agent busy or humans present at startup — waiting');
      } else if (state === STATE.INIT && !msg.ocConnected) {
        log('OpenClaw not yet connected — waiting for status update');
      }
    }

    else if (msg.type === 'client_change') {
      onHumanCountChange(msg.humans || 0);
    }

    else if (msg.type === 'history') {
      // noop
    }

    // Supervisor control messages from gateway
    else if (msg.type === 'supervisor_control') {
      const action = msg.action;
      log(`Received supervisor_control: ${action}`);
      if (action === 'pause') {
        if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
        if (delayTimer) { clearTimeout(delayTimer); delayTimer = null; }
        if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
        stopNeedsInputPoll();
        setState(STATE.PAUSED);
        log('Paused by operator');
      } else if (action === 'resume') {
        consecutiveEmpty = 0;
        consecutiveIdle = 0;
        if (state === STATE.PAUSED || state === STATE.COMPLETED || state === STATE.NEEDS_INPUT) {
          stopNeedsInputPoll();
          log('Resumed by operator');
          if (agentBusy) {
            setState(STATE.WAITING);
          } else {
            sendPrompt();
          }
        }
      } else if (action === 'stop' || action === 'restart') {
        log(`Stopping supervisor (action: ${action})`);
        if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
        if (delayTimer) { clearTimeout(delayTimer); delayTimer = null; }
        if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
        if (taskPollTimer) { clearInterval(taskPollTimer); taskPollTimer = null; }
        stopNeedsInputPoll();
        if (ws) { try { ws.close(); } catch {} }
        process.exit(0);
      }
    }

    // Agent stream events — track for turn metrics
    else if (msg.type === 'text_delta') {
      turnTextChars += (msg.text || '').length;
      turnText += (msg.text || '');
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
        onTurnEnd('ok');
      } else if (state === STATE.PAUSED) {
        agentBusy = false;
        if (humanCount === 0) {
          log('Agent finished while paused with no humans — resuming');
          consecutiveIdle = 0;
          sendPrompt();
        } else {
          log('Agent finished (human-initiated turn) — staying paused');
        }
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
    stopNeedsInputPoll();
    // Preserve COMPLETED state across reconnects
    if (state !== STATE.COMPLETED && state !== STATE.NEEDS_INPUT) {
      setState(STATE.INIT);
    }
    firstPromptSent = false;
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
  log(`Turn timeout: ${TURN_TIMEOUT_MS / 1000}s, idle delay: ${IDLE_DELAY_MS / 1000}s`);

  // Load task on startup
  currentTask = loadTask();
  if (currentTask) {
    log(`Task loaded: "${currentTask.name}" (status: ${currentTask.status})`);
    if (currentTask.status === 'completed' || currentTask.status === 'stopped') {
      log('Task already completed/stopped — entering COMPLETED state');
      setState(STATE.COMPLETED);
    }
  } else {
    log('No .task.json found — running in forever mode with generic prompts');
  }

  await waitForBridge();
  connectToGateway();
  startTaskPoll();
}

process.on('SIGTERM', () => {
  log('Received SIGTERM — graceful shutdown');
  if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
  if (delayTimer) { clearTimeout(delayTimer); delayTimer = null; }
  if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
  if (taskPollTimer) { clearInterval(taskPollTimer); taskPollTimer = null; }
  stopNeedsInputPoll();
  if (ws) { try { ws.close(); } catch {} }
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  log(`UNCAUGHT ERROR: ${err.message} — restarting in 30s`);
  try { if (ws) ws.close(); } catch {}
  if (taskPollTimer) { clearInterval(taskPollTimer); taskPollTimer = null; }
  stopNeedsInputPoll();
  setTimeout(() => main().catch(e => log(`FATAL: ${e.message}`)), 30000);
});

process.on('unhandledRejection', (err) => {
  log(`UNHANDLED REJECTION: ${err} — continuing`);
});

main().catch(err => {
  log(`Supervisor fatal error: ${err.message} — restarting in 30s`);
  setTimeout(() => main().catch(e => log(`FATAL: ${e.message}`)), 30000);
});
