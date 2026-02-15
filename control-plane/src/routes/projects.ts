import { Router } from 'express';
import { z } from 'zod';
import WebSocket from 'ws';
import * as db from '../db/index.js';
import { encrypt } from '../services/secrets.js';
import { createProjectContainer, destroyProjectContainer, restartProjectContainer } from '../services/container-manager.js';
import { getContainerInfo, getContainerIp, execInContainer } from '../services/docker.js';

const router = Router();

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, 'Name must be lowercase alphanumeric with dashes'),
  anthropicApiKey: z.string().min(1),
  mcpServers: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

// POST /api/projects — Create a new project
router.post('/', async (req, res) => {
  const parsed = CreateProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_error', message: parsed.error.issues[0].message });
    return;
  }

  const { name, anthropicApiKey, mcpServers, env } = parsed.data;

  // Check if project already exists
  if (db.getProject(name)) {
    res.status(409).json({ error: 'conflict', message: `Project "${name}" already exists` });
    return;
  }

  // Insert into database
  db.insertProject({
    name,
    status: 'creating',
    container_id: null,
    anthropic_api_key_enc: encrypt(anthropicApiKey),
    mcp_servers: JSON.stringify(mcpServers || []),
    env_enc: encrypt(JSON.stringify(env || {})),
    created_at: new Date().toISOString(),
  });

  // Create container in background
  try {
    await createProjectContainer(name);
    const project = db.getProject(name)!;
    res.status(201).json({
      name: project.name,
      status: project.status,
      created_at: project.created_at,
      container_id: project.container_id,
      mcp_servers: JSON.parse(project.mcp_servers),
    });
  } catch (err: any) {
    res.status(500).json({ error: 'container_error', message: err.message });
  }
});

// GET /api/projects — List all projects
router.get('/', async (_req, res) => {
  const projects = db.listProjects();
  const result = await Promise.all(
    projects.map(async (p) => {
      // Sync status with Docker
      const container = await getContainerInfo(p.name);
      const actualStatus = container ? container.status : p.status === 'creating' ? 'creating' : 'stopped';
      if (actualStatus !== p.status) {
        db.updateProject(p.name, { status: actualStatus });
      }
      return {
        name: p.name,
        status: actualStatus,
        created_at: p.created_at,
        mcp_servers: JSON.parse(p.mcp_servers),
      };
    })
  );
  res.json({ projects: result });
});

