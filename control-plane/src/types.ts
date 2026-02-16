export interface ProjectRow {
  name: string;
  status: string;
  container_id: string | null;
  anthropic_api_key_enc: string;
  mcp_servers: string; // JSON array
  env_enc: string; // JSON object, encrypted
  instance_type: string | null;
  worker_instance_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkerRow {
  instance_id: string;
  project_name: string;
  instance_type: string;
  private_ip: string | null;
  public_ip: string | null;
  status: string; // provisioning | bootstrapping | ready | stopping | terminated
  region: string;
  availability_zone: string | null;
  worker_token: string | null;
  created_at: string;
  last_heartbeat: string | null;
}

export interface TokenRow {
  token_hash: string;
  label: string;
  created_at: string;
}

export interface SecretRow {
  project_name: string;
  key: string;
  value_enc: string; // AES-256-GCM encrypted
  created_at: string;
}

export interface ProjectCreateRequest {
  name: string;
  anthropicApiKey: string;
  mcpServers?: string[];
  env?: Record<string, string>;
  instanceType?: string;
}

export interface ProjectResponse {
  name: string;
  status: string;
  created_at: string;
  container_id?: string;
  mcp_servers?: string[];
}

export interface StatusResponse {
  ok: boolean;
  uptime: number;
  docker: {
    containers_running: number;
    containers_total: number;
  };
  projects: ProjectResponse[];
  system: {
    memory_used_mb: number;
    memory_total_mb: number;
    disk_used_gb: number;
    disk_total_gb: number;
  };
}
