#!/usr/bin/env bash
set -euo pipefail

echo "=== Synv2 Project Container ==="
echo "Project: ${PROJECT_NAME:-unknown}"

# ── Configure git ───────────────────────────────────────────────
if [ -n "${GITHUB_TOKEN:-}" ]; then
  git config --global credential.helper '!f() { echo "username=x-access-token"; echo "password='$GITHUB_TOKEN'"; }; f'
  git config --global user.email "synv2@project.local"
  git config --global user.name "Synv2 Agent"
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

# ── Start synv2 bridge gateway on :18789 ────────────────────────
echo "Starting bridge gateway on :18789..."
exec node /home/app/gateway.js
