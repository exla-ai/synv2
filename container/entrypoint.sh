#!/usr/bin/env bash
set -euo pipefail

# ── Fix workspace permissions as root, then re-exec as app user ──
if [ "$(id -u)" = "0" ]; then
  chown -R app:app /workspace
  exec gosu app "$0" "$@"
fi

echo "=== Synv2 Project Container ==="
echo "Project: ${PROJECT_NAME:-unknown}"

# ── Configure git ───────────────────────────────────────────────
git config --global user.email "synv2@project.local"
git config --global user.name "Synv2 Agent"
if [ -n "${GITHUB_TOKEN:-}" ]; then
  git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password='$GITHUB_TOKEN'"; }; f'
fi

# ── Authenticate Modal ─────────────────────────────────────────
if [ -n "${MODAL_TOKEN_ID:-}" ] && [ -n "${MODAL_TOKEN_SECRET:-}" ]; then
  modal token set --token-id "$MODAL_TOKEN_ID" --token-secret "$MODAL_TOKEN_SECRET" 2>/dev/null || true
fi

# ── Log available services ──────────────────────────────────────
echo "Services:"
[ -n "${VERCEL_TOKEN:-}" ]           && echo "  Vercel:   yes" || echo "  Vercel:   -"
[ -n "${FLY_API_TOKEN:-}" ]          && echo "  Fly.io:   yes" || echo "  Fly.io:   -"
[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]  && echo "  Supabase: yes" || echo "  Supabase: -"
[ -n "${MODAL_TOKEN_ID:-}" ]         && echo "  Modal:    yes" || echo "  Modal:    -"
[ -n "${GITHUB_TOKEN:-}" ]           && echo "  GitHub:   yes" || echo "  GitHub:   -"
[ -n "${EXA_API_KEY:-}" ]            && echo "  Exa:      yes" || echo "  Exa:      -"
[ -n "${DISCORD_BOT_TOKEN:-}" ]      && echo "  Discord:  yes" || echo "  Discord:  -"
echo "  sudo:     yes (passwordless)"
echo "  uv:       $(uv --version 2>/dev/null || echo 'not found')"
echo "  clang:    $(clang --version 2>/dev/null | head -1 || echo 'not found')"

# ── Configure OpenClaw ──────────────────────────────────────────
mkdir -p /home/app/.openclaw

# Generate gateway auth token
GATEWAY_TOKEN="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p)"
export OPENCLAW_GATEWAY_TOKEN="$GATEWAY_TOKEN"
export OPENCLAW_GATEWAY_PORT="18790"

echo "Configuring OpenClaw..."
openclaw onboard \
  --non-interactive \
  --accept-risk \
  --anthropic-api-key "${ANTHROPIC_API_KEY}" \
  --workspace "/workspace" \
  --gateway-port 18790 \
  --gateway-bind lan \
  --gateway-auth token \
  --skip-daemon \
  2>&1 || echo "Onboard completed (or already configured)"

# Allow local connections without origin check
openclaw config set gateway.controlUi.allowedOrigins '["*"]' 2>/dev/null || true
openclaw config set gateway.controlUi.allowInsecureAuth true 2>/dev/null || true

# ── Start OpenClaw gateway in background on :18790 ──────────────
echo "Starting OpenClaw gateway on :18790..."
openclaw gateway --port 18790 --bind lan --token "$GATEWAY_TOKEN" --allow-unconfigured &
OPENCLAW_PID=$!

# Wait for OpenClaw to be ready
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:18790/health >/dev/null 2>&1; then
    echo "OpenClaw gateway ready"
    break
  fi
  sleep 1
done

# ── Start synv2 bridge gateway on :18789 in background ───────────
echo "Starting bridge gateway on :18789..."
node /home/app/gateway.js &
BRIDGE_PID=$!

# Wait for bridge to be ready
for i in $(seq 1 15); do
  if curl -sf http://127.0.0.1:18789/health >/dev/null 2>&1; then
    echo "Bridge gateway ready"
    break
  fi
  sleep 1
done

# ── Start supervisor loop (keeps agent working) ──────────────────
SUPERVISOR_PID=""
if [ "${SUPERVISOR_ENABLED:-true}" = "true" ]; then
  echo "Starting supervisor loop..."
  node /home/app/supervisor.js &
  SUPERVISOR_PID=$!
else
  echo "Supervisor disabled (SUPERVISOR_ENABLED=${SUPERVISOR_ENABLED:-})"
fi

echo "All services started (OpenClaw=$OPENCLAW_PID, Bridge=$BRIDGE_PID, Supervisor=${SUPERVISOR_PID:-none})"

# ── Wait for any child to exit ────────────────────────────────────
wait -n $OPENCLAW_PID $BRIDGE_PID 2>/dev/null || true
echo "A service exited. Shutting down..."
