import { execSync } from 'child_process';

let cachedMeta: { instanceType: string; cpus: number; memoryMb: number } | null = null;

export async function getInstanceMetadata(): Promise<{ instanceType: string; cpus: number; memoryMb: number }> {
  if (cachedMeta) return cachedMeta;

  let instanceType = 'unknown';
  try {
    // IMDSv2: get token first
    const tokenRes = await fetch('http://169.254.169.254/latest/api/token', {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '300' },
      signal: AbortSignal.timeout(2000),
    });
    const token = await tokenRes.text();
    const typeRes = await fetch('http://169.254.169.254/latest/meta-data/instance-type', {
      headers: { 'X-aws-ec2-metadata-token': token },
      signal: AbortSignal.timeout(2000),
    });
    instanceType = await typeRes.text();
  } catch {
    // Not on EC2 or IMDS unavailable
  }

  let cpus = 0;
  let memoryMb = 0;
  try {
    cpus = parseInt(execSync('nproc', { timeout: 5000 }).toString().trim());
  } catch {}
  try {
    const memLine = execSync("free -m | awk '/Mem:/ {print $2}'", { timeout: 5000 }).toString().trim();
    memoryMb = parseInt(memLine);
  } catch {}

  cachedMeta = { instanceType, cpus, memoryMb };
  return cachedMeta;
}
