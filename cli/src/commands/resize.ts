import { requireConfig } from '../config.js';
import { ApiClient } from '../api-client.js';

export async function resizeCommand(name: string, instanceType: string): Promise<void> {
  const config = requireConfig();
  const api = new ApiClient(config);

  console.log(`Resizing "${name}" to ${instanceType}...`);
  console.log('This will stop the container, resize the EC2 instance, and restart.');
  console.log('Workspace data is preserved.\n');

  try {
    const result = await api.resizeProject(name, instanceType);
    console.log(`Resized to ${result.instanceType}.`);
    console.log('Project container is restarting on the new instance.');
  } catch (err: any) {
    console.error(`Failed to resize: ${err.message}`);
    process.exit(1);
  }
}
