# synv2 MCP Server

MCP (Model Context Protocol) server that exposes synv2 project management as tools for Claude Code. Monitor, control, and interact with your running AI agents directly from Claude Code conversations.

## Architecture

```
Claude Code (local)
  | STDIO (JSON-RPC)
synv2 MCP Server (local process)
  | HTTPS + Bearer token
Control Plane (EC2 :4000)
  | Docker API / internal HTTP / WS
Project Containers (isolated)
```

- **One MCP server, all projects.** The server routes all requests through the control plane API using the same auth as the CLI.
- **STDIO transport.** Claude Code launches the server as a subprocess and communicates via stdin/stdout JSON-RPC.
- **Reads `~/.synv2/config.json`** for host + token (same config file the `synv2` CLI uses).

## Prerequisites

- Node.js 22+
- A configured synv2 instance (`synv2 setup` already run, `~/.synv2/config.json` exists)
- pnpm (for building)

## Setup

### 1. Install dependencies and build

```bash
cd mcp-server
pnpm install
pnpm build
```

This compiles TypeScript to `build/`.

### 2. Register with Claude Code

Create or edit `.mcp.json` in your project root (already done if you cloned this repo):

```json
{
  "mcpServers": {
    "synv2": {
      "command": "node",
      "args": ["/path/to/synv2/mcp-server/build/index.js"]
    }
  }
}
```

Or add to your global `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "synv2": {
      "command": "node",
      "args": ["/path/to/synv2/mcp-server/build/index.js"]
    }
  }
}
```

### 3. Restart Claude Code

Restart Claude Code (or use `/mcp` to reload MCP servers). The 9 synv2 tools will appear in the tool list.

## Tools Reference

### `list_projects`

List all synv2 projects and their current status.

**Parameters:** None

**Returns:** Array of projects with name, status (`running`/`stopped`/`creating`/`error`), creation date, and configured MCP servers.

**Example prompt:** "List my synv2 projects"

---

### `get_project_status`

Get detailed status of a specific project including task progress, pending questions, and agent metrics.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project` | string | Yes | Project name |

**Returns:** Project details plus current task status from the container gateway: task name, status, turns completed, latest metric, pending questions, and whether the agent is blocked.

**Example prompt:** "Check on hutter-prize" or "What's the status of roamny?"

---

### `send_message`

Send a message to a project's agent. **Fire-and-forget** — does not wait for the agent's response since turns can take minutes. Use `get_project_status` or `get_agent_memory` to check results later.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project` | string | Yes | Project name |
| `message` | string | Yes | Message to send to the agent |

**Returns:** Confirmation that the message was sent.

**How it works:** Opens a temporary WebSocket to the container's gateway, sends the message, and closes. The message enters the shared OpenClaw session — the supervisor and any attached humans will see the agent's response.

**Example prompt:** "Tell hutter-prize to focus on the dictionary encoder next"

---

### `create_task`

Create or replace the task definition for a project. Tasks define what the autonomous supervisor agent works on.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project` | string | Yes | Project name |
| `name` | string | Yes | Task name |
| `description` | string | No | What the task is about |
| `type` | `"measurable"` \| `"subjective"` | No | Default: `"subjective"` |
| `goal_description` | string | No | Human-readable goal |
| `goal_verify_command` | string | No | Shell command to check completion |
| `goal_target_value` | number | No | Numeric target (for measurable tasks) |
| `goal_direction` | `"above"` \| `"below"` | No | Whether metric should be above or below target |
| `max_idle_turns` | number | No | Max turns with no progress (default: 20) |
| `max_turns` | number | No | Max total turns |
| `system_prompt_prepend` | string | No | Text to prepend to agent's system prompt |
| `system_prompt_append` | string | No | Text to append to agent's system prompt |

**Returns:** The full task definition that was written to the container.

**Example prompt:** "Create a task for hutter-prize to optimize the compressor to get below 110MB"

---

### `stop_task`

Stop the currently running task for a project. The supervisor will stop sending prompts.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project` | string | Yes | Project name |

