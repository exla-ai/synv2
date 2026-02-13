#!/usr/bin/env bash
set -euo pipefail

echo "=== Synv2 Project Container ==="
echo "Project: ${PROJECT_NAME:-unknown}"

# ── Authenticate deploy CLIs from injected secrets ──────────
if [ -n "${VERCEL_TOKEN:-}" ]; then echo "Vercel token detected."; fi
if [ -n "${FLY_API_TOKEN:-}" ]; then echo "Fly.io token detected."; fi
if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then echo "Supabase token detected."; fi

if [ -n "${MODAL_TOKEN_ID:-}" ] && [ -n "${MODAL_TOKEN_SECRET:-}" ]; then
  echo "Modal token detected, setting up..."
  modal token set --token-id "$MODAL_TOKEN_ID" --token-secret "$MODAL_TOKEN_SECRET" 2>/dev/null || true
fi

if [ -n "${GITHUB_TOKEN:-}" ]; then echo "GitHub token detected."; fi
if [ -n "${EXA_API_KEY:-}" ]; then echo "Exa API key detected."; fi

echo "=== Services ==="
echo "  Vercel:   ${VERCEL_TOKEN:+yes}${VERCEL_TOKEN:-no}"
echo "  Fly.io:   ${FLY_API_TOKEN:+yes}${FLY_API_TOKEN:-no}"
echo "  Supabase: ${SUPABASE_ACCESS_TOKEN:+yes}${SUPABASE_ACCESS_TOKEN:-no}"
echo "  Modal:    ${MODAL_TOKEN_ID:+yes}${MODAL_TOKEN_ID:-no}"
echo "  GitHub:   ${GITHUB_TOKEN:+yes}${GITHUB_TOKEN:-no}"
echo "  Exa:      ${EXA_API_KEY:+yes}${EXA_API_KEY:-no}"
echo "  Discord:  ${DISCORD_BOT_TOKEN:+yes}${DISCORD_BOT_TOKEN:-no}"
echo "  AWS:      $(aws sts get-caller-identity 2>/dev/null && echo 'yes' || echo 'via IAM role')"

# Start the Synv2 agent gateway
echo "Starting gateway on :18789..."
exec node /home/app/gateway.js
