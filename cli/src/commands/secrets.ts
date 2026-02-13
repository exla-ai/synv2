import { requireConfig } from '../config.js';
import { ApiClient } from '../api-client.js';

export async function secretsSetCommand(project: string, key: string, value: string): Promise<void> {
  const config = requireConfig();
  const api = new ApiClient(config);

  try {
    await api.setSecret(project, key, value);
    console.log(`Secret "${key}" set for project "${project}".`);
    console.log(`Restart the project to apply: synv2 restart ${project}`);
  } catch (err: any) {
    console.error(`Failed to set secret: ${err.message}`);
    process.exit(1);
  }
}

export async function secretsListCommand(project: string): Promise<void> {
  const config = requireConfig();
  const api = new ApiClient(config);

  try {
    const secrets = await api.listSecrets(project);
    if (secrets.length === 0) {
      console.log(`No secrets set for "${project}".`);
      return;
    }
    console.log(`Secrets for "${project}":\n`);
    for (const s of secrets) {
      console.log(`  ${s.key.padEnd(30)} (set ${new Date(s.created_at).toLocaleDateString()})`);
    }
  } catch (err: any) {
    console.error(`Failed to list secrets: ${err.message}`);
    process.exit(1);
  }
}

export async function secretsDeleteCommand(project: string, key: string): Promise<void> {
  const config = requireConfig();
  const api = new ApiClient(config);

  try {
    await api.deleteSecret(project, key);
    console.log(`Secret "${key}" deleted from project "${project}".`);
  } catch (err: any) {
    console.error(`Failed to delete secret: ${err.message}`);
    process.exit(1);
  }
}
