import type Database from 'better-sqlite3';

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      name TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'creating',
      container_id TEXT,
      anthropic_api_key_enc TEXT NOT NULL,
      mcp_servers TEXT NOT NULL DEFAULT '[]',
      env_enc TEXT NOT NULL DEFAULT '{}',
      instance_type TEXT DEFAULT 't3.medium',
      worker_instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tokens (
      token_hash TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS secrets (
      project_name TEXT NOT NULL,
      key TEXT NOT NULL,
      value_enc TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_name, key),
      FOREIGN KEY (project_name) REFERENCES projects(name) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workers (
      instance_id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL UNIQUE,
      instance_type TEXT NOT NULL,
      private_ip TEXT,
      public_ip TEXT,
      status TEXT NOT NULL DEFAULT 'provisioning',
      region TEXT NOT NULL,
      availability_zone TEXT,
      worker_token TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_heartbeat TEXT,
      FOREIGN KEY (project_name) REFERENCES projects(name) ON DELETE CASCADE
    );
  `);

  // Add columns to existing projects table (safe to run multiple times)
  const columns = db.pragma('table_info(projects)') as { name: string }[];
  const columnNames = new Set(columns.map(c => c.name));

  if (!columnNames.has('instance_type')) {
    db.exec("ALTER TABLE projects ADD COLUMN instance_type TEXT DEFAULT 't3.medium'");
  }
  if (!columnNames.has('worker_instance_id')) {
    db.exec('ALTER TABLE projects ADD COLUMN worker_instance_id TEXT');
  }
}
