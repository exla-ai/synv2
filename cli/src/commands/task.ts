import { loadConfig } from '../config.js';
import { ApiClient } from '../api-client.js';

export async function taskStartCommand(project: string, opts: { name?: string; description?: string; type?: string; fromFile?: string }) {
  const config = loadConfig();
  if (!config) {
    console.error('Not configured. Run: synv2 setup');
    process.exit(1);
  }

  const api = new ApiClient(config);

  let taskDef: any;

  if (opts.fromFile) {
    const fs = await import('fs');
    try {
      const raw = fs.readFileSync(opts.fromFile, 'utf-8');
      taskDef = JSON.parse(raw);
    } catch (err: any) {
      console.error(`Failed to read task file: ${err.message}`);
      process.exit(1);
    }
  } else {
    if (!opts.name) {
      console.error('Task name required. Use --name or --from-file');
      process.exit(1);
    }
    taskDef = {
      name: opts.name,
      description: opts.description || '',
      type: opts.type || 'subjective',
    };
  }

  try {
    const result = await api.createTask(project, taskDef);
    console.log(`Task created: ${(result as any).task.name}`);
    console.log(`  ID: ${(result as any).task.id}`);
    console.log(`  Status: ${(result as any).task.status}`);
  } catch (err: any) {
    console.error(`Failed to create task: ${err.message}`);
    process.exit(1);
  }
}

function timeAgo(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export async function taskStatusCommand(project: string) {
  const config = loadConfig();
  if (!config) {
    console.error('Not configured. Run: synv2 setup');
    process.exit(1);
  }

  const api = new ApiClient(config);

  try {
    const detail = await api.getProject(project);
    const task = (detail as any).task;

    if (!task) {
      console.log(`No task configured for "${project}"`);
      return;
    }

    const statusLabel = task.blocked ? `${task.status} (BLOCKED)` : task.status;
    console.log(`Task: ${task.name} [${statusLabel}]`);
    if (task.completion_reason) {
      console.log(`  Completion reason: ${task.completion_reason}`);
    }
    console.log(`  Turns completed: ${task.turns_completed || 0}`);
    if (task.latest_metric !== null && task.latest_metric !== undefined) {
      console.log(`  Latest metric: ${task.latest_metric}`);
    }
    if (task.summary) {
      console.log(`  Summary: ${task.summary}`);
    }

    // Show pending questions
    if (task.questions && task.questions.length > 0) {
      console.log('');
      console.log('  Pending questions:');
      for (const q of task.questions) {
        const tag = q.priority === 'blocking' ? '[BLOCKING]' : '[question]';
        console.log(`  ${tag} ${q.id} (${timeAgo(q.asked_at)}):`);
        console.log(`    "${q.text}"`);
        if (q.context) {
          console.log(`    Context: ${q.context}`);
        }
        console.log(`    Answer: synv2 task respond ${project} ${q.id} "your answer"`);
      }
    }
  } catch (err: any) {
    console.error(`Failed to get task status: ${err.message}`);
    process.exit(1);
  }
}

export async function taskStopCommand(project: string) {
  const config = loadConfig();
  if (!config) {
    console.error('Not configured. Run: synv2 setup');
    process.exit(1);
  }

  const api = new ApiClient(config);

  try {
    await api.stopTask(project);
    console.log(`Task stopped for "${project}"`);
  } catch (err: any) {
    console.error(`Failed to stop task: ${err.message}`);
    process.exit(1);
  }
}

export async function taskResumeCommand(project: string) {
  const config = loadConfig();
  if (!config) {
    console.error('Not configured. Run: synv2 setup');
    process.exit(1);
  }

  const api = new ApiClient(config);

  try {
    await api.resumeTask(project);
    console.log(`Task resumed for "${project}"`);
  } catch (err: any) {
    console.error(`Failed to resume task: ${err.message}`);
    process.exit(1);
  }
}

export async function taskRespondCommand(project: string, questionId: string, answer: string) {
  const config = loadConfig();
  if (!config) {
    console.error('Not configured. Run: synv2 setup');
    process.exit(1);
  }

  const api = new ApiClient(config);

  try {
    await api.respondToQuestion(project, questionId, answer);
    console.log(`Answer sent for question ${questionId}`);
  } catch (err: any) {
    console.error(`Failed to respond: ${err.message}`);
    process.exit(1);
  }
}
