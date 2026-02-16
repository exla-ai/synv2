import { requireConfig } from '../config.js';
import { ApiClient } from '../api-client.js';

export async function execCommand(name: string, cmd: string[]): Promise<void> {
  if (cmd.length === 0) {
    console.error('No command specified. Usage: synv2 exec <project> -- <command...>');
    process.exit(1);
  }

  const config = requireConfig();
  const api = new ApiClient(config);

  try {
    const result = await api.exec(name, cmd);
    if (result.output) {
      process.stdout.write(result.output);
    }
  } catch (err: any) {
    console.error(`Exec failed: ${err.message}`);
    process.exit(1);
  }
}
