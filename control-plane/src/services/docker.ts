import Dockerode from 'dockerode';

const docker = new Dockerode({ socketPath: '/var/run/docker.sock' });

const NETWORK_NAME = 'synapse-net';
const IMAGE_NAME = 'synapse-project';
const LABEL_PREFIX = 'synapse.project';

export interface ContainerInfo {
  id: string;
  name: string;
  status: string;
  ip?: string;
}

async function ensureNetwork(): Promise<void> {
  const networks = await docker.listNetworks({ filters: { name: [NETWORK_NAME] } });
  if (networks.length === 0) {
    await docker.createNetwork({ Name: NETWORK_NAME, Driver: 'bridge' });
  }
}

export async function createContainer(opts: {
  name: string;
  env: Record<string, string>;
  memoryMb?: number;
  cpus?: number;
}): Promise<string> {
  await ensureNetwork();

  const volumeName = `synapse-${opts.name}-workspace`;
  const envArray = Object.entries(opts.env).map(([k, v]) => `${k}=${v}`);

  const container = await docker.createContainer({
    Image: IMAGE_NAME,
    name: `synapse-${opts.name}`,
    Env: envArray,
    Labels: {
      [LABEL_PREFIX]: opts.name,
    },
    HostConfig: {
      Memory: (opts.memoryMb || 2048) * 1024 * 1024,
      NanoCpus: (opts.cpus || 2) * 1e9,
      Binds: [`${volumeName}:/workspace`],
      NetworkMode: NETWORK_NAME,
      RestartPolicy: { Name: 'unless-stopped' },
    },
    ExposedPorts: {
      '18789/tcp': {},
    },
  });

  // Ensure volume exists
  try {
    await docker.createVolume({ Name: volumeName });
  } catch {
    // volume already exists
  }

  await container.start();
  return container.id;
}

export async function removeContainer(name: string, removeVolume = true): Promise<void> {
  const containerName = `synapse-${name}`;
  try {
    const container = docker.getContainer(containerName);
    try {
      await container.stop({ t: 5 });
    } catch {
      // already stopped
    }
    await container.remove({ force: true });
  } catch {
    // container not found
  }

  if (removeVolume) {
    try {
      const volume = docker.getVolume(`synapse-${name}-workspace`);
      await volume.remove();
    } catch {
      // volume not found or in use
    }
  }
}

export async function getContainerInfo(name: string): Promise<ContainerInfo | null> {
  const containerName = `synapse-${name}`;
  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();
    const ip = info.NetworkSettings.Networks?.[NETWORK_NAME]?.IPAddress;
    return {
      id: info.Id,
      name: info.Name.replace(/^\//, ''),
      status: info.State.Running ? 'running' : 'stopped',
      ip,
    };
  } catch {
    return null;
  }
}

export async function listContainers(): Promise<ContainerInfo[]> {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [LABEL_PREFIX] },
  });

  return containers.map((c) => ({
    id: c.Id,
    name: c.Labels[LABEL_PREFIX] || c.Names[0].replace(/^\/synapse-/, ''),
    status: c.State === 'running' ? 'running' : 'stopped',
  }));
}

export async function getContainerIp(name: string): Promise<string | null> {
  const info = await getContainerInfo(name);
  return info?.ip || null;
}

export async function getDockerStats(): Promise<{ containers_running: number; containers_total: number }> {
  const containers = await docker.listContainers({ all: true, filters: { label: [LABEL_PREFIX] } });
  const running = containers.filter((c) => c.State === 'running').length;
  return { containers_running: running, containers_total: containers.length };
}

export { docker, NETWORK_NAME, IMAGE_NAME };
