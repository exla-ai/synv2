import { requireConfig } from '../config.js';
import { ApiClient } from '../api-client.js';

export async function psCommand(name: string): Promise<void> {
  const config = requireConfig();
  const api = new ApiClient(config);

  try {
    const result = await api.getProcesses(name);

    console.log('=== Processes (by CPU) ===');
    console.log(result.processes || '(none)');
    console.log('\n=== Memory ===');
    console.log(result.memory || '(unavailable)');
    console.log('\n=== Disk ===');
    console.log(result.disk || '(unavailable)');
    console.log('\n=== Tmux Sessions ===');
    console.log(result.tmux_sessions || '(none)');
  } catch (err: any) {
    console.error(`Failed to get processes: ${err.message}`);
    process.exit(1);
  }
}
