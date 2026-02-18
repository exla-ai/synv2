import * as dockerService from './docker.js';
import { decrypt } from './secrets.js';
import { getProject, updateProject, getSecrets, getWorkerByProject } from '../db/index.js';
import { getInstanceMetadata } from './instance-metadata.js';
import { getWorkerUrl } from './worker-provisioner.js';

const GATEWAY_PORT = 18789;
const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_INTERVAL_MS = 2_000;
const DEFAULT_MEMORY_MB = parseInt(process.env.CONTAINER_MEMORY_MB || '230000');
const DEFAULT_CPUS = parseInt(process.env.CONTAINER_CPUS || '30');

function inferInstanceLimits(instanceType: string | null): { cpus: number; memoryMb: number } | null {
  if (!instanceType) return null;
  const parts = instanceType.split('.');
  if (parts.length < 2) return null;
  const family = parts[0].toLowerCase();
  const size = parts[1].toLowerCase();

  let cpus = 0;
  if (size === 'large') cpus = 2;
  else if (size === 'xlarge') cpus = 4;
  else {
    const m = size.match(/^([0-9]+)xlarge$/);
    if (m) cpus = parseInt(m[1], 10) * 4;
  }
  if (cpus <= 0 || Number.isNaN(cpus)) return null;

  let memPerCpuGb = 2;
  if (family.startsWith('r') || family.startsWith('x')) memPerCpuGb = 8;
  else if (family.startsWith('m')) memPerCpuGb = 4;
  else if (family.startsWith('c') || family.startsWith('t')) memPerCpuGb = 2;

  return { cpus, memoryMb: cpus * memPerCpuGb * 1024 };
}

/** Build the full env var map for a project container */
export async function buildContainerEnv(projectName: string): Promise<Record<string, string>> {
  const project = getProject(projectName);
  if (!project) throw new Error(`Project "${projectName}" not found in database`);

  const env: Record<string, string> = {
    PROJECT_NAME: projectName,
    ANTHROPIC_API_KEY: decrypt(project.anthropic_api_key_enc),
    MCP_SERVERS: project.mcp_servers,
    WORKSPACE: '/workspace',
  };

  // Add project secrets
  const secrets = getSecrets(projectName);
  for (const s of secrets) {
    env[s.key] = decrypt(s.value_enc);
  }

  // Add any extra encrypted env vars
  try {
    const extra = JSON.parse(decrypt(project.env_enc));
    Object.assign(env, extra);
  } catch {
    // no extra env
  }

  // Inject instance metadata so agents know their hardware
  const meta = await getInstanceMetadata();
  const inferred = inferInstanceLimits(project.instance_type);
  const effectiveType = project.instance_type || meta.instanceType;

  // For worker mode (project has explicit instance_type), use the instance's actual
  // resources instead of clamping to defaults — the container IS the whole machine.
  // For local mode (no instance_type), clamp to defaults to share the host.
  const hasExplicitInstance = !!project.instance_type;
  const instanceCpus = inferred?.cpus ?? DEFAULT_CPUS;
  const instanceMemoryMb = inferred?.memoryMb ?? DEFAULT_MEMORY_MB;

  let effectiveCpus: number;
  let effectiveMemoryMb: number;
  if (hasExplicitInstance && inferred) {
    // Worker mode: give container the full instance resources (90% memory for OS overhead)
    effectiveCpus = instanceCpus;
    effectiveMemoryMb = Math.floor(instanceMemoryMb * 0.9);
  } else {
    // Local mode: clamp to defaults
    effectiveCpus = Math.max(1, Math.min(DEFAULT_CPUS, instanceCpus));
    effectiveMemoryMb = Math.max(2048, Math.min(DEFAULT_MEMORY_MB, Math.floor(instanceMemoryMb * 0.9)));
  }

  env.INSTANCE_TYPE = effectiveType;
  env.INSTANCE_CPUS = String(effectiveCpus);
  env.INSTANCE_MEMORY_MB = String(effectiveMemoryMb);
  env.HOST_CPUS = String(inferred?.cpus ?? meta.cpus);
  env.HOST_MEMORY_MB = String(inferred?.memoryMb ?? meta.memoryMb);

  return env;
}

/**
 * Create a project container — either locally or on a worker.
 * If a ready worker exists for this project, delegates to the worker.
 */
