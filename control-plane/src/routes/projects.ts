import { Router } from 'express';
import { z } from 'zod';
import * as db from '../db/index.js';
import { encrypt } from '../services/secrets.js';
import { createProjectContainer, destroyProjectContainer, restartProjectContainer } from '../services/container-manager.js';
import { getContainerInfo } from '../services/docker.js';

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

  res.json({
    name: project.name,
    status,
    created_at: project.created_at,
    container_id: project.container_id,
    mcp_servers: JSON.parse(project.mcp_servers),
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
