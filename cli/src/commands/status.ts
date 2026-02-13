import { requireConfig } from '../config.js';
import { ApiClient } from '../api-client.js';

export async function statusCommand(): Promise<void> {
  const config = requireConfig();
  const api = new ApiClient(config);

  try {
    const status = await api.getStatus();

    console.log('Synv2 Status\n');
    console.log(`Host:       ${config.host}`);
    console.log(`Region:     ${config.region || 'unknown'}`);
    console.log(`Uptime:     ${formatUptime(status.uptime)}`);
    console.log('');
    console.log('System');
    console.log(`  Memory:   ${status.system.memory_used_mb}MB / ${status.system.memory_total_mb}MB`);
    console.log(`  Disk:     ${status.system.disk_used_gb}GB / ${status.system.disk_total_gb}GB`);
    console.log('');
    console.log('Docker');
    console.log(`  Running:  ${status.docker.containers_running}`);
    console.log(`  Total:    ${status.docker.containers_total}`);
    console.log('');

    if (status.projects.length > 0) {
      console.log('Projects');
      for (const p of status.projects) {
        const statusColor = p.status === 'running' ? '\x1b[32m' : '\x1b[33m';
        console.log(`  ${p.name.padEnd(20)} ${statusColor}${p.status}\x1b[0m`);
      }
    } else {
      console.log('No projects running.');
    }
  } catch (err: any) {
    console.error(`Failed to get status: ${err.message}`);
    process.exit(1);
  }
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