// GET /api/projects/:name — Get project details
router.get('/:name', async (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  const container = await getContainerInfo(project.name);
  const status = container ? container.status : project.status;

  // Fetch task status from gateway
  let task = null;
  if (container && container.ip) {
    try {
      const healthRes = await fetch(`http://${container.ip}:18789/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (healthRes.ok) {
        const health = await healthRes.json() as any;
        task = health.task || null;
      }
    } catch {
      // Gateway not reachable — task remains null
    }
  }

  res.json({
    name: project.name,
    status,
    created_at: project.created_at,
    container_id: project.container_id,
    mcp_servers: JSON.parse(project.mcp_servers),
    task,
  });
});

// DELETE /api/projects/:name — Destroy a project
router.delete('/:name', async (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  try {
    await destroyProjectContainer(project.name);
    db.deleteProject(project.name);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: 'destroy_error', message: err.message });
  }
});

// POST /api/projects/:name/restart — Restart a project container
router.post('/:name/restart', async (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  try {
    await restartProjectContainer(project.name);
    res.json({ ok: true, status: 'running' });
  } catch (err: any) {
    res.status(500).json({ error: 'restart_error', message: err.message });
  }
});

// Task management

const TaskGoalSchema = z.object({
  description: z.string().optional(),
  verify_command: z.string().nullable().optional(),
  target_value: z.number().nullable().optional(),
  direction: z.enum(['below', 'above']).optional(),
}).optional();

const TaskLimitsSchema = z.object({
  max_idle_turns: z.number().optional(),
  max_duration_hours: z.number().nullable().optional(),
  max_turns: z.number().nullable().optional(),
}).optional();

const TaskContextSchema = z.object({
  system_prompt_prepend: z.string().optional(),
  system_prompt_append: z.string().optional(),
  process_monitor: z.array(z.string()).optional(),
  progress_commands: z.array(z.string()).optional(),
}).optional();

const CreateTaskSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(['measurable', 'subjective']).optional(),
  goal: TaskGoalSchema,
  limits: TaskLimitsSchema,
  context: TaskContextSchema,
});

// POST /api/projects/:name/task — Create or replace a task
router.post('/:name/task', async (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  const parsed = CreateTaskSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_error', message: parsed.error.issues[0].message });
    return;
  }

  const taskDef = {
    version: 1,
    id: `task_${Date.now()}`,
    name: parsed.data.name,
    description: parsed.data.description || '',
    type: parsed.data.type || 'subjective',
    goal: parsed.data.goal || {},
    limits: {
      max_idle_turns: parsed.data.limits?.max_idle_turns ?? 20,
      max_duration_hours: parsed.data.limits?.max_duration_hours ?? null,
      max_turns: parsed.data.limits?.max_turns ?? null,
    },
    status: 'running',
    started_at: new Date().toISOString(),
    completed_at: null,
    completion_reason: null,
    progress: {
      turns_completed: 0,
      last_active_at: null,
      latest_metric: null,
      summary: '',
    },
    context: {
      system_prompt_prepend: parsed.data.context?.system_prompt_prepend || '',
      system_prompt_append: parsed.data.context?.system_prompt_append || '',
      process_monitor: parsed.data.context?.process_monitor || [],
      progress_commands: parsed.data.context?.progress_commands || [],
    },
    questions: [],
  };

  try {
    const json = JSON.stringify(taskDef, null, 2);
    await execInContainer(project.name, ['bash', '-c', `cat > /workspace/.task.json << 'TASKEOF'\n${json}\nTASKEOF`]);
    res.status(201).json({ ok: true, task: taskDef });
  } catch (err: any) {
    res.status(500).json({ error: 'exec_error', message: err.message });
  }
});

// POST /api/projects/:name/task/resume — Resume a stopped/completed task
router.post('/:name/task/resume', async (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  try {
    // Read current task, update status, write back
    const output = await execInContainer(project.name, ['cat', '/workspace/.task.json']);
    const task = JSON.parse(output);
    task.status = 'running';
    task.completed_at = null;
    task.completion_reason = null;
    const json = JSON.stringify(task, null, 2);
    await execInContainer(project.name, ['bash', '-c', `cat > /workspace/.task.json << 'TASKEOF'\n${json}\nTASKEOF`]);
    res.json({ ok: true, task });
  } catch (err: any) {
    res.status(500).json({ error: 'exec_error', message: err.message });
  }
});

// POST /api/projects/:name/task/stop — Stop a running task
router.post('/:name/task/stop', async (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  try {
    const output = await execInContainer(project.name, ['cat', '/workspace/.task.json']);
    const task = JSON.parse(output);
    task.status = 'stopped';
    task.completed_at = new Date().toISOString();
    task.completion_reason = 'manual_stop';
    const json = JSON.stringify(task, null, 2);
    await execInContainer(project.name, ['bash', '-c', `cat > /workspace/.task.json << 'TASKEOF'\n${json}\nTASKEOF`]);
    res.json({ ok: true, task });
  } catch (err: any) {
    res.status(500).json({ error: 'exec_error', message: err.message });
  }
});

// Task question response

const RespondSchema = z.object({
  question_id: z.string().min(1),
  answer: z.string().min(1),
});

// POST /api/projects/:name/task/respond — Answer an agent question
router.post('/:name/task/respond', async (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  const parsed = RespondSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_error', message: parsed.error.issues[0].message });
    return;
  }

  try {
    const output = await execInContainer(project.name, ['cat', '/workspace/.task.json']);
    const task = JSON.parse(output);

    if (!Array.isArray(task.questions)) {
      res.status(404).json({ error: 'not_found', message: 'No questions in task' });
      return;
    }

    const question = task.questions.find((q: any) => q.id === parsed.data.question_id);
    if (!question) {
      res.status(404).json({ error: 'not_found', message: `Question "${parsed.data.question_id}" not found` });
      return;
    }

    question.answer = parsed.data.answer;
    question.answered_at = new Date().toISOString();

    const json = JSON.stringify(task, null, 2);
    await execInContainer(project.name, ['bash', '-c', `cat > /workspace/.task.json << 'TASKEOF'\n${json}\nTASKEOF`]);
    res.json({ ok: true, task });
  } catch (err: any) {
    res.status(500).json({ error: 'exec_error', message: err.message });
  }
});

// POST /api/projects/:name/message — Send a message to the agent (fire-and-forget)
const MessageSchema = z.object({
  message: z.string().min(1),
});

router.post('/:name/message', async (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  const parsed = MessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_error', message: parsed.error.issues[0].message });
    return;
  }

  const ip = await getContainerIp(project.name);
  if (!ip) {
    res.status(503).json({ error: 'container_unavailable', message: 'Container not running' });
    return;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://${ip}:18789`);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Gateway connection timeout'));
      }, 5000);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'user_message', content: parsed.data.message }));
        clearTimeout(timeout);
        ws.close();
        resolve();
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    res.json({ ok: true, sent: true });
  } catch (err: any) {
    res.status(503).json({ error: 'gateway_error', message: err.message });
  }
});