**Example prompt:** "Stop hutter-prize's task"

---

### `resume_task`

Resume a stopped or completed task. Resets the task status to `running` so the supervisor picks it back up.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project` | string | Yes | Project name |

**Example prompt:** "Resume the hutter-prize task"

---

### `respond_to_question`

Answer a question that the agent has asked. Questions can be:
- **blocking** — the agent is paused waiting for an answer
- **non-blocking** — informational, agent continues working

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project` | string | Yes | Project name |
| `question_id` | string | Yes | ID of the question (from `get_project_status`) |
| `answer` | string | Yes | Your answer |

**Example prompt:** "Answer hutter-prize's question: yes, use the LZ4 backend"

---

### `get_agent_memory`

Read the agent's memory files. These files persist across context compactions and provide continuity for long-running agents.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project` | string | Yes | Project name |

**Returns:**
- `short_term` — `SHORT_TERM_MEMORY.md`: Recent context, current focus, immediate state
- `long_term` — `LONG_TERM_MEMORY.md`: Accumulated knowledge, lessons learned, key decisions
- `plan` — `plan.md`: Current execution plan and strategy

**Example prompt:** "What's roamny's memory look like?" or "What has hutter-prize learned so far?"

---

### `get_agent_logs`

Get recent supervisor log output. Shows autonomous agent activity including turn starts/ends, state transitions, errors, and timing.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project` | string | Yes | Project name |
| `lines` | number | No | Number of log lines (default: 100) |

**Example prompt:** "Show me hutter-prize's logs" or "Get the last 50 lines of roamny's supervisor log"

## Control Plane Endpoints

The MCP server relies on the following control plane API endpoints. The first 6 existed before; the last 3 were added for MCP support:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/projects` | GET | List all projects |
| `/api/projects/:name` | GET | Project details + task status |
| `/api/projects/:name/task` | POST | Create/replace task |
| `/api/projects/:name/task/stop` | POST | Stop task |
| `/api/projects/:name/task/resume` | POST | Resume task |
| `/api/projects/:name/task/respond` | POST | Answer agent question |
| `/api/projects/:name/message` | POST | Send message to agent (new) |
| `/api/projects/:name/memory` | GET | Read memory files (new) |
| `/api/projects/:name/logs` | GET | Tail supervisor logs (new) |

All endpoints require `Authorization: Bearer <token>` header.

## Configuration

The server reads `~/.synv2/config.json`:

```json
{
  "host": "https://your-ec2-ip-or-domain:4000",
  "token": "your-admin-token"
}
```

This file is created by `synv2 setup`. The MCP server uses the same `host` and `token` as the CLI.

## File Structure

```
mcp-server/
  package.json          # Dependencies: @modelcontextprotocol/sdk, zod
  tsconfig.json         # ES2022, Node16 module resolution
  src/
    index.ts            # Entry: McpServer + StdioServerTransport
    tools.ts            # All 9 tool registrations
    api-client.ts       # HTTP client for control plane API
    config.ts           # Reads ~/.synv2/config.json
  build/                # Compiled JS output (after pnpm build)
```

## Development

```bash
# Run directly with tsx (no build step)
pnpm dev

# Build for production
pnpm build

# Run built version
pnpm start
```

## Troubleshooting

**"Config not found" error**
Run `synv2 setup` first to create `~/.synv2/config.json`.

**Tools don't appear in Claude Code**
1. Check `.mcp.json` path is correct and points to `build/index.js`
2. Restart Claude Code
3. Run `node mcp-server/build/index.js` manually — it should hang (waiting for STDIO input), not crash

**API errors (401/403)**
Your token may be invalid. Check `~/.synv2/config.json` matches the token on EC2.

**Container not running errors**
The project container must be running for `send_message`, `get_agent_memory`, and `get_agent_logs` to work. Use `list_projects` to check status.
