import { Router } from 'express';
import { z } from 'zod';
import * as db from '../db/index.js';
import { encrypt } from '../services/secrets.js';
import {
  createProjectContainer,
  destroyProjectContainer,
  restartProjectContainer,
  getContainerHealth,
  execInProjectContainer,
  writeTaskFile,
  getProjectMemory,
  getProjectLogs,
  sendMessageToAgent,
  controlSupervisor,
} from '../services/container-manager.js';
import { getContainerInfo, getContainerIp } from '../services/docker.js';
import { provisionWorker, terminateWorker, resizeWorker, getWorkerUrl } from '../services/worker-provisioner.js';

const router = Router();

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, 'Name must be lowercase alphanumeric with dashes'),
  anthropicApiKey: z.string().min(1),
  mcpServers: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  instanceType: z.string().optional(),
});

// POST /api/projects — Create a new project
router.post('/', async (req, res) => {
  const parsed = CreateProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_error', message: parsed.error.issues[0].message });
    return;
  }

  const { name, anthropicApiKey, mcpServers, env, instanceType } = parsed.data;

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
    instance_type: instanceType || 't3.medium',
    worker_instance_id: null,
    created_at: new Date().toISOString(),
  });

  try {
    // If instanceType is specified, provision a dedicated worker
    if (instanceType) {
      const instanceId = await provisionWorker(name, instanceType);

      // Return immediately — worker provisioning happens in background
      const project = db.getProject(name)!;
      res.status(201).json({
        name: project.name,
        status: 'provisioning',
        created_at: project.created_at,
        instance_type: instanceType,
        worker_instance_id: instanceId,
        mcp_servers: JSON.parse(project.mcp_servers),
      });
      return;
    }

    // No instanceType — create container locally (legacy behavior)
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
      // Check worker status if this project has a worker
      const worker = db.getWorkerByProject(p.name);
      if (worker) {
        return {
          name: p.name,
          status: worker.status === 'ready' ? (p.status === 'running' ? 'running' : p.status) : worker.status,
          created_at: p.created_at,
          instance_type: p.instance_type,
          worker_instance_id: worker.instance_id,
          mcp_servers: JSON.parse(p.mcp_servers),
        };
      }

      // Sync status with Docker for local containers
      const container = await getContainerInfo(p.name);
      const actualStatus = container ? container.status : p.status === 'creating' ? 'creating' : 'stopped';
      if (actualStatus !== p.status) {
        db.updateProject(p.name, { status: actualStatus });
      }
      return {
        name: p.name,
        status: actualStatus,
        created_at: p.created_at,
        instance_type: p.instance_type,
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

  const worker = db.getWorkerByProject(project.name);

  // Get health/task info via worker or local container
  let task = null;
  let health = null;
  let status = project.status;

  if (worker) {
    health = await getContainerHealth(project.name);
    task = health?.task || null;
    if (worker.status === 'ready' && project.status === 'running') {
      status = 'running';
    } else if (worker.status !== 'ready') {
      status = worker.status;
    }
  } else {
    const container = await getContainerInfo(project.name);
    status = container ? container.status : project.status;

    if (container && container.ip) {
      try {
        const healthRes = await fetch(`http://${container.ip}:18789/health`, {
          signal: AbortSignal.timeout(3000),
        });
        if (healthRes.ok) {
          health = await healthRes.json() as any;
          task = health.task || null;
        }
      } catch {}
    }
  }

  res.json({
    name: project.name,
    status,
    created_at: project.created_at,
    container_id: project.container_id,
    instance_type: project.instance_type,
    worker_instance_id: project.worker_instance_id,
    mcp_servers: JSON.parse(project.mcp_servers),
    task,
    instance: health?.instance || null,
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

    // Terminate worker if one exists
    const worker = db.getWorkerByProject(project.name);
    if (worker && worker.status !== 'terminated') {
      await terminateWorker(worker.instance_id);
    }

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

// POST /api/projects/:name/resize — Resize a project's worker instance
const ResizeSchema = z.object({
  instanceType: z.string().min(1),
});

router.post('/:name/resize', async (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  const parsed = ResizeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_error', message: parsed.error.issues[0].message });
    return;
  }

  const worker = db.getWorkerByProject(project.name);
  if (!worker) {
    res.status(400).json({ error: 'no_worker', message: 'Project does not have a dedicated worker. Destroy and recreate with --instance-type.' });
    return;
  }

  try {
    // Destroy container first (keeps workspace volume)
    await destroyProjectContainer(project.name);
    db.updateProject(project.name, { status: 'resizing' as any });

    // Resize the EC2 instance (stop → change type → start)
    await resizeWorker(worker.instance_id, parsed.data.instanceType);

    // Recreate container on resized worker
    await createProjectContainer(project.name);

    res.json({ ok: true, instanceType: parsed.data.instanceType });
  } catch (err: any) {
    res.status(500).json({ error: 'resize_error', message: err.message });
  }
});

// POST /api/projects/:name/exec — Execute a command in the project container
const ExecSchema = z.object({
  cmd: z.array(z.string()).min(1),
  timeout: z.number().optional(),
});

router.post('/:name/exec', async (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  const parsed = ExecSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_error', message: parsed.error.issues[0].message });
    return;
  }

  try {
    const output = await execInProjectContainer(project.name, parsed.data.cmd);
    res.json({ ok: true, output });
  } catch (err: any) {
    res.status(500).json({ error: 'exec_error', message: err.message });
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
    await writeTaskFile(project.name, taskDef);
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
    let output: string;
    try {
      output = await execInProjectContainer(project.name, ['cat', '/workspace/.task.json']);
    } catch {
      res.status(404).json({ error: 'no_task', message: "No task file found. Use 'supervisor stop' to control the supervisor directly." });
      return;
    }

    let task: any;
    try {
      task = JSON.parse(output);
    } catch {
      res.status(422).json({ error: 'invalid_task', message: 'Task file contains invalid JSON' });
      return;
    }

    task.status = 'running';
    task.completed_at = null;
    task.completion_reason = null;
    await writeTaskFile(project.name, task);
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
    let output: string;
    try {
      output = await execInProjectContainer(project.name, ['cat', '/workspace/.task.json']);
    } catch {
      res.status(404).json({ error: 'no_task', message: "No task file found. Use 'supervisor stop' to control the supervisor directly." });
      return;
    }

    let task: any;
    try {
      task = JSON.parse(output);
    } catch {
      res.status(422).json({ error: 'invalid_task', message: 'Task file contains invalid JSON' });
      return;
    }

    task.status = 'stopped';
    task.completed_at = new Date().toISOString();
    task.completion_reason = 'manual_stop';
    await writeTaskFile(project.name, task);
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
    let output: string;
    try {
      output = await execInProjectContainer(project.name, ['cat', '/workspace/.task.json']);
    } catch {
      res.status(404).json({ error: 'no_task', message: "No task file found. Use 'supervisor stop' to control the supervisor directly." });
      return;
    }

    let task: any;
    try {
      task = JSON.parse(output);
    } catch {
      res.status(422).json({ error: 'invalid_task', message: 'Task file contains invalid JSON' });
      return;
    }

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

    await writeTaskFile(project.name, task);
    res.json({ ok: true, task });
  } catch (err: any) {
    res.status(500).json({ error: 'exec_error', message: err.message });
  }
});

// POST /api/projects/:name/directives — Set an operator directive
const SetDirectiveSchema = z.object({
  instruction: z.string().min(1),
  id: z.string().optional(),
  persistent: z.boolean().optional(),
});

router.post('/:name/directives', async (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  const parsed = SetDirectiveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_error', message: parsed.error.issues[0].message });
    return;
  }

  try {
    // Read existing directives
    let directives: any[] = [];
    try {
      const raw = await execInProjectContainer(project.name, ['cat', '/workspace/.operator-directives.json']);
      directives = JSON.parse(raw);
      if (!Array.isArray(directives)) directives = [];
    } catch {
      // File doesn't exist or invalid — start fresh
    }

    const directive = {
      id: parsed.data.id || `d_${Date.now()}`,
      instruction: parsed.data.instruction,
      persistent: parsed.data.persistent !== false,
      created_at: new Date().toISOString(),
    };

    // Replace if same id exists, otherwise append
    const idx = directives.findIndex((d: any) => d.id === directive.id);
    if (idx >= 0) {
      directives[idx] = directive;
    } else {
      directives.push(directive);
    }

    const json = JSON.stringify(directives, null, 2);
    await execInProjectContainer(project.name, ['bash', '-c', `cat > /workspace/.operator-directives.json << 'DIREOF'\n${json}\nDIREOF`]);
    res.status(201).json({ ok: true, directive });
  } catch (err: any) {
    res.status(500).json({ error: 'exec_error', message: err.message });
  }
});

// GET /api/projects/:name/directives — List all directives
router.get('/:name/directives', async (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  try {
    let directives: any[] = [];
    try {
      const raw = await execInProjectContainer(project.name, ['cat', '/workspace/.operator-directives.json']);
      directives = JSON.parse(raw);
      if (!Array.isArray(directives)) directives = [];
    } catch {
      // No directives file
    }
    res.json({ directives });
  } catch (err: any) {
    res.status(500).json({ error: 'exec_error', message: err.message });
  }
});

// DELETE /api/projects/:name/directives/:id — Remove a directive
router.delete('/:name/directives/:id', async (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  try {
    let directives: any[] = [];
    try {
      const raw = await execInProjectContainer(project.name, ['cat', '/workspace/.operator-directives.json']);
      directives = JSON.parse(raw);
      if (!Array.isArray(directives)) directives = [];
    } catch {
      res.status(404).json({ error: 'not_found', message: 'No directives file found' });
      return;
    }

    const before = directives.length;
    directives = directives.filter((d: any) => d.id !== req.params.id);

    if (directives.length === before) {
      res.status(404).json({ error: 'not_found', message: `Directive "${req.params.id}" not found` });
      return;
    }

    const json = JSON.stringify(directives, null, 2);
    await execInProjectContainer(project.name, ['bash', '-c', `cat > /workspace/.operator-directives.json << 'DIREOF'\n${json}\nDIREOF`]);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: 'exec_error', message: err.message });
  }
});

