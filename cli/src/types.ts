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
  status: 'running' | 'stopped' | 'creating' | 'error' | 'provisioning' | 'bootstrapping' | 'resizing';
  created_at: string;
  container_id?: string;
  instance_type?: string;
  worker_instance_id?: string;
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

export interface TaskQuestion {
  id: string;
  text: string;
  context?: string;
  priority: 'question' | 'blocking';
  asked_at: string;
  answered_at: string | null;
  answer: string | null;
}

export interface TaskStatus {
  id: string;
  name: string;
  status: string;
  completion_reason: string | null;
  turns_completed: number;
  latest_metric: number | null;
  summary: string;
  pending_questions?: number;
  blocked?: boolean;
  questions?: TaskQuestion[];
}

export interface StreamDelta {
  type: 'text_delta' | 'tool_start' | 'tool_use' | 'tool_result' | 'error' | 'done'
    | 'history' | 'status' | 'client_change' | 'task_status';
  text?: string;
  tool?: string;
  input?: string;
  output?: string;
  error?: string;
  // history type
  events?: StreamDelta[];
  // status type
  agentBusy?: boolean;
  humanCount?: number;
  supervisorConnected?: boolean;
  ocConnected?: boolean;
  // client_change type
  humans?: number;
  // task_status type
  task?: TaskStatus | null;
}
