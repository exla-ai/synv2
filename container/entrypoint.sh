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

# Generate gateway auth password (password auth grants full operator.write scope)
GATEWAY_PASSWORD="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p)"
export OPENCLAW_GATEWAY_PASSWORD="$GATEWAY_PASSWORD"
export OPENCLAW_GATEWAY_TOKEN=""
export OPENCLAW_GATEWAY_PORT="18790"

echo "Configuring OpenClaw..."
openclaw onboard \
  --non-interactive \
  --accept-risk \
  --anthropic-api-key "${ANTHROPIC_API_KEY}" \
  --workspace "/workspace" \
  --gateway-port 18790 \
  --gateway-bind lan \
  --gateway-auth password \
  --gateway-password "$GATEWAY_PASSWORD" \
  --skip-daemon \
  2>&1 || echo "Onboard completed (or already configured)"

# Allow local connections without origin check
openclaw config set gateway.controlUi.allowedOrigins '["*"]' 2>/dev/null || true
openclaw config set gateway.controlUi.allowInsecureAuth true 2>/dev/null || true

# ── Set up autonomous exec approvals (max permissions for headless operation) ──
openclaw config set agents.defaults.sandbox.mode off 2>/dev/null || true
openclaw config set tools.elevated.enabled true 2>/dev/null || true
cat > /home/app/.openclaw/exec-approvals.json << 'APPROVALS_EOF'
{
  "version": 1,
  "socket": {},
  "defaults": {
    "security": "full",
    "ask": "off",
    "askFallback": "full",
    "autoAllowSkills": true
  },
  "agents": {
    "main": {
      "security": "full",
      "ask": "off",
      "askFallback": "full",
      "autoAllowSkills": true,
      "allowlist": [{"pattern": "*"}]
    },
    "*": {
      "security": "full",
      "ask": "off",
      "askFallback": "full",
      "autoAllowSkills": true,
      "allowlist": [{"pattern": "*"}]
    }
  }
}
APPROVALS_EOF
echo "Exec approvals configured (full autonomous mode)"

# ── Watchdog logging ──────────────────────────────────────────────
WATCHDOG_LOG="/workspace/.watchdog.log"
touch "$WATCHDOG_LOG" 2>/dev/null || true

watchdog_log() {
  local msg="$1"
  local line="[$(date -Iseconds)] $msg"
  echo "$line"
  echo "$line" >> "$WATCHDOG_LOG" 2>/dev/null || true
}

wait_for_http() {
  local name="$1"
  local url="$2"
  local attempts="$3"
  local delay="${4:-1}"

  for i in $(seq 1 "$attempts"); do
    if curl -sf "$url" >/dev/null 2>&1; then
      watchdog_log "$name ready (${i}s)"
      return 0
    fi
    sleep "$delay"
  done

  watchdog_log "$name did not become healthy within $((attempts * delay))s"
  return 1
}

OPENCLAW_PID=""
BRIDGE_PID=""
SUPERVISOR_PID=""

start_openclaw() {
  watchdog_log "Starting OpenClaw gateway on :18790..."
  openclaw gateway --port 18790 --bind lan --auth password --password "$GATEWAY_PASSWORD" --allow-unconfigured &
  OPENCLAW_PID=$!
  wait_for_http "OpenClaw gateway" "http://127.0.0.1:18790/health" 60 1 || true
}

start_bridge() {
  watchdog_log "Starting bridge gateway on :18789..."
  node /home/app/gateway.js &
  BRIDGE_PID=$!
  wait_for_http "Bridge gateway" "http://127.0.0.1:18789/health" 20 1 || true
}

start_supervisor() {
  if [ "${SUPERVISOR_ENABLED:-true}" = "true" ]; then
    watchdog_log "Starting supervisor loop..."
    node /home/app/supervisor.js &
    SUPERVISOR_PID=$!
  else
    SUPERVISOR_PID=""
    watchdog_log "Supervisor disabled (SUPERVISOR_ENABLED=${SUPERVISOR_ENABLED:-})"
  fi
}

shutdown_children() {
  watchdog_log "Stopping child services..."
  for pid in "${SUPERVISOR_PID:-}" "${BRIDGE_PID:-}" "${OPENCLAW_PID:-}"; do
    if [ -n "${pid}" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait || true
}

trap 'shutdown_children; exit 0' SIGTERM SIGINT

start_openclaw
start_bridge
start_supervisor

watchdog_log "All services started (OpenClaw=$OPENCLAW_PID, Bridge=$BRIDGE_PID, Supervisor=${SUPERVISOR_PID:-none})"

# ── Process watchdog loop (self-healing, container stays up) ─────
BRIDGE_HEALTH_FAILS=0
while true; do
  if [ -z "${OPENCLAW_PID}" ] || ! kill -0 "$OPENCLAW_PID" 2>/dev/null; then
    watchdog_log "OpenClaw process exited. Restarting..."
    start_openclaw
  fi

  BRIDGE_NEEDS_RESTART="false"
  if [ -z "${BRIDGE_PID}" ] || ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    watchdog_log "Bridge process exited. Restarting..."
    BRIDGE_NEEDS_RESTART="true"
  elif ! curl -sf http://127.0.0.1:18789/health >/dev/null 2>&1; then
    BRIDGE_HEALTH_FAILS=$((BRIDGE_HEALTH_FAILS + 1))
    watchdog_log "Bridge HTTP health check failed (${BRIDGE_HEALTH_FAILS}/2)"
    if [ "$BRIDGE_HEALTH_FAILS" -ge 2 ]; then
      watchdog_log "Bridge health endpoint is unhealthy. Restarting bridge..."
      BRIDGE_NEEDS_RESTART="true"
    fi
  else
    BRIDGE_HEALTH_FAILS=0
  fi

  if [ "$BRIDGE_NEEDS_RESTART" = "true" ]; then
    BRIDGE_HEALTH_FAILS=0
    if [ -n "${BRIDGE_PID}" ] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
      kill "$BRIDGE_PID" 2>/dev/null || true
      wait "$BRIDGE_PID" 2>/dev/null || true
    fi
    start_bridge
  fi

  if [ "${SUPERVISOR_ENABLED:-true}" = "true" ]; then
    if [ -z "${SUPERVISOR_PID}" ] || ! kill -0 "$SUPERVISOR_PID" 2>/dev/null; then
      watchdog_log "Supervisor process exited. Restarting..."
      start_supervisor
    fi
  fi

  sleep 5
done
