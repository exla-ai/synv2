#!/usr/bin/env bash
set -euo pipefail
exec > /var/log/synv2-worker-setup.log 2>&1

echo "=== Synv2 Worker Bootstrap ==="

PROJECT_NAME="__PROJECT_NAME__"
CONTROL_PLANE_HOST="__CONTROL_PLANE_HOST__"
WORKER_TOKEN="__WORKER_TOKEN__"
WORKER_AGENT_PORT="__WORKER_AGENT_PORT__"

echo "Project: ${PROJECT_NAME}"
echo "Control plane: ${CONTROL_PLANE_HOST}"

export HOME=/root

# ── Install Docker and build tools ────────────────────────────
dnf install -y docker git gcc gcc-c++ make python3
systemctl enable docker
systemctl start docker

# ── Install Node.js 22 ───────────────────────────────────────
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs

# ── Install pnpm ─────────────────────────────────────────────
npm install -g pnpm

# ── Create synv2 user ──────────────────────────────────────
useradd -m -s /bin/bash synv2
usermod -aG docker synv2

# ── Create Docker network ────────────────────────────────────
docker network create synv2-net 2>/dev/null || true

# ── Clone repo and build container image ──────────────────────
git config --global --add safe.directory /opt/synv2
SYNV2_DIR="/opt/synv2"
git clone https://github.com/exla-ai/synv2.git "$SYNV2_DIR" || {
  mkdir -p "$SYNV2_DIR"
  echo "Git clone failed — will need manual setup"
}

cd "$SYNV2_DIR"

# Build the project container image
if [ -d container ]; then
  docker build -t synv2-project ./container
fi

# Install worker agent dependencies (uses the control-plane package)
if [ -d control-plane ]; then
  cd control-plane
  pnpm install
  pnpm build
  cd ..
fi

chown -R synv2:synv2 "$SYNV2_DIR"

# ── Write worker config ─────────────────────────────────────
cat > /opt/synv2/worker-config.json <<WCFG
{
  "projectName": "${PROJECT_NAME}",
  "controlPlaneHost": "${CONTROL_PLANE_HOST}",
  "workerToken": "${WORKER_TOKEN}",
  "port": ${WORKER_AGENT_PORT}
}
WCFG

# ── Systemd service for worker agent ────────────────────────
cat > /etc/systemd/system/synv2-worker.service <<EOF
[Unit]
Description=Synv2 Worker Agent (${PROJECT_NAME})
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
User=synv2
WorkingDirectory=${SYNV2_DIR}
Environment=NODE_ENV=production
Environment=WORKER_CONFIG=/opt/synv2/worker-config.json
ExecStart=/usr/bin/node ${SYNV2_DIR}/container/worker-agent.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable synv2-worker
systemctl start synv2-worker

echo "=== Synv2 worker bootstrap complete ==="
