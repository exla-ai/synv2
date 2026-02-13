export interface Synv2Config {
  host: string;
  token: string;
  region?: string;
  instanceType?: string;
  instanceId?: string;
  elasticIp?: string;
}

export interface Project {
  name: string;
  status: 'running' | 'stopped' | 'creating' | 'error';
  created_at: string;
  container_id?: string;
  mcp_servers?: string[];
}

export interface ProjectDetail extends Project {
  env: Record<string, string>;
  resource_limits: {
    memory: string;
    cpus: string;
  };
}

export interface StatusResponse {
  ok: boolean;
  uptime: number;
  docker: {
    containers_running: number;
    containers_total: number;
  };
  projects: Project[];
  system: {
    memory_used_mb: number;
    memory_total_mb: number;
    disk_used_gb: number;
    disk_total_gb: number;
  };
}

export interface ApiError {
  error: string;
  message?: string;
}

// OpenClaw WebSocket protocol messages
export interface WSMessage {
  type: string;
  [key: string]: any;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamDelta {
  type: 'text_delta' | 'tool_start' | 'tool_use' | 'tool_result' | 'error' | 'done';
  text?: string;
  tool?: string;
  input?: string;
  output?: string;
  error?: string;
}
