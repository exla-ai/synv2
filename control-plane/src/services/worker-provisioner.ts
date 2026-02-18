import { execSync } from 'child_process';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as db from '../db/index.js';

const REGION = process.env.AWS_REGION || 'us-east-1';
const WORKER_AGENT_PORT = 18800;
const HEALTH_TIMEOUT_MS = 300_000; // 5 min for EC2 to boot
const HEALTH_INTERVAL_MS = 10_000;

// Disk sizes by instance family (heuristic)
function getDiskSizeGb(instanceType: string): number {
  const family = instanceType.split('.')[0];
  // GPU instances and large compute need more disk
  if (['p3', 'p4', 'p5', 'g4', 'g5', 'g6'].includes(family)) return 200;
  const size = instanceType.split('.')[1];
  if (size?.includes('xlarge')) {
    const multiplier = parseInt(size) || 1;
    if (multiplier >= 24) return 500;
    if (multiplier >= 12) return 200;
    if (multiplier >= 4) return 100;
  }
  return 50;
}

function getControlPlaneHost(): string {
  // Use the control plane's public hostname/IP
  return process.env.CONTROL_PLANE_HOST || '';
}

function getSecurityGroupId(): string {
  // The SG created during setup — should be stored in config or env
  return process.env.SYNV2_SG_ID || '';
}

function getSubnetId(): string {
  return process.env.SYNV2_SUBNET_ID || '';
}

function getIamInstanceProfile(): string {
  return process.env.SYNV2_IAM_PROFILE || '';
}

function getKeyName(): string {
  return process.env.SYNV2_KEY_NAME || '';
}

function findAmi(): string {
  try {
    const amiId = execSync(
      `aws ec2 describe-images --region ${REGION} --owners amazon ` +
      `--filters Name=name,Values='al2023-ami-2023.*-x86_64' Name=state,Values=available ` +
      `--query 'sort_by(Images, &CreationDate)[-1].ImageId' --output text`,
      { timeout: 30_000 }
    ).toString().trim();
    return amiId;
  } catch (err: any) {
    throw new Error(`Failed to find AMI: ${err.message}`);
  }
}

function generateUserData(projectName: string, controlPlaneHost: string, workerToken: string): string {
  // Resolve the worker-user-data.sh template
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const templatePath = resolve(__dirname, '../../../infra/worker-user-data.sh');
  let template: string;
  try {
    template = readFileSync(templatePath, 'utf-8');
  } catch {
    // Fallback: try from /opt/synv2
    template = readFileSync('/opt/synv2/infra/worker-user-data.sh', 'utf-8');
  }

  return template
    .replace(/__PROJECT_NAME__/g, projectName)
    .replace(/__CONTROL_PLANE_HOST__/g, controlPlaneHost)
    .replace(/__WORKER_TOKEN__/g, workerToken)
    .replace(/__WORKER_AGENT_PORT__/g, String(WORKER_AGENT_PORT));
}

export async function provisionWorker(projectName: string, instanceType: string): Promise<string> {
  const controlPlaneHost = getControlPlaneHost();
  if (!controlPlaneHost) throw new Error('CONTROL_PLANE_HOST not configured');

  const sgId = getSecurityGroupId();
  if (!sgId) throw new Error('SYNV2_SG_ID not configured');

  const subnetId = getSubnetId();
  if (!subnetId) throw new Error('SYNV2_SUBNET_ID not configured');

  const workerToken = crypto.randomBytes(32).toString('hex');
  const amiId = findAmi();
  const diskSize = getDiskSizeGb(instanceType);
  const userData = generateUserData(projectName, controlPlaneHost, workerToken);
  const userDataB64 = Buffer.from(userData).toString('base64');

  const iamProfile = getIamInstanceProfile();
  const keyName = getKeyName();

  // Build launch args
  let launchCmd = `aws ec2 run-instances --region ${REGION}` +
    ` --image-id ${amiId}` +
    ` --instance-type ${instanceType}` +
    ` --subnet-id ${subnetId}` +
    ` --security-group-ids ${sgId}` +
    ` --user-data "${userDataB64}"` +
    ` --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":${diskSize},"VolumeType":"gp3"}}]'` +
    ` --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=synv2-worker-${projectName}},{Key=synv2,Value=worker},{Key=synv2-project,Value=${projectName}}]'` +
    ` --query 'Instances[0].[InstanceId,Placement.AvailabilityZone]'` +
    ` --output text`;

  if (iamProfile) {
    launchCmd += ` --iam-instance-profile Name=${iamProfile}`;
  }
  if (keyName) {
    launchCmd += ` --key-name ${keyName}`;
  }

  const output = execSync(launchCmd, { timeout: 60_000 }).toString().trim();
  const [instanceId, az] = output.split('\t');

  if (!instanceId || instanceId === 'None') {
    throw new Error('Failed to launch EC2 instance');
  }

  // Store in DB
  db.insertWorker({
    instance_id: instanceId,
    project_name: projectName,
    instance_type: instanceType,
    private_ip: null,
    public_ip: null,
    status: 'provisioning',
    region: REGION,
    availability_zone: az || null,
    worker_token: workerToken,
    created_at: new Date().toISOString(),
  });

  db.updateProject(projectName, { worker_instance_id: instanceId, instance_type: instanceType });

  // Wait for the instance to get an IP and register
  waitForWorkerReady(instanceId, projectName).catch(err => {
    console.error(`Worker ${instanceId} failed to become ready: ${err.message}`);
    db.updateWorker(instanceId, { status: 'error' as any });
  });

  return instanceId;
}

