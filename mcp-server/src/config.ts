import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface Synv2Config {
  host: string;
  token: string;
}

const CONFIG_PATH = join(homedir(), '.synv2', 'config.json');

export function loadConfig(): Synv2Config {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Config not found at ${CONFIG_PATH}. Run \`synv2 setup\` first.`);
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  if (!raw.host || !raw.token) {
    throw new Error('Invalid config: missing host or token');
  }
  return { host: raw.host.replace(/\/$/, ''), token: raw.token };
}
