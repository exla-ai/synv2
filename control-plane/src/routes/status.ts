import { Router } from 'express';
import { execSync } from 'child_process';
import * as db from '../db/index.js';
import { getDockerStats } from '../services/docker.js';

const router = Router();
const startTime = Date.now();

router.get('/', async (_req, res) => {
  const dockerStats = await getDockerStats();
  const projects = db.listProjects().map((p) => ({
    name: p.name,
    status: p.status,
    created_at: p.created_at,
  }));

  // System stats
  let memUsed = 0, memTotal = 0, diskUsed = 0, diskTotal = 0;
  try {
    const memInfo = execSync("free -m 2>/dev/null | awk '/Mem:/{print $2,$3}'", { encoding: 'utf-8' }).trim().split(' ');
    memTotal = parseInt(memInfo[0]) || 0;
    memUsed = parseInt(memInfo[1]) || 0;
  } catch {
    // not linux or free not available
  }

  try {
    const diskInfo = execSync("df -BG / 2>/dev/null | awk 'NR==2{print $2,$3}'", { encoding: 'utf-8' }).trim().split(' ');
    diskTotal = parseInt(diskInfo[0]) || 0;
    diskUsed = parseInt(diskInfo[1]) || 0;
  } catch {
    // fallback
  }

  res.json({
    ok: true,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    docker: dockerStats,
    projects,
    system: {
      memory_used_mb: memUsed,
      memory_total_mb: memTotal,
      disk_used_gb: diskUsed,
      disk_total_gb: diskTotal,
    },
  });
});

export { router as statusRouter };
