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
  `);
}
