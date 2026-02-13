import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { SynapseConfig } from './types.js';

const CONFIG_DIR = join(homedir(), '.synapse');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export function loadConfig(): SynapseConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveConfig(config: SynapseConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function requireConfig(): SynapseConfig {
  const config = loadConfig();
  if (!config) {
    console.error('Not configured. Run `synapse setup` first.');
    process.exit(1);
  }
  return config;
}

export { CONFIG_DIR, CONFIG_PATH };