// GET /api/projects/:name/memory — Read agent memory files
router.get('/:name/memory', async (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  try {
    const [short, long, plan] = await Promise.all([
      execInContainer(project.name, ['cat', '/workspace/SHORT_TERM_MEMORY.md']).catch(() => ''),
      execInContainer(project.name, ['cat', '/workspace/LONG_TERM_MEMORY.md']).catch(() => ''),
      execInContainer(project.name, ['cat', '/workspace/plan.md']).catch(() => ''),
    ]);
    res.json({ short_term: short, long_term: long, plan });
  } catch (err: any) {
    res.status(500).json({ error: 'exec_error', message: err.message });
  }
});

// GET /api/projects/:name/logs — Tail supervisor logs
router.get('/:name/logs', async (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  const lines = parseInt(req.query.lines as string) || 100;

  try {
    const output = await execInContainer(project.name, ['tail', '-n', String(lines), '/tmp/supervisor.log']);
    res.json({ logs: output });
  } catch (err: any) {
    res.status(500).json({ error: 'exec_error', message: err.message });
  }
});

// Secrets CRUD

const SetSecretSchema = z.object({
  key: z.string().min(1).max(128).regex(/^[A-Z_][A-Z0-9_]*$/, 'Key must be uppercase with underscores (e.g. VERCEL_TOKEN)'),
  value: z.string().min(1),
});

// POST /api/projects/:name/secrets — Set a secret
router.post('/:name/secrets', (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  const parsed = SetSecretSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_error', message: parsed.error.issues[0].message });
    return;
  }

  db.insertSecret({
    project_name: project.name,
    key: parsed.data.key,
    value_enc: encrypt(parsed.data.value),
    created_at: new Date().toISOString(),
  });

  res.json({ ok: true, key: parsed.data.key });
});

// GET /api/projects/:name/secrets — List secrets (keys only, no values)
router.get('/:name/secrets', (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  const secrets = db.getSecrets(project.name).map((s) => ({
    key: s.key,
    created_at: s.created_at,
  }));

  res.json({ secrets });
});

// DELETE /api/projects/:name/secrets/:key — Delete a secret
router.delete('/:name/secrets/:key', (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  db.deleteSecret(project.name, req.params.key);
  res.json({ ok: true });
});

export { router as projectsRouter };