async function waitForWorkerReady(instanceId: string, projectName: string): Promise<void> {
  // Wait for instance to be running
  execSync(`aws ec2 wait instance-running --region ${REGION} --instance-ids ${instanceId}`, { timeout: 120_000 });

  // Get private IP
  const descOutput = execSync(
    `aws ec2 describe-instances --region ${REGION} --instance-ids ${instanceId}` +
    ` --query 'Reservations[0].Instances[0].[PrivateIpAddress,PublicIpAddress]' --output text`,
    { timeout: 15_000 }
  ).toString().trim();

  const [privateIp, publicIp] = descOutput.split('\t');

  db.updateWorker(instanceId, {
    private_ip: privateIp !== 'None' ? privateIp : null,
    public_ip: publicIp !== 'None' ? publicIp : null,
    status: 'bootstrapping',
  });

  // Poll worker health endpoint until ready
  const workerIp = privateIp !== 'None' ? privateIp : publicIp;
  if (!workerIp || workerIp === 'None') {
    throw new Error('Worker has no reachable IP');
  }

  const start = Date.now();
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    try {
      const res = await fetch(`http://${workerIp}:${WORKER_AGENT_PORT}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        db.updateWorker(instanceId, { status: 'ready', last_heartbeat: new Date().toISOString() });
        console.log(`Worker ${instanceId} for ${projectName} is ready at ${workerIp}`);
        return;
      }
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, HEALTH_INTERVAL_MS));
  }

  throw new Error(`Worker health check timed out after ${HEALTH_TIMEOUT_MS / 1000}s`);
}

export async function terminateWorker(instanceId: string): Promise<void> {
  db.updateWorker(instanceId, { status: 'stopping' });

  try {
    execSync(`aws ec2 terminate-instances --region ${REGION} --instance-ids ${instanceId}`, { timeout: 30_000 });
  } catch (err: any) {
    console.error(`Failed to terminate instance ${instanceId}: ${err.message}`);
  }

  db.updateWorker(instanceId, { status: 'terminated' });
}

export async function resizeWorker(instanceId: string, newInstanceType: string): Promise<void> {
  const worker = db.getWorker(instanceId);
  if (!worker) throw new Error(`Worker ${instanceId} not found`);

  db.updateWorker(instanceId, { status: 'stopping' });

  // Stop the instance
  execSync(`aws ec2 stop-instances --region ${REGION} --instance-ids ${instanceId}`, { timeout: 30_000 });
  execSync(`aws ec2 wait instance-stopped --region ${REGION} --instance-ids ${instanceId}`, { timeout: 180_000 });

  // Change instance type
  execSync(
    `aws ec2 modify-instance-attribute --region ${REGION} --instance-id ${instanceId} --instance-type '{"Value":"${newInstanceType}"}'`,
    { timeout: 15_000 }
  );

  // Start the instance
  execSync(`aws ec2 start-instances --region ${REGION} --instance-ids ${instanceId}`, { timeout: 30_000 });
  execSync(`aws ec2 wait instance-running --region ${REGION} --instance-ids ${instanceId}`, { timeout: 120_000 });

  // Get updated IPs
  const descOutput = execSync(
    `aws ec2 describe-instances --region ${REGION} --instance-ids ${instanceId}` +
    ` --query 'Reservations[0].Instances[0].[PrivateIpAddress,PublicIpAddress]' --output text`,
    { timeout: 15_000 }
  ).toString().trim();

  const [privateIp, publicIp] = descOutput.split('\t');

  db.updateWorker(instanceId, {
    instance_type: newInstanceType,
    private_ip: privateIp !== 'None' ? privateIp : null,
    public_ip: publicIp !== 'None' ? publicIp : null,
    status: 'bootstrapping',
  });

  db.updateProject(worker.project_name, { instance_type: newInstanceType });

  // Wait for worker agent to come back
  const workerIp = privateIp !== 'None' ? privateIp : publicIp;
  if (!workerIp || workerIp === 'None') {
    throw new Error('Worker has no reachable IP after resize');
  }

  const start = Date.now();
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    try {
      const res = await fetch(`http://${workerIp}:${WORKER_AGENT_PORT}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        db.updateWorker(instanceId, { status: 'ready', last_heartbeat: new Date().toISOString() });
        console.log(`Worker ${instanceId} resized to ${newInstanceType} and ready`);
        return;
      }
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, HEALTH_INTERVAL_MS));
  }

  throw new Error('Worker failed to become ready after resize');
}

export function getWorkerUrl(projectName: string): string | null {
  const worker = db.getWorkerByProject(projectName);
  if (!worker || worker.status !== 'ready') return null;
  const ip = worker.private_ip || worker.public_ip;
  if (!ip) return null;
  return `http://${ip}:${WORKER_AGENT_PORT}`;
}

export function getWorkerWsUrl(projectName: string): string | null {
  const worker = db.getWorkerByProject(projectName);
  if (!worker || worker.status !== 'ready') return null;
  const ip = worker.private_ip || worker.public_ip;
  if (!ip) return null;
  return `ws://${ip}:${WORKER_AGENT_PORT}`;
}

export { WORKER_AGENT_PORT };
