import { Redis } from 'ioredis';
import { config } from './config.js';
import { redis } from './queue.js';

/** Inbox live updates: workers/web publish small events per workspace; the web process fans them out over SSE. */
export type LiveEvent = { type: 'message' | 'conversation'; conversationId: string };

export const publish = (workspaceId: string, ev: LiveEvent) => redis.publish(`ws:${workspaceId}`, JSON.stringify(ev)).catch(() => 0);

type Listener = (ev: LiveEvent) => void;
const listeners = new Map<string, Set<Listener>>();
let sub: Redis | undefined;

/** Subscribes a listener (one shared Redis subscriber per process). Returns the unsubscribe function. */
export function subscribe(workspaceId: string, fn: Listener): () => void {
  if (!sub) {
    sub = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
    sub.psubscribe('ws:*').catch(() => {});
    sub.on('pmessage', (_p, channel, message) => {
      const set = listeners.get(channel.slice(3));
      if (!set) return;
      try {
        const ev = JSON.parse(message) as LiveEvent;
        for (const l of set) l(ev);
      } catch {}
    });
  }
  const set = listeners.get(workspaceId) ?? new Set();
  set.add(fn);
  listeners.set(workspaceId, set);
  return () => {
    set.delete(fn);
    if (!set.size) listeners.delete(workspaceId);
  };
}

export const closeRealtime = () => sub?.disconnect();
