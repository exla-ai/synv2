import { createInterface } from 'readline';
import { requireConfig } from '../config.js';
import { ApiClient } from '../api-client.js';

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const ALL_MCP_SERVERS = ['filesystem', 'fetch', 'memory', 'github', 'brave-search', 'puppeteer', 'postgres', 'exa'];

export async function initCommand(name: string, opts: { apiKey?: string; mcpServers?: string; interactive?: boolean; instanceType?: string }): Promise<void> {
  const config = requireConfig();
  const api = new ApiClient(config);

  const anthropicApiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    console.error('ANTHROPIC_API_KEY not set. Pass --api-key or set the env var.');
    process.exit(1);
  }

  const mcpServers = opts.mcpServers
    ? opts.mcpServers.split(',').map((s) => s.trim())
    : ALL_MCP_SERVERS;

  console.log(`Creating project "${name}"...`);
  if (opts.instanceType) {
    console.log(`Instance type: ${opts.instanceType} (dedicated worker)`);
  }
  console.log(`MCP servers: ${mcpServers.join(', ')}`);

  try {
    const project = await api.createProject(name, {
      anthropicApiKey,
      mcpServers,
      instanceType: opts.instanceType,
    });

    console.log(`\nProject "${project.name}" created (${project.status}).`);
    if (project.instance_type) {
      console.log(`Instance: ${project.instance_type}${project.worker_instance_id ? ` (${project.worker_instance_id})` : ''}`);
    }
    if (project.status === 'provisioning') {
      console.log('Worker instance is provisioning... This takes ~3 minutes.');
      console.log(`Check status with: synv2 status`);
    }

    // Prompt for secrets
    console.log('\nSet up service tokens (press Enter to skip any):');

    const secretPrompts: [string, string][] = [
      ['VERCEL_TOKEN', 'Vercel token (vercel.com/account/tokens): '],
      ['FLY_API_TOKEN', 'Fly.io token (fly tokens create): '],
      ['SUPABASE_ACCESS_TOKEN', 'Supabase token (supabase.com/dashboard/account/tokens): '],
      ['MODAL_TOKEN_ID', 'Modal token ID (modal token new): '],
      ['MODAL_TOKEN_SECRET', 'Modal token secret: '],
      ['GITHUB_TOKEN', 'GitHub token (github.com/settings/tokens): '],
      ['BRAVE_API_KEY', 'Brave Search API key (brave.com/search/api): '],
      ['EXA_API_KEY', 'Exa API key (exa.ai): '],
      ['DISCORD_BOT_TOKEN', 'Discord bot token (discord.com/developers): '],
    ];

    let secretsSet = 0;
    for (const [key, prompt] of secretPrompts) {
      // Check env var first
      const envVal = process.env[key];
      if (envVal) {
        await api.setSecret(name, key, envVal);
        console.log(`  ${key}: set from env`);
        secretsSet++;
        continue;
      }

      const value = await ask(`  ${prompt}`);
      if (value) {
        await api.setSecret(name, key, value);
        secretsSet++;
      }
    }

    if (secretsSet > 0) {
      console.log(`\n${secretsSet} secret(s) configured. Restarting to apply...`);
      await api.restartProject(name);
      console.log('Project restarted with new secrets.');
    }

    console.log(`\nReady! Attach with: synv2 attach ${name}`);
    console.log(`Add more secrets later: synv2 secrets set ${name} KEY VALUE`);
  } catch (err: any) {
    console.error(`Failed to create project: ${err.message}`);
    process.exit(1);
  }
}
