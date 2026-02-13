import * as dockerService from './docker.js';
import { decrypt } from './secrets.js';
import { getProject, updateProject, getSecrets } from '../db/index.js';

const GATEWAY_PORT = 18789;
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 2_000;

export async function createProjectContainer(projectName: string): Promise<string> {
  const project = getProject(projectName);
  if (!project) throw new Error(`Project "${projectName}" not found in database`);

  // Build environment variables
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

  // Create and start the container
  const containerId = await dockerService.createContainer({
    name: projectName,
    env,
    memoryMb: 2048,
    cpus: 2,
  });

  updateProject(projectName, { container_id: containerId, status: 'running' });

  // Wait for the OpenClaw gateway to be healthy
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
  // Destroy old container (but keep the volume)
  await dockerService.removeContainer(projectName, false);
  updateProject(projectName, { status: 'creating' });

  // Recreate with fresh env (picks up new secrets)
  await createProjectContainer(projectName);
}

export async function destroyProjectContainer(projectName: string): Promise<void> {
  await dockerService.removeContainer(projectName);
}

export async function getGatewayUrl(projectName: string): Promise<string | null> {
  const ip = await dockerService.getContainerIp(projectName);
  if (!ip) return null;
  return `ws://${ip}:${GATEWAY_PORT}`;
}
