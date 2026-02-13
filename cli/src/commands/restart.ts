import { requireConfig } from '../config.js';
import { ApiClient } from '../api-client.js';

export async function restartCommand(name: string): Promise<void> {
  const config = requireConfig();
  const api = new ApiClient(config);

  console.log(`Restarting project "${name}"...`);

  try {
    await api.restartProject(name);
    console.log(`Project "${name}" restarted.`);
  } catch (err: any) {
    console.error(`Failed to restart: ${err.message}`);
    process.exit(1);
  }
}
