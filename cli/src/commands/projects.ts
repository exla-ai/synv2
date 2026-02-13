import { requireConfig } from '../config.js';
import { ApiClient } from '../api-client.js';

export async function projectsCommand(): Promise<void> {
  const config = requireConfig();
  const api = new ApiClient(config);

  const projects = await api.listProjects();

  if (projects.length === 0) {
    console.log('No projects. Create one with `synapse init <name>`.');
    return;
  }

  // Table header
  const nameWidth = Math.max(20, ...projects.map((p) => p.name.length + 2));
  console.log(
    'NAME'.padEnd(nameWidth) + 'STATUS'.padEnd(12) + 'CREATED'
  );
  console.log('-'.repeat(nameWidth + 12 + 24));

  for (const p of projects) {
    const statusColor = p.status === 'running' ? '\x1b[32m' : p.status === 'error' ? '\x1b[31m' : '\x1b[33m';
    const status = `${statusColor}${p.status}\x1b[0m`;
    const created = new Date(p.created_at).toLocaleString();
    console.log(p.name.padEnd(nameWidth) + status.padEnd(12 + 9) + created);
  }
}
