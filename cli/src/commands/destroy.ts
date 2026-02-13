import { createInterface } from 'readline';
import { requireConfig } from '../config.js';
import { ApiClient } from '../api-client.js';

export async function destroyCommand(name: string, opts: { force?: boolean }): Promise<void> {
  const config = requireConfig();
  const api = new ApiClient(config);

  if (!opts.force) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`Destroy project "${name}" and all its data? [y/N] `, resolve);
    });
    rl.close();

    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }
  }

  console.log(`Destroying project "${name}"...`);

  try {
    await api.deleteProject(name);
    console.log(`Project "${name}" destroyed.`);
  } catch (err: any) {
    console.error(`Failed to destroy project: ${err.message}`);
    process.exit(1);
  }
}
