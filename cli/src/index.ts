import { Command } from 'commander';
import { setupCommand } from './commands/setup.js';
import { projectsCommand } from './commands/projects.js';
import { initCommand } from './commands/init.js';
import { attachCommand } from './commands/attach.js';
import { destroyCommand } from './commands/destroy.js';
import { statusCommand } from './commands/status.js';
import { secretsSetCommand, secretsListCommand, secretsDeleteCommand } from './commands/secrets.js';
import { restartCommand } from './commands/restart.js';

const program = new Command();

program
  .name('synv2')
  .description('Multi-project AI agent platform')
  .version('0.1.0');

program
  .command('setup')
  .description('Provision AWS infrastructure')
  .action(setupCommand);

program
  .command('projects')
  .alias('ls')
  .description('List all projects')
  .action(projectsCommand);

program
  .command('init <name>')
  .description('Create a new project')
  .option('--api-key <key>', 'Anthropic API key (or set ANTHROPIC_API_KEY)')
  .option('--mcp-servers <servers>', 'Comma-separated MCP servers to enable')
  .action(initCommand);

program
  .command('attach <name>')
  .description('Open AI chat session for a project')
  .action(attachCommand);

program
  .command('destroy <name>')
  .description('Tear down a project and its data')
  .option('-f, --force', 'Skip confirmation')
  .action(destroyCommand);

program
  .command('restart <name>')
  .description('Restart a project container (picks up new secrets)')
  .action(restartCommand);

program
  .command('status')
  .description('Show infrastructure health and project status')
  .action(statusCommand);

// Secrets management
const secrets = program
  .command('secrets')
  .description('Manage project secrets (API keys, tokens)');

secrets
  .command('set <project> <key> <value>')
  .description('Set a secret for a project')
  .action(secretsSetCommand);

secrets
  .command('list <project>')
  .alias('ls')
  .description('List secrets for a project')
  .action(secretsListCommand);

secrets
  .command('delete <project> <key>')
  .alias('rm')
  .description('Delete a secret from a project')
  .action(secretsDeleteCommand);

program.parse();
