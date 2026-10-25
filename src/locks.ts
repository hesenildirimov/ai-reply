import { randomBytes } from 'node:crypto';
import { redis } from './queue.js';

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * Runs fn while holding a Redis lock (SET NX PX). Returns 'busy' without running when another worker holds it.
 * The TTL must exceed the slowest fn (AI call + send) so the lock never expires mid-run.
 */
export async function withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T | 'busy'> {
  const token = randomBytes(12).toString('hex');
  if ((await redis.set(`lock:${key}`, token, 'PX', ttlMs, 'NX')) !== 'OK') return 'busy';
  try {
    return await fn();
  } finally {
    await redis.eval(RELEASE, 1, `lock:${key}`, token).catch(() => {});
  }
}