export async function createProjectContainer(projectName: string): Promise<string> {
  const env = await buildContainerEnv(projectName);

  // Worker mode: delegate to remote worker
  const workerUrl = getWorkerUrl(projectName);
  if (workerUrl) {
    const worker = getWorkerByProject(projectName)!;
    try {
      const res = await fetch(`${workerUrl}/container/create`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${worker.worker_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ env }),
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'unknown' })) as any;
        throw new Error(err.error || `Worker returned ${res.status}`);
      }

      updateProject(projectName, { status: 'running' });
      return worker.instance_id;
    } catch (err: any) {
      updateProject(projectName, { status: 'error' });
      throw new Error(`Worker container creation failed: ${err.message}`);
    }
  }

  // Local mode: create container on this host via Docker
  const containerId = await dockerService.createContainer({
    name: projectName,
    env,
    memoryMb: parseInt(env.INSTANCE_MEMORY_MB) || DEFAULT_MEMORY_MB,
    cpus: parseInt(env.INSTANCE_CPUS) || DEFAULT_CPUS,
  });

  updateProject(projectName, { container_id: containerId, status: 'running' });

  try {
    await waitForGateway(projectName);
  } catch (err) {
    updateProject(projectName, { status: 'error' });
    throw err;
  }

  return containerId;
}

async function waitForGateway(projectName: string): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    const ip = await dockerService.getContainerIp(projectName);
    if (ip) {
      try {
        const res = await fetch(`http://${ip}:${GATEWAY_PORT}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) return;
      } catch {
        // not ready yet
      }
    }
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
  }

  throw new Error(`Gateway health check timed out for "${projectName}"`);
}

export async function restartProjectContainer(projectName: string): Promise<void> {
  const workerUrl = getWorkerUrl(projectName);

  if (workerUrl) {
    // Worker mode: restart via worker agent
    const worker = getWorkerByProject(projectName)!;
    const env = await buildContainerEnv(projectName);

    updateProject(projectName, { status: 'creating' });

    const res = await fetch(`${workerUrl}/container/restart`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${worker.worker_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ env }),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });

    if (!res.ok) {
      updateProject(projectName, { status: 'error' });
      const err = await res.json().catch(() => ({ error: 'unknown' })) as any;
      throw new Error(err.error || `Worker returned ${res.status}`);
    }

    updateProject(projectName, { status: 'running' });
    return;
  }

  // Local mode
  await dockerService.removeContainer(projectName, false);
  updateProject(projectName, { status: 'creating' });
  await createProjectContainer(projectName);
}

export async function destroyProjectContainer(projectName: string): Promise<void> {
  const workerUrl = getWorkerUrl(projectName);

  if (workerUrl) {
    const worker = getWorkerByProject(projectName)!;
    await fetch(`${workerUrl}/container/destroy`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${worker.worker_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ removeVolume: true }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {});
    return;
  }

  await dockerService.removeContainer(projectName);
}

export async function getGatewayUrl(projectName: string): Promise<string | null> {
  // Worker mode: proxy through worker agent's WS endpoint
  const worker = getWorkerByProject(projectName);
  if (worker && worker.status === 'ready') {
    const ip = worker.private_ip || worker.public_ip;
    if (ip) {
      return `ws://${ip}:18800/gateway?token=${worker.worker_token}`;
    }
  }

  // Local mode: direct to container
  const ip = await dockerService.getContainerIp(projectName);
  if (!ip) return null;
  return `ws://${ip}:${GATEWAY_PORT}`;
}

/**
 * Execute a command inside the project container.
 * Routes through worker if one exists.
 */
export async function execInProjectContainer(projectName: string, cmd: string[]): Promise<string> {
  const workerUrl = getWorkerUrl(projectName);

  if (workerUrl) {
    const worker = getWorkerByProject(projectName)!;
    const res = await fetch(`${workerUrl}/exec`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${worker.worker_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ cmd }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'unknown' })) as any;
      throw new Error(err.error || `Worker exec failed: ${res.status}`);
    }

    const result = await res.json() as any;
    return result.output || '';
  }

  return dockerService.execInContainer(projectName, cmd);
}

/**
 * Write the .task.json file to the project container.
 * Uses the worker's dedicated /task endpoint for worker projects (avoids shell quoting issues with /exec).
 */
