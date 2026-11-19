import type { NextFunction, Request, Response } from 'express';
import type { SessionUser } from './auth';

/**
 * Fixed-window request limiter keyed by signed-in user (falls back to IP).
 * In-memory, so it resets on restart and is per process, which matches the
 * single-machine deployment. Used on the AI-backed pipeline routes so a
 * runaway client can't burn provider quota.
 */
export function createRateLimiter(maxRequests: number, windowMs: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, windowMs);
  timer.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user as SessionUser | undefined;
    const key = user?.email?.toLowerCase() || req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    existing.count += 1;
    if (existing.count > maxRequests) {
      res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
      return;
    }
    next();
  };
}
