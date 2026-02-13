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

# ── Start gateway ──────────────────────────────────────────────
echo "Starting gateway on :18789..."
exec node /home/app/gateway.js