// POST /api/projects/:name/supervisor — Control the supervisor (pause/resume/stop/restart)
const SupervisorControlSchema = z.object({
  action: z.enum(['pause', 'resume', 'stop', 'restart']),
});

router.post('/:name/supervisor', async (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  const parsed = SupervisorControlSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_error', message: parsed.error.issues[0].message });
    return;
  }

  try {
    const result = await controlSupervisor(project.name, parsed.data.action);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: 'supervisor_error', message: err.message });
  }
});

// GET /api/projects/:name/processes — Get running processes, memory, disk, tmux
router.get('/:name/processes', async (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  try {
    const [processes, memory, disk, tmux] = await Promise.all([
      execInProjectContainer(project.name, ['ps', 'aux', '--sort=-pcpu']).catch(() => ''),
      execInProjectContainer(project.name, ['free', '-m']).catch(() => ''),
      execInProjectContainer(project.name, ['df', '-h', '/workspace']).catch(() => ''),
      execInProjectContainer(project.name, ['bash', '-c', 'tmux ls 2>/dev/null || echo "no tmux sessions"']).catch(() => ''),
    ]);
    res.json({ processes, memory, disk, tmux_sessions: tmux });
  } catch (err: any) {
    res.status(500).json({ error: 'exec_error', message: err.message });
  }
});

