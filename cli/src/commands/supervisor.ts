import { requireConfig } from '../config.js';
import { ApiClient } from '../api-client.js';

async function control(action: string, project: string): Promise<void> {
  const config = requireConfig();
  const api = new ApiClient(config);

  try {
    const result = await api.controlSupervisor(project, action);
    if (!result.supervisorFound) {
      console.error(`Supervisor not connected for "${project}". It may not be running.`);
      process.exit(1);
    }
    console.log(`Supervisor ${action}: ok`);
  } catch (err: any) {
    console.error(`Failed to ${action} supervisor: ${err.message}`);
    process.exit(1);
  }
}

export async function supervisorPauseCommand(project: string): Promise<void> {
  await control('pause', project);
}

export async function supervisorResumeCommand(project: string): Promise<void> {
  await control('resume', project);
}

export async function supervisorStopCommand(project: string): Promise<void> {
  await control('stop', project);
}

export async function supervisorRestartCommand(project: string): Promise<void> {
  await control('restart', project);
}
