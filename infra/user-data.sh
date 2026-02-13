#!/usr/bin/env bash
set -euo pipefail
exec > /var/log/synapse-setup.log 2>&1

echo "=== Synapse EC2 Bootstrap ==="

ADMIN_TOKEN="__ADMIN_TOKEN__"
ENCRYPTION_KEY="__ENCRYPTION_KEY__"
DOMAIN="__DOMAIN__"

# ── Install Docker ────────────────────────────────────────────
dnf install -y docker git
systemctl enable docker
systemctl start docker

# ── Install Node.js 22 ───────────────────────────────────────
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs

# ── Install pnpm ─────────────────────────────────────────────
npm install -g pnpm

# ── Install Caddy ─────────────────────────────────────────────
dnf install -y 'dnf-command(copr)'
dnf copr enable -y @caddy/caddy
dnf install -y caddy

# ── Create synapse user ──────────────────────────────────────
useradd -m -s /bin/bash synapse
usermod -aG docker synapse

# ── Create Docker network ────────────────────────────────────
docker network create synapse-net 2>/dev/null || true

# ── Clone repo and build ─────────────────────────────────────
SYNAPSE_DIR="/opt/synapse"
git clone https://github.com/viraat/synapse.git "$SYNAPSE_DIR" || {
  mkdir -p "$SYNAPSE_DIR"
  echo "Git clone failed — will need manual setup"
}

cd "$SYNAPSE_DIR"

# Build the project container image
if [ -d container ]; then
  docker build -t synapse-project ./container
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
cat > /etc/systemd/system/synapse.service <<EOF
[Unit]
Description=Synapse Control Plane
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
User=synapse
WorkingDirectory=${SYNAPSE_DIR}/control-plane
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
  const Database = require('${SYNAPSE_DIR}/control-plane/node_modules/better-sqlite3');
  const db = new Database('${SYNAPSE_DIR}/control-plane/synapse.db');
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

chown -R synapse:synapse "$SYNAPSE_DIR"

systemctl daemon-reload
systemctl enable synapse
systemctl start synapse

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

systemctl enable caddy
systemctl restart caddy

echo "=== Synapse bootstrap complete ==="
