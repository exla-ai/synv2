import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const server = new McpServer({
  name: 'synv2',
  version: '0.1.0',
});

registerTools(server, config);

const transport = new StdioServerTransport();
await server.connect(transport);
