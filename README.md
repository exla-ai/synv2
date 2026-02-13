# Synv2

Multi-project AI agent platform on AWS. Each project gets its own isolated Docker container with OpenClaw, MCP servers, and deploy CLIs.

## Architecture

```
Local Machine                      AWS EC2 Instance
┌──────────────┐                  ┌─────────────────────────────────┐
│  synv2 CLI   │ ── HTTPS/WS ──> │  Control Plane (Express :4000)  │
│              │                  │  Caddy (TLS :443)               │
│  - setup     │                  │  SQLite (project metadata)      │
│  - init      │                  │                                 │
│  - attach    │                  │  Docker Engine                  │
│  - projects  │                  │  ├─ [project-a] container       │
│  - destroy   │                  │  │  ├─ OpenClaw gateway :18789  │
│  - status    │                  │  │  ├─ MCP servers              │
│              │                  │  │  └─ /workspace (volume)      │
│              │                  │  ├─ [project-b] container       │
│              │                  │  └─ ...                         │
└──────────────┘                  └─────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 22+, pnpm
- AWS CLI configured (`aws configure`)
- `ANTHROPIC_API_KEY` environment variable

### 1. Install CLI

```bash
pnpm install
cd cli && pnpm link --global
```

### 2. Provision AWS Infrastructure

```bash
synv2 setup
```

This creates an EC2 instance with Docker, Caddy (TLS), and the control plane. Config is saved to `~/.synv2/config.json`.

### 3. Create a Project

```bash
synv2 init my-app
```

### 4. Chat with Your AI Agent

```bash
synv2 attach my-app
```

Type messages, get Claude responses with full tool access. `Ctrl+C` to disconnect.

### 5. Manage Projects

```bash
synv2 projects          # List all projects
synv2 status            # Infrastructure health
synv2 destroy my-app    # Tear down a project
```

## Local Development (No AWS)

Run the control plane locally with Docker Desktop:

```bash
# Terminal 1: Start control plane
cd control-plane
pnpm install
pnpm dev

# Build the project container image
docker build -t synv2-project ./container

# Create ~/.synv2/config.json pointing to localhost
echo '{"host":"http://localhost:4000","token":"dev-token"}' > ~/.synv2/config.json

# Terminal 2: Use CLI
cd cli
pnpm install
npx tsx src/index.ts init test-project --api-key $ANTHROPIC_API_KEY
npx tsx src/index.ts attach test-project
```

## Project Structure

```
├── cli/                  # CLI (installed on user's machine)
│   └── src/
│       ├── index.ts      # Commander.js entry point
│       ├── commands/      # setup, init, attach, projects, destroy, status
│       ├── api-client.ts  # HTTP client for control plane
│       ├── ws-client.ts   # WebSocket client for chat
│       └── chat-ui.ts     # Terminal chat renderer
│
├── control-plane/        # Express server (runs on EC2)
│   └── src/
│       ├── server.ts      # Express + WebSocket upgrade
│       ├── routes/        # projects, auth, status
│       ├── services/      # docker, container-manager, openclaw-proxy, secrets
│       └── db/            # SQLite schema + queries
│
├── container/            # Docker image for project containers
│   ├── Dockerfile         # Debian + Node 22 + OpenClaw + CLIs
│   ├── entrypoint.sh      # Boots OpenClaw gateway
│   └── openclaw-config.js # Generates config from env vars
│
└── infra/                # AWS provisioning scripts
    ├── setup.sh           # VPC, SG, IAM, EC2
    ├── user-data.sh       # EC2 bootstrap
    └── teardown.sh        # Destroy all resources
```

## Container Image

Each project container includes:

- **AI**: OpenClaw agent with Claude, exec auto-approved
- **MCP Servers**: filesystem, github, postgres, fetch, brave-search, puppeteer, memory
- **Deploy CLIs**: vercel, flyctl, supabase, modal
- **AWS**: CLI v2 (credentials via EC2 IAM role)
- **Dev Tools**: git, tmux, python3, build-essential

## Teardown

```bash
# Destroy all AWS resources
./infra/teardown.sh
```
