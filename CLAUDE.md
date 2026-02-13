# Synapse v3 — Project Context

## What This Is

Multi-project AI agent platform on AWS. Each project gets its own isolated Docker container with OpenClaw (Claude agent), MCP servers, and deploy CLIs (Vercel, Fly.io, Supabase, Modal).

## Architecture

```
Local Machine                      AWS EC2 Instance
┌──────────────┐                  ┌─────────────────────────────────┐
│  synapse CLI │ ── HTTPS/WS ──> │  Control Plane (Express :4000)  │
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

## Packages

| Package | Path | Purpose |
|---|---|---|
| CLI | `cli/` | Commander.js CLI installed on user machine. Commands: setup, init, attach, projects, destroy, restart, status, secrets |
| Control Plane | `control-plane/` | Express + WebSocket server on EC2. Docker orchestration, SQLite, auth, chat relay |
| Container | `container/` | Docker image for project containers. Debian + Node 22 + OpenClaw + MCP + deploy CLIs |
| Infra | `infra/` | Shell scripts for AWS provisioning (VPC, SG, IAM, EC2, Caddy) |

## Key Files

### CLI (`cli/src/`)
- `index.ts` — Commander.js entry with all commands
- `api-client.ts` — fetch wrapper with Bearer auth for control plane API
- `ws-client.ts` — WebSocket client for OpenClaw chat relay
- `chat-ui.ts` — readline terminal UI: `>` prompt, streamed deltas, tool calls
- `config.ts` — reads/writes `~/.synapse/config.json`
- `commands/init.ts` — creates project + prompts for all service tokens interactively
- `commands/attach.ts` — opens WS chat session
- `commands/secrets.ts` — set/list/delete secrets
- `commands/setup.ts` — runs infra/setup.sh, parses output, saves config

### Control Plane (`control-plane/src/`)
- `server.ts` — Express + WS upgrade handler
- `routes/auth.ts` — Bearer token verification via SHA-256 hash lookup
- `routes/projects.ts` — Full CRUD + secrets CRUD + restart endpoint
- `services/docker.ts` — dockerode: create/remove containers on `synapse-net` bridge, named volumes
- `services/container-manager.ts` — orchestrates lifecycle, decrypts secrets → env vars, waits for gateway health
- `services/openclaw-proxy.ts` — bidirectional WS relay: client ↔ control plane ↔ container OpenClaw gateway
- `services/secrets.ts` — AES-256-GCM encrypt/decrypt with scrypt key derivation
- `db/schema.ts` — SQLite tables: projects, tokens, secrets
- `db/index.ts` — better-sqlite3 queries with WAL mode

### Container (`container/`)
- `Dockerfile` — Debian slim + Node 22 + OpenClaw + 7 MCP servers + Vercel/Fly/Supabase/Modal/AWS CLIs
- `entrypoint.sh` — headless OpenClaw onboard, config generation, Modal token setup, gateway start
- `openclaw-config.js` — generates openclaw.json with MCP servers from `MCP_SERVERS` env var (CommonJS)
- `healthcheck.sh` — curl gateway /health

### Infra (`infra/`)
- `setup.sh` — default VPC, SG (22/80/443), IAM role (S3/DynamoDB/Lambda/SQS/CloudWatch), EC2 (t3.medium, 50GB gp3), Elastic IP, admin token generation
- `user-data.sh` — EC2 bootstrap: Docker + Node 22 + Caddy + systemd service + admin token seeding
- `teardown.sh` — terminate EC2, release EIP, delete SG + IAM

## Secrets Pipeline

```
synapse secrets set <project> KEY VALUE
  → POST /api/projects/:name/secrets
  → AES-256-GCM encrypt → SQLite
  → synapse restart <project>
  → container-manager decrypts all secrets → injects as container env vars
  → entrypoint.sh detects tokens, authenticates CLIs
  → MCP servers read their env vars (GITHUB_TOKEN, BRAVE_API_KEY, etc.)
```

### Supported secrets (all optional, prompted during `synapse init`):
- `VERCEL_TOKEN` — Vercel deploys
- `FLY_API_TOKEN` — Fly.io deploys
- `SUPABASE_ACCESS_TOKEN` — Supabase CLI
- `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` — Modal GPU access
- `GITHUB_TOKEN` — GitHub MCP server
- `BRAVE_API_KEY` — Brave Search MCP server
- `DATABASE_URL` — Postgres MCP server

## Chat Flow

```
1. synapse attach my-app
2. CLI → GET /api/projects/my-app (verify running)
3. CLI → WS wss://host/ws/projects/my-app/chat?token=xxx
4. Control plane → WS ws://<container-ip>:18789 (OpenClaw gateway)
5. User types → CLI sends over WS → relay → OpenClaw
6. OpenClaw streams response → relay → CLI renders in terminal
7. Ctrl+C → graceful close → "Disconnected."
```

## Design Decisions

- **Auth**: Bearer API token in `~/.synapse/config.json`, generated during `synapse setup`
- **Chat**: WebSocket relay through control plane (no exposed container ports)
- **Storage**: Docker named volumes (`synapse-<name>-workspace`) on EBS
- **Infra**: Shell scripts + AWS CLI (not CDK — single instance, overkill)
- **MCP servers**: Pre-installed in Dockerfile, configured at boot via env vars
- **Secrets**: AES-256-GCM in SQLite, injected as container env vars on start/restart
- **Container limits**: 2GB RAM, 2 CPUs per project
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
- No tokens/keys configured yet — user will provide during `synapse init`

## Carried Forward From synapsev2

Patterns from the original Fly.io-based system that were adapted:
- `deploy/vm/entrypoint.sh` → `container/entrypoint.sh` (headless OpenClaw onboard, config patching, exec auto-approval)
- `api/src/server.ts` → `control-plane/src/server.ts` (Express + zod validation + auth middleware)
- `scripts/setup.sh` → `infra/setup.sh` (prerequisite checks, colored output, secret generation)
- TypeScript config: ES2022 modules, tsx for dev, tsc for build
