import { execSync, spawn } from 'child_process';
import { createInterface } from 'readline';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { saveConfig } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INFRA_DIR = resolve(__dirname, '../../../infra');

function ask(question: string, defaultVal?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultVal ? ` [${defaultVal}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

export async function setupCommand(): Promise<void> {
  console.log('Synv2 AWS Setup\n');

  // Check AWS CLI
  try {
    execSync('aws sts get-caller-identity', { stdio: 'pipe' });
  } catch {
    console.error('AWS CLI not configured. Run `aws configure` first.');
    process.exit(1);
  }

  const region = await ask('AWS region', 'us-east-1');
  const instanceType = await ask('Instance type', 't3.medium');
  const domain = await ask('Domain (optional, for TLS)');

  console.log('\nProvisioning infrastructure...');

  const setupScript = resolve(INFRA_DIR, 'setup.sh');
  const env = {
    ...process.env,
    SYNV2_REGION: region,
    SYNV2_INSTANCE_TYPE: instanceType,
    SYNV2_DOMAIN: domain,
  };

  const proc = spawn('bash', [setupScript], { env, stdio: 'pipe' });

  let output = '';
  proc.stdout.on('data', (data) => {
    const text = data.toString();
    output += text;
    process.stdout.write(text);
  });
  proc.stderr.on('data', (data) => {
    process.stderr.write(data.toString());
  });

  const exitCode = await new Promise<number>((resolve) => {
    proc.on('close', resolve);
  });

  if (exitCode !== 0) {
    console.error('\nSetup failed.');
    process.exit(1);
  }

  // Parse output for host, token, instance info
  const hostMatch = output.match(/SYNV2_HOST=(\S+)/);
  const tokenMatch = output.match(/SYNV2_TOKEN=(\S+)/);
  const instanceIdMatch = output.match(/INSTANCE_ID=(\S+)/);
  const eipMatch = output.match(/ELASTIC_IP=(\S+)/);

  if (!hostMatch || !tokenMatch) {
    console.error('Could not parse setup output. Check manually.');
    process.exit(1);
  }

  saveConfig({
    host: hostMatch[1],
    token: tokenMatch[1],
    region,
    instanceType,
    instanceId: instanceIdMatch?.[1],
    elasticIp: eipMatch?.[1],
  });

  console.log('\nConfiguration saved to ~/.synv2/config.json');
  console.log(`Control plane: ${hostMatch[1]}`);

  // Wait for health check
  console.log('Waiting for control plane to come online...');
  const host = hostMatch[1];
  const token = tokenMatch[1];
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${host}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        console.log('Control plane is online!');
        return;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.log('Warning: Control plane did not respond within 5 minutes. It may still be starting up.');
}
