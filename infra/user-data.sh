#!/usr/bin/env bash
set -euo pipefail
exec > /var/log/synv2-setup.log 2>&1

echo "=== Synv2 EC2 Bootstrap ==="

ADMIN_TOKEN="__ADMIN_TOKEN__"
ENCRYPTION_KEY="__ENCRYPTION_KEY__"
DOMAIN="__DOMAIN__"

# ── Install Docker and build tools ────────────────────────────
dnf install -y docker git gcc gcc-c++ make python3
systemctl enable docker
systemctl start docker

# ── Install Node.js 22 ───────────────────────────────────────
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs

# ── Install pnpm ─────────────────────────────────────────────
npm install -g pnpm

# ── Install Caddy ─────────────────────────────────────────────
curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/bin/caddy
chmod +x /usr/bin/caddy
mkdir -p /etc/caddy
caddy version

# ── Create synv2 user ──────────────────────────────────────
useradd -m -s /bin/bash synv2
usermod -aG docker synv2

# ── Create Docker network ────────────────────────────────────
docker network create synv2-net 2>/dev/null || true

# ── Clone repo and build ─────────────────────────────────────
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

# Install control plane dependencies
if [ -d control-plane ]; then
  cd control-plane
  pnpm install
  pnpm build
  cd ..
fi

# ── Register admin token in database ─────────────────────────
# The control plane will hash this token on first run; we pre-seed via env
export ADMIN_TOKEN
export ENCRYPTION_KEY

# ── Systemd service for control plane ────────────────────────
cat > /etc/systemd/system/synv2.service <<EOF
[Unit]
Description=Synv2 Control Plane
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
User=synv2
WorkingDirectory=${SYNV2_DIR}/control-plane
Environment=PORT=4000
Environment=ADMIN_TOKEN=${ADMIN_TOKEN}
Environment=ENCRYPTION_KEY=${ENCRYPTION_KEY}
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# ── Seed the admin token into the database ───────────────────
node -e "
  const crypto = require('crypto');
  const Database = require('${SYNV2_DIR}/control-plane/node_modules/better-sqlite3');
  const db = new Database('${SYNV2_DIR}/control-plane/synv2.db');
  db.pragma('journal_mode = WAL');
  db.exec(\`CREATE TABLE IF NOT EXISTS tokens (
    token_hash TEXT PRIMARY KEY,
    label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )\`);
  const hash = crypto.createHash('sha256').update('${ADMIN_TOKEN}').digest('hex');
  db.prepare('INSERT OR IGNORE INTO tokens (token_hash, label) VALUES (?, ?)').run(hash, 'admin');
  db.close();
  console.log('Admin token seeded');
" || echo "Token seeding will happen on first startup"

chown -R synv2:synv2 "$SYNV2_DIR"

systemctl daemon-reload
systemctl enable synv2
systemctl start synv2

# ── Caddy reverse proxy ──────────────────────────────────────
if [ -n "$DOMAIN" ]; then
  cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
    reverse_proxy localhost:4000
}
CADDY
else
  cat > /etc/caddy/Caddyfile <<CADDY
:443 {
    tls internal
    reverse_proxy localhost:4000
}

:80 {
    reverse_proxy localhost:4000
}
CADDY
fi

# Create caddy systemd service
cat > /etc/systemd/system/caddy.service <<CADDYSVC
[Unit]
Description=Caddy Reverse Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/caddy run --config /etc/caddy/Caddyfile
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
CADDYSVC

systemctl daemon-reload
systemctl enable caddy
systemctl start caddy

echo "=== Synv2 bootstrap complete ==="
