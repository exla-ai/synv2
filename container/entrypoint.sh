#!/usr/bin/env bash
set -euo pipefail

echo "=== Synv2 Project Container ==="
echo "Project: ${PROJECT_NAME:-unknown}"
echo "OpenClaw: $(openclaw --version 2>/dev/null || echo 'installed')"

# Configure OpenClaw for headless operation
export OPENCLAW_HOME="${HOME}/.openclaw"
mkdir -p "${OPENCLAW_HOME}"

# Run non-interactive onboard if not already configured
if [ ! -f "${OPENCLAW_HOME}/openclaw.json" ]; then
  echo "Running OpenClaw headless onboard..."
  openclaw onboard --non-interactive --accept-risk \
    --mode local \
    --workspace "${WORKSPACE:-/workspace}" \
    ${ANTHROPIC_API_KEY:+--anthropic-api-key "$ANTHROPIC_API_KEY"} \
    || echo "Onboard failed, will retry on first use"
fi

# Generate OpenClaw config with MCP servers from env
echo "Configuring OpenClaw..."
node /home/app/openclaw-config.js

# Write exec-approvals for auto-approved headless operation
cat > "${OPENCLAW_HOME}/exec-approvals.json" <<'APPROVALS'
{
  "version": 1,
  "defaults": {
    "security": "full",
    "ask": "off",
    "askFallback": "full",
    "autoAllowSkills": true
  }
}
APPROVALS

# ── Authenticate deploy CLIs from injected secrets ──────────
# Vercel
if [ -n "${VERCEL_TOKEN:-}" ]; then
  echo "Vercel token detected."
fi

# Fly.io
if [ -n "${FLY_API_TOKEN:-}" ]; then
  echo "Fly.io token detected."
fi

# Supabase
if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "Supabase token detected."
fi

# Modal
if [ -n "${MODAL_TOKEN_ID:-}" ] && [ -n "${MODAL_TOKEN_SECRET:-}" ]; then
  echo "Modal token detected, setting up..."
  modal token set --token-id "$MODAL_TOKEN_ID" --token-secret "$MODAL_TOKEN_SECRET" 2>/dev/null || true
fi

# GitHub (also used by MCP server-github)
if [ -n "${GITHUB_TOKEN:-}" ]; then
  echo "GitHub token detected."
fi

# Exa (search API, used by MCP exa server)
if [ -n "${EXA_API_KEY:-}" ]; then
  echo "Exa API key detected."
fi

# ── Configure Discord bot if token provided ──────────────────
if [ -n "${DISCORD_BOT_TOKEN:-}" ]; then
  echo "Configuring Discord bot..."
  node -e "
    const fs = require('fs');
    const p = '${OPENCLAW_HOME}/openclaw.json';
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    c.channels = c.channels || {};
    c.channels.discord = Object.assign(c.channels.discord || {}, {
      enabled: true,
      token: process.env.DISCORD_BOT_TOKEN,
      groupPolicy: 'open',
      dm: { policy: 'open', allowFrom: ['*'] }
    });
    fs.writeFileSync(p, JSON.stringify(c, null, 2));
    console.log('Discord configured: enabled, open DMs, open group policy');
  "
fi

# Start OpenClaw gateway (persistent daemon for chat)
echo "Starting OpenClaw gateway on :18789..."
openclaw gateway --port 18789 --verbose &
GATEWAY_PID=$!

# Wait for gateway to be ready
echo "Waiting for gateway..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:18789/health >/dev/null 2>&1; then
    echo "Gateway ready."
    break
  fi
  sleep 1
done

echo "=== Container ready ==="
echo "Services: OpenClaw gateway"
echo "  Vercel:   ${VERCEL_TOKEN:+yes}${VERCEL_TOKEN:-no}"
echo "  Fly.io:   ${FLY_API_TOKEN:+yes}${FLY_API_TOKEN:-no}"
echo "  Supabase: ${SUPABASE_ACCESS_TOKEN:+yes}${SUPABASE_ACCESS_TOKEN:-no}"
echo "  Modal:    ${MODAL_TOKEN_ID:+yes}${MODAL_TOKEN_ID:-no}"
echo "  GitHub:   ${GITHUB_TOKEN:+yes}${GITHUB_TOKEN:-no}"
echo "  Exa:      ${EXA_API_KEY:+yes}${EXA_API_KEY:-no}"
echo "  Discord:  ${DISCORD_BOT_TOKEN:+yes}${DISCORD_BOT_TOKEN:-no}"
echo "  AWS:      $(aws sts get-caller-identity 2>/dev/null && echo 'yes' || echo 'via IAM role')"

# Keep container alive — wait for gateway process
wait $GATEWAY_PID
