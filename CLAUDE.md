# Synapse v3 — Project Context

## What This Is

Multi-project AI agent platform on AWS. Each project gets its own isolated Docker container with OpenClaw (Claude agent), MCP servers, and deploy CLIs (Vercel, Fly.io, Supabase, Modal).

## Architecture

```
Local Machine                      AWS EC2 Instance
┌──────────────┐                  ┌─────────────────────────────────┐
│  synv2 CLI   │ ── HTTPS/WS ──> │  Control Plane (Express :4000)  │
│              │                  │  Caddy (TLS :443)               │
│              │                  │  SQLite (project metadata)      │
│              │                  │                                 │
│              │                  │  Docker Engine                  │
│              │                  │  ├─ [project-a] container       │
│              │                  │  │  ├─ OpenClaw gateway :18789  │
│              │                  │  │  ├─ MCP servers              │
│              │                  │  │  ├─ CLIs: vercel,fly,modal   │
│              │                  │  │  └─ /workspace (volume)      │
│              │                  │  └─ [project-b] container ...   │
│              │                  │                                 │
│              │                  │  IAM Role → AWS services        │
└──────────────┘                  └─────────────────────────────────┘
```

### Persistent Supervisor Architecture (per container)

```
                  ┌─────────────┐
                  │  OpenClaw   │  One persistent WS connection
                  │  :18790     │  Fixed session key per project
                  └──────┬──────┘
                         │
                  ┌──────┴──────┐
                  │  gateway.js │  Manages persistent OC connection
                  │  :18789     │  Broadcasts events to all clients
                  └──┬───────┬──┘
                     │       │
              ┌──────┴──┐ ┌──┴────────┐
              │supervisor│ │CLI attach │  Multiple clients share
              │  .js     │ │(via proxy)│  the same OC session
              └─────────┘ └───────────┘
```

- **gateway.js** owns the persistent OpenClaw connection (fixed session key `main:webchat:synv2-{PROJECT_NAME}`)
- All clients (supervisor + humans via `synv2 attach`) share the same OpenClaw session
- Gateway buffers last 50 events so late-joining clients see recent context
- Supervisor pauses autonomous prompts when humans are attached, resumes when they leave
- Memory files (`SHORT_TERM_MEMORY.md`, `LONG_TERM_MEMORY.md`) provide continuity across context compaction

## Packages

| Package | Path | Purpose |
|---|---|---|
| CLI | `cli/` | Commander.js CLI installed on user machine. Commands: setup, init, attach, projects, destroy, restart, status, secrets, task |
| Control Plane | `control-plane/` | Express + WebSocket server on EC2. Docker orchestration, SQLite, auth, chat relay |
| Container | `container/` | Docker image for project containers. Debian + Node 22 + OpenClaw + MCP + deploy CLIs |
| MCP Server | `mcp-server/` | MCP server for Claude Code integration. Exposes 9 tools for project management, task control, messaging, memory, and logs |
| Infra | `infra/` | Shell scripts for AWS provisioning (VPC, SG, IAM, EC2, Caddy) |

## Key Files

### CLI (`cli/src/`)
- `index.ts` — Commander.js entry with all commands
- `api-client.ts` — fetch wrapper with Bearer auth for control plane API
- `ws-client.ts` — WebSocket client for OpenClaw chat relay, `identify()` method for role announcement
- `chat-ui.ts` — readline terminal UI: `>` prompt, streamed deltas, tool calls, history replay, supervisor status
- `config.ts` — reads/writes `~/.synv2/config.json`
- `commands/init.ts` — creates project + prompts for all service tokens interactively
- `commands/attach.ts` — opens WS chat session, identifies as human, receives history + supervisor status
- `commands/secrets.ts` — set/list/delete secrets
- `commands/setup.ts` — runs infra/setup.sh, parses output, saves config

### Control Plane (`control-plane/src/`)
- `server.ts` — Express + WS upgrade handler
- `routes/auth.ts` — Bearer token verification via SHA-256 hash lookup
- `routes/projects.ts` — Full CRUD + secrets CRUD + restart + message/memory/logs endpoints
- `services/docker.ts` — dockerode: create/remove containers on `synapse-net` bridge, named volumes
- `services/container-manager.ts` — orchestrates lifecycle, decrypts secrets → env vars, waits for gateway health
- `services/openclaw-proxy.ts` — bidirectional WS relay: client ↔ control plane ↔ container OpenClaw gateway
- `services/secrets.ts` — AES-256-GCM encrypt/decrypt with scrypt key derivation
- `db/schema.ts` — SQLite tables: projects, tokens, secrets
- `db/index.ts` — better-sqlite3 queries with WAL mode

### Container (`container/`)
- `Dockerfile` — Debian slim + Node 22 + OpenClaw + 7 MCP servers + Vercel/Fly/Supabase/Modal/AWS CLIs
- `entrypoint.sh` — headless OpenClaw onboard, config generation, Modal token setup, gateway + supervisor start. `SUPERVISOR_ENABLED` env var (default `true`) controls supervisor startup
- `gateway.js` — Persistent bridge: owns single OpenClaw WS connection, multi-client broadcast, event buffer (50), client identification (`identify` messages), status/client_change broadcasting, auto-reconnect
- `supervisor.js` — Autonomous agent loop: state machine (INIT→PROMPTING→WAITING→DELAY→PAUSED), human-aware pause/resume, full/continuation prompts, exponential backoff, crash recovery, recovery prompt escalation for empty turn death spirals
- `openclaw-config.js` — generates openclaw.json with MCP servers from `MCP_SERVERS` env var (CommonJS)
- `healthcheck.sh` — curl gateway /health

