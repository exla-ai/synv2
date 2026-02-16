import { requireConfig } from '../config.js';
import { ApiClient } from '../api-client.js';

export async function directiveSetCommand(project: string, instruction: string, opts: { id?: string }): Promise<void> {
  const config = requireConfig();
  const api = new ApiClient(config);

  try {
    const result = await api.setDirective(project, instruction, opts.id);
    console.log(`Directive set: ${result.directive.id}`);
    console.log(`  "${result.directive.instruction}"`);
  } catch (err: any) {
    console.error(`Failed to set directive: ${err.message}`);
    process.exit(1);
  }
}

export async function directiveListCommand(project: string): Promise<void> {
  const config = requireConfig();
  const api = new ApiClient(config);

  try {
    const result = await api.listDirectives(project);
    if (result.directives.length === 0) {
      console.log(`No directives set for "${project}".`);
      return;
    }
    console.log(`Directives for "${project}":\n`);
    for (const d of result.directives) {
      console.log(`  [${d.id}] ${d.instruction}`);
      console.log(`    Created: ${d.created_at}`);
    }
  } catch (err: any) {
    console.error(`Failed to list directives: ${err.message}`);
    process.exit(1);
  }
}

export async function directiveDeleteCommand(project: string, id: string): Promise<void> {
  const config = requireConfig();
  const api = new ApiClient(config);

  try {
    await api.deleteDirective(project, id);
    console.log(`Directive "${id}" deleted.`);
  } catch (err: any) {
    console.error(`Failed to delete directive: ${err.message}`);
    process.exit(1);
  }
}
