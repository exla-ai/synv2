import type { SynapseConfig, Project, ProjectDetail, StatusResponse, ApiError } from './types.js';

export class ApiClient {
  private host: string;
  private token: string;

  constructor(config: SynapseConfig) {
    this.host = config.host.replace(/\/$/, '');
    this.token = config.token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.host}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const err: ApiError = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.message || err.error || `HTTP ${res.status}`);
    }

    return res.json() as Promise<T>;
  }

  async createProject(name: string, opts: { anthropicApiKey: string; mcpServers?: string[]; env?: Record<string, string> }): Promise<Project> {
    return this.request('POST', '/api/projects', { name, ...opts });
  }

  async listProjects(): Promise<Project[]> {
    const res = await this.request<{ projects: Project[] }>('GET', '/api/projects');
    return res.projects;
  }

  async getProject(name: string): Promise<ProjectDetail> {
    return this.request('GET', `/api/projects/${encodeURIComponent(name)}`);
  }

  async deleteProject(name: string): Promise<void> {
    await this.request('DELETE', `/api/projects/${encodeURIComponent(name)}`);
  }

  async getStatus(): Promise<StatusResponse> {
    return this.request('GET', '/api/status');
  }

  async health(): Promise<{ ok: boolean }> {
    return this.request('GET', '/health');
  }

  async setSecret(projectName: string, key: string, value: string): Promise<void> {
    await this.request('POST', `/api/projects/${encodeURIComponent(projectName)}/secrets`, { key, value });
  }

  async listSecrets(projectName: string): Promise<{ key: string; created_at: string }[]> {
    const res = await this.request<{ secrets: { key: string; created_at: string }[] }>(
      'GET', `/api/projects/${encodeURIComponent(projectName)}/secrets`
    );
    return res.secrets;
  }

  async deleteSecret(projectName: string, key: string): Promise<void> {
    await this.request('DELETE', `/api/projects/${encodeURIComponent(projectName)}/secrets/${encodeURIComponent(key)}`);
  }

  async restartProject(name: string): Promise<void> {
    await this.request('POST', `/api/projects/${encodeURIComponent(name)}/restart`);
  }

  getWsUrl(projectName: string): string {
    const wsHost = this.host.replace(/^http/, 'ws');
    return `${wsHost}/ws/projects/${encodeURIComponent(projectName)}/chat?token=${this.token}`;
  }
}