export async function writeTaskFile(projectName: string, taskDef: Record<string, unknown>): Promise<void> {
  const workerUrl = getWorkerUrl(projectName);

  if (workerUrl) {
    const worker = getWorkerByProject(projectName)!;
    const res = await fetch(`${workerUrl}/task`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${worker.worker_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(taskDef),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'unknown' })) as any;
      throw new Error(err.error || `Worker task write failed: ${res.status}`);
    }
    return;
  }

  // Local container: use docker exec
  const json = JSON.stringify(taskDef, null, 2);
  await dockerService.execInContainer(projectName, ['bash', '-c', `cat > /workspace/.task.json << 'TASKEOF'\n${json}\nTASKEOF`]);
}

/**
 * Get container health info — routes through worker if one exists.
 */
export async function getContainerHealth(projectName: string): Promise<any | null> {
  const workerUrl = getWorkerUrl(projectName);

  if (workerUrl) {
    const worker = getWorkerByProject(projectName)!;
    try {
      const res = await fetch(`${workerUrl}/container/health`, {
        headers: { 'Authorization': `Bearer ${worker.worker_token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return await res.json();
    } catch {}
    return null;
  }

  // Local mode
  const ip = await dockerService.getContainerIp(projectName);
  if (!ip) return null;
  try {
    const res = await fetch(`http://${ip}:${GATEWAY_PORT}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) return await res.json();
  } catch {}
  return null;
}

/**
 * Control the supervisor process (pause/resume/stop/restart).
 * Routes through worker if one exists, otherwise calls gateway HTTP endpoint directly.
 */
export async function controlSupervisor(projectName: string, action: string): Promise<{ ok: boolean; supervisorFound: boolean }> {
  const workerUrl = getWorkerUrl(projectName);

  if (workerUrl) {
    const worker = getWorkerByProject(projectName)!;
    const res = await fetch(`${workerUrl}/supervisor/control`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${worker.worker_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'unknown' })) as any;
      throw new Error(err.error || `Worker supervisor control failed: ${res.status}`);
    }
    return await res.json() as any;
  }

  // Local mode: call gateway HTTP endpoint directly
  const ip = await dockerService.getContainerIp(projectName);
  if (!ip) throw new Error('Container not running');

  const res = await fetch(`http://${ip}:${GATEWAY_PORT}/supervisor/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Gateway returned ${res.status}`);
  return await res.json() as any;
}

/**
 * Get memory files from the project container.
 */
export async function getProjectMemory(projectName: string): Promise<{ short_term: string; long_term: string; plan: string }> {
  const workerUrl = getWorkerUrl(projectName);

  if (workerUrl) {
    const worker = getWorkerByProject(projectName)!;
    const res = await fetch(`${workerUrl}/memory`, {
      headers: { 'Authorization': `Bearer ${worker.worker_token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Worker memory read failed: ${res.status}`);
    return await res.json() as any;
  }

  const [short, long, plan] = await Promise.all([
    dockerService.execInContainer(projectName, ['cat', '/workspace/SHORT_TERM_MEMORY.md']).catch(() => ''),
    dockerService.execInContainer(projectName, ['cat', '/workspace/LONG_TERM_MEMORY.md']).catch(() => ''),
    dockerService.execInContainer(projectName, ['cat', '/workspace/plan.md']).catch(() => ''),
  ]);
  return { short_term: short, long_term: long, plan };
}

/**
 * Get supervisor logs from the project container.
 */
export async function getProjectLogs(projectName: string, lines: number): Promise<string> {
  const workerUrl = getWorkerUrl(projectName);

  if (workerUrl) {
    const worker = getWorkerByProject(projectName)!;
    const res = await fetch(`${workerUrl}/logs?lines=${lines}`, {
      headers: { 'Authorization': `Bearer ${worker.worker_token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Worker logs read failed: ${res.status}`);
    const data = await res.json() as any;
    return data.logs || '';
  }

  return dockerService.execInContainer(projectName, ['tail', '-n', String(lines), '/workspace/.supervisor.log']);
}

/**
 * Send a message to the agent, routing through worker if needed.
 */
export async function sendMessageToAgent(projectName: string, message: string): Promise<void> {
  const workerUrl = getWorkerUrl(projectName);

  if (workerUrl) {
    const worker = getWorkerByProject(projectName)!;
    const res = await fetch(`${workerUrl}/message`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${worker.worker_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Worker message send failed: ${res.status}`);
    return;
  }

  // Local mode — handled by the existing route in projects.ts
  throw new Error('Use local gateway for messaging');
}
