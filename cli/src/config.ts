import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Synv2Config } from './types.js';

const CONFIG_DIR = join(homedir(), '.synv2');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export function loadConfig(): Synv2Config | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveConfig(config: Synv2Config): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function requireConfig(): Synv2Config {
  const config = loadConfig();
  if (!config) {
    console.error('Not configured. Run `synv2 setup` first.');
    process.exit(1);
  }
  return config;
}

export { CONFIG_DIR, CONFIG_PATH };