### MCP Server (`mcp-server/src/`)
- `index.ts` — Entry point: McpServer + StdioServerTransport
- `tools.ts` — All 9 tool registrations (list_projects, get_project_status, send_message, create_task, stop_task, resume_task, respond_to_question, get_agent_memory, get_agent_logs)
- `api-client.ts` — HTTP client for control plane API (with 15s timeout)
- `config.ts` — Reads `~/.synv2/config.json`

### Infra (`infra/`)
- `setup.sh` — default VPC, SG (22/80/443), IAM role (S3/DynamoDB/Lambda/SQS/CloudWatch), EC2 (t3.medium, 50GB gp3), Elastic IP, admin token generation
- `user-data.sh` — EC2 bootstrap: Docker + Node 22 + Caddy + systemd service + admin token seeding
- `teardown.sh` — terminate EC2, release EIP, delete SG + IAM

## Secrets Pipeline

```
synv2 secrets set <project> KEY VALUE
  → POST /api/projects/:name/secrets
  → AES-256-GCM encrypt → SQLite
  → synv2 restart <project>
  → container-manager decrypts all secrets → injects as container env vars
  → entrypoint.sh detects tokens, authenticates CLIs
  → MCP servers read their env vars (GITHUB_TOKEN, BRAVE_API_KEY, etc.)
```

### Supported secrets (all optional, prompted during `synv2 init`):
- `VERCEL_TOKEN` — Vercel deploys
- `FLY_API_TOKEN` — Fly.io deploys
- `SUPABASE_ACCESS_TOKEN` — Supabase CLI
- `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` — Modal GPU access
- `GITHUB_TOKEN` — GitHub MCP server
- `BRAVE_API_KEY` — Brave Search MCP server
- `DATABASE_URL` — Postgres MCP server

## Chat Flow

```
1. synv2 attach my-app
2. CLI → GET /api/projects/my-app (verify running)
3. CLI → WS wss://host/ws/projects/my-app/chat?token=xxx
4. Control plane → WS relay → container gateway.js (:18789)
5. CLI sends { type: "identify", role: "human" }
6. Gateway sends { type: "history", events: [...] } (last 50 events)
7. Gateway sends { type: "status", agentBusy, humanCount, supervisorConnected }
8. Gateway broadcasts { type: "client_change", humans: N } → supervisor pauses
9. User types → CLI sends user_message → gateway → OpenClaw (shared session)
10. OpenClaw streams → gateway broadcasts to ALL clients (supervisor + humans)
11. Ctrl+C → human disconnects → gateway broadcasts client_change → supervisor resumes
```

## Supervisor Flow

```
1. Container starts → entrypoint.sh launches OpenClaw, gateway.js, supervisor.js
2. Supervisor connects to gateway, sends { type: "identify", role: "supervisor" }
3. Waits for status with ocConnected=true, sends full context prompt (memory files + plan + goal)
4. Agent works → supervisor tracks text/tool metrics per turn
5. Turn ends (done/error) → delay → continuation prompt (lighter, just memory + processes)
6. Human attaches → client_change with humans>0 → supervisor enters PAUSED state
7. Human disconnects → client_change with humans=0 → 10s delay → supervisor resumes
8. Exponential backoff on empty/error turns (15s → 2min → 4min → 8min → 10min max)
9. Recovery prompt escalation: after consecutive empty turns, prompts escalate from continuation → full context → explicit recovery instructions
10. Gateway reconnects automatically on OpenClaw connection drop
```

## Design Decisions

- **Auth**: Bearer API token in `~/.synv2/config.json`, generated during `synv2 setup`
- **Chat**: WebSocket relay through control plane (no exposed container ports). Gateway owns one persistent OpenClaw session; all clients (supervisor + humans) share it
- **Supervisor**: Core feature for all projects (SUPERVISOR_ENABLED=true by default). Persistent WS to gateway, state machine with human-aware pause/resume, memory files for cross-compaction continuity
- **Storage**: Docker named volumes (`synapse-<name>-workspace`) on EBS
- **Infra**: Shell scripts + AWS CLI (not CDK — single instance, overkill)
- **MCP servers**: Pre-installed in Dockerfile, configured at boot via env vars
- **Secrets**: AES-256-GCM in SQLite, injected as container env vars on start/restart
- **Container limits**: Configurable via `CONTAINER_MEMORY_LIMIT` and `CONTAINER_CPU_LIMIT` env vars (defaults: 115GB RAM, 15 CPUs for r5.4xlarge)
- **TypeScript**: ES2022 modules, tsx for dev, tsc for build, strict mode

## Tech Stack

- **CLI**: Commander.js, ws, chalk, ora
- **Control Plane**: Express, better-sqlite3, dockerode, ws, zod
- **Container**: OpenClaw, 7 MCP servers, Vercel/Fly/Supabase CLIs, Modal (pip), AWS CLI v2
- **Infra**: AWS CLI, Caddy (auto-TLS), systemd

## Current State

- All code written and pushed to GitHub (exla-ai/synv2)
- Not yet deployed or tested end-to-end
- Dependencies not yet installed (need `pnpm install` in cli/ and control-plane/)
- No tokens/keys configured yet — user will provide during `synv2 init`

## Carried Forward From synapsev2

Patterns from the original Fly.io-based system that were adapted:
- `deploy/vm/entrypoint.sh` → `container/entrypoint.sh` (headless OpenClaw onboard, config patching, exec auto-approval)
- `api/src/server.ts` → `control-plane/src/server.ts` (Express + zod validation + auth middleware)
- `scripts/setup.sh` → `infra/setup.sh` (prerequisite checks, colored output, secret generation)
- TypeScript config: ES2022 modules, tsx for dev, tsc for build
