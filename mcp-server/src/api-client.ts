import type { Synv2Config } from './config.js';

export class ApiClient {
  private host: string;
  private token: string;

  constructor(config: Synv2Config) {
    this.host = config.host;
    this.token = config.token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.host}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as any;
      throw new Error(err.message || err.error || `HTTP ${res.status}`);
    }

    return res.json() as Promise<T>;
  }

  private enc(s: string): string {
    return encodeURIComponent(s);
  }

  async listProjects(): Promise<any> {
    return this.request('GET', '/api/projects');
  }

  async getProject(name: string): Promise<any> {
    return this.request('GET', `/api/projects/${this.enc(name)}`);
  }

  async sendMessage(name: string, message: string): Promise<any> {
    return this.request('POST', `/api/projects/${this.enc(name)}/message`, { message });
  }

  async createTask(name: string, taskDef: Record<string, unknown>): Promise<any> {
    return this.request('POST', `/api/projects/${this.enc(name)}/task`, taskDef);
  }

  async stopTask(name: string): Promise<any> {
    return this.request('POST', `/api/projects/${this.enc(name)}/task/stop`);
  }

  async resumeTask(name: string): Promise<any> {
    return this.request('POST', `/api/projects/${this.enc(name)}/task/resume`);
  }

  async respondToQuestion(name: string, questionId: string, answer: string): Promise<any> {
    return this.request('POST', `/api/projects/${this.enc(name)}/task/respond`, {
      question_id: questionId,
      answer,
    });
  }

  async getMemory(name: string): Promise<any> {
    return this.request('GET', `/api/projects/${this.enc(name)}/memory`);
  }

  async getLogs(name: string, lines?: number): Promise<any> {
    const qs = lines ? `?lines=${lines}` : '';
    return this.request('GET', `/api/projects/${this.enc(name)}/logs${qs}`);
  }
}
