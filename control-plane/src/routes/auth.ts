import { createHash } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { getToken } from '../db/index.js';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized', message: 'Bearer token required' });
    return;
  }

  const token = header.slice(7);
  const hash = createHash('sha256').update(token).digest('hex');
  const row = getToken(hash);

  if (!row) {
    res.status(401).json({ error: 'unauthorized', message: 'Invalid token' });
    return;
  }

  next();
}

// For WebSocket upgrade authentication (from query param)
export function authenticateWsToken(token: string): boolean {
  const hash = createHash('sha256').update(token).digest('hex');
  return !!getToken(hash);
}
