// Generates openclaw.json with MCP servers configured from MCP_SERVERS env var
// MCP_SERVERS is a JSON array of server names, e.g. '["filesystem","github","fetch"]'
// If not set, defaults to filesystem + fetch

const { readFileSync, writeFileSync } = require('fs');
const { join } = require('path');

const home = process.env.OPENCLAW_HOME || join(process.env.HOME || '/home/app', '.openclaw');
const configPath = join(home, 'openclaw.json');

let config = {};
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch {
  // fresh config
}

// Auto-approve exec in headless mode
config.tools = Object.assign(config.tools || {}, {
  profile: 'full',
  exec: { security: 'full', ask: 'off' },
});

// Disable sandbox for headless operation
config.agents = config.agents || {};
config.agents.defaults = Object.assign(config.agents.defaults || {}, {
  sandbox: { mode: 'off' },
});

// MCP server definitions
const MCP_REGISTRY = {
  filesystem: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', process.env.WORKSPACE || '/workspace'],
  },
  github: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN || '' },
  },
  postgres: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', process.env.DATABASE_URL || ''],
  },
  fetch: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
  },
  'brave-search': {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: process.env.BRAVE_API_KEY || '' },
  },
  puppeteer: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
  },
  memory: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  },
};

// Parse MCP_SERVERS env var
let serverNames = ['filesystem', 'fetch']; // defaults
try {
  const parsed = JSON.parse(process.env.MCP_SERVERS || '[]');
  if (Array.isArray(parsed) && parsed.length > 0) {
    serverNames = parsed;
  }
} catch {
  // use defaults
}

// Build mcpServers config
config.mcpServers = {};
for (const name of serverNames) {
  const def = MCP_REGISTRY[name];
  if (def) {
    config.mcpServers[name] = def;
  } else {
    console.warn(`Unknown MCP server: ${name}, skipping`);
  }
}

writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log(`OpenClaw configured with MCP servers: ${serverNames.join(', ')}`);