// POST /api/projects/:name/message — Send a message to the agent
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

  // Try worker-based messaging first
  const workerUrl = getWorkerUrl(project.name);
  if (workerUrl) {
    try {
      await sendMessageToAgent(project.name, parsed.data.message);
      res.json({ ok: true, sent: true });
    } catch (err: any) {
      res.status(503).json({ error: 'gateway_error', message: err.message });
    }
    return;
  }

  // Local mode: use gateway's HTTP send-message endpoint for delivery confirmation
  const ip = await getContainerIp(project.name);
  if (!ip) {
    res.status(503).json({ error: 'container_unavailable', message: 'Container not running' });
    return;
  }

  try {
    const gwRes = await fetch(`http://${ip}:18789/send-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: parsed.data.message }),
      signal: AbortSignal.timeout(5000),
    });
    const gwData = await gwRes.json() as any;
    res.json({ ok: true, delivered: gwData.delivered, agentBusy: gwData.agentBusy });
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
    const memory = await getProjectMemory(project.name);
    res.json(memory);
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
    const logs = await getProjectLogs(project.name, lines);
    res.json({ logs });
  } catch (err: any) {
    res.status(500).json({ error: 'exec_error', message: err.message });
  }
});

// Worker heartbeat endpoint
router.post('/:name/heartbeat', (req, res) => {
  // Workers call this periodically — find worker by project name and update heartbeat
  const worker = db.getWorkerByProject(req.params.name);
  if (!worker) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  db.updateWorker(worker.instance_id, { last_heartbeat: new Date().toISOString() });
  res.json({ ok: true });
});

// GET /api/projects/:name/worker — Get worker details
router.get('/:name/worker', (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) {
    res.status(404).json({ error: 'not_found', message: 'Project not found' });
    return;
  }

  const worker = db.getWorkerByProject(project.name);
  if (!worker) {
    res.json({ worker: null });
    return;
  }

  res.json({
    worker: {
      instance_id: worker.instance_id,
      instance_type: worker.instance_type,
      status: worker.status,
      private_ip: worker.private_ip,
      region: worker.region,
      availability_zone: worker.availability_zone,
      created_at: worker.created_at,
      last_heartbeat: worker.last_heartbeat,
    },
  });
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
