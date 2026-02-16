import Database from 'better-sqlite3';
import { resolve } from 'path';
import { migrate } from './schema.js';
import type { ProjectRow, TokenRow, SecretRow, WorkerRow } from '../types.js';

const DB_PATH = process.env.DB_PATH || resolve(process.cwd(), 'synv2.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    migrate(_db);
  }
  return _db;
}

// Projects
export function insertProject(row: Omit<ProjectRow, 'updated_at'>): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO projects (name, status, container_id, anthropic_api_key_enc, mcp_servers, env_enc, created_at)
    VALUES (@name, @status, @container_id, @anthropic_api_key_enc, @mcp_servers, @env_enc, @created_at)
  `).run(row);
}

export function getProject(name: string): ProjectRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as ProjectRow | undefined;
}

export function listProjects(): ProjectRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[];
}

export function updateProject(name: string, updates: Partial<Pick<ProjectRow, 'status' | 'container_id' | 'instance_type' | 'worker_instance_id'>>): void {
  const db = getDb();
  const sets: string[] = ["updated_at = datetime('now')"];
  const params: Record<string, any> = { name };

  if (updates.status !== undefined) {
    sets.push('status = @status');
    params.status = updates.status;
  }
  if (updates.container_id !== undefined) {
    sets.push('container_id = @container_id');
    params.container_id = updates.container_id;
  }
  if (updates.instance_type !== undefined) {
    sets.push('instance_type = @instance_type');
    params.instance_type = updates.instance_type;
  }
  if (updates.worker_instance_id !== undefined) {
    sets.push('worker_instance_id = @worker_instance_id');
    params.worker_instance_id = updates.worker_instance_id;
  }

  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE name = @name`).run(params);
}

export function deleteProject(name: string): void {
  const db = getDb();
  db.prepare('DELETE FROM projects WHERE name = ?').run(name);
}

// Tokens
export function insertToken(row: TokenRow): void {
  const db = getDb();
  db.prepare('INSERT INTO tokens (token_hash, label, created_at) VALUES (@token_hash, @label, @created_at)').run(row);
}

export function getToken(hash: string): TokenRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM tokens WHERE token_hash = ?').get(hash) as TokenRow | undefined;
}

// Secrets
export function insertSecret(row: SecretRow): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO secrets (project_name, key, value_enc, created_at)
    VALUES (@project_name, @key, @value_enc, @created_at)
  `).run(row);
}

export function getSecrets(projectName: string): SecretRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM secrets WHERE project_name = ?').all(projectName) as SecretRow[];
}

export function deleteSecret(projectName: string, key: string): void {
  const db = getDb();
  db.prepare('DELETE FROM secrets WHERE project_name = ? AND key = ?').run(projectName, key);
}

// Workers
export function insertWorker(row: Omit<WorkerRow, 'last_heartbeat'>): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO workers (instance_id, project_name, instance_type, private_ip, public_ip, status, region, availability_zone, worker_token, created_at)
    VALUES (@instance_id, @project_name, @instance_type, @private_ip, @public_ip, @status, @region, @availability_zone, @worker_token, @created_at)
  `).run(row);
}

export function getWorker(instanceId: string): WorkerRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM workers WHERE instance_id = ?').get(instanceId) as WorkerRow | undefined;
}

export function getWorkerByProject(projectName: string): WorkerRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM workers WHERE project_name = ?').get(projectName) as WorkerRow | undefined;
}

export function listWorkers(): WorkerRow[] {
  const db = getDb();
  return db.prepare("SELECT * FROM workers WHERE status != 'terminated' ORDER BY created_at DESC").all() as WorkerRow[];
}

export function updateWorker(instanceId: string, updates: Partial<Pick<WorkerRow, 'status' | 'private_ip' | 'public_ip' | 'availability_zone' | 'instance_type' | 'last_heartbeat'>>): void {
  const db = getDb();
  const sets: string[] = [];
  const params: Record<string, any> = { instance_id: instanceId };

  if (updates.status !== undefined) {
    sets.push('status = @status');
    params.status = updates.status;
  }
  if (updates.private_ip !== undefined) {
    sets.push('private_ip = @private_ip');
    params.private_ip = updates.private_ip;
  }
  if (updates.public_ip !== undefined) {
    sets.push('public_ip = @public_ip');
    params.public_ip = updates.public_ip;
  }
  if (updates.availability_zone !== undefined) {
    sets.push('availability_zone = @availability_zone');
    params.availability_zone = updates.availability_zone;
  }
  if (updates.instance_type !== undefined) {
    sets.push('instance_type = @instance_type');
    params.instance_type = updates.instance_type;
  }
  if (updates.last_heartbeat !== undefined) {
    sets.push('last_heartbeat = @last_heartbeat');
    params.last_heartbeat = updates.last_heartbeat;
  }

  if (sets.length > 0) {
    db.prepare(`UPDATE workers SET ${sets.join(', ')} WHERE instance_id = @instance_id`).run(params);
  }
}

export function deleteWorker(instanceId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM workers WHERE instance_id = ?').run(instanceId);
}
