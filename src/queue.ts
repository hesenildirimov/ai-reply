import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { InboundEvent } from './channels/types.js';
import { config } from './config.js';

/**
 * Shared client (queue producers, locks, counters, rate limits). While Redis is unreachable ioredis would hold every
 * command until it reconnects; the command timeout makes callers fail fast instead (webhooks then use the Postgres
 * outbox, see inbound.ts). Worker connections are separate and block by design.
 */
export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, commandTimeout: 2000 });

/** Slow work: AI replies, sends, automations, outgoing webhooks. */
export const QUEUE = 'messages';
/** Fast work right after a Meta webhook: storing the event, read receipts, echo checks. Never waits behind AI calls. */
export const INBOUND_QUEUE = 'inbound';

export type JobData =
  | { kind: 'reply'; conversationId: string; messageId: string }
  | { kind: 'ig_echo'; channelId: string; userId: string; mid: string; text: string; tries?: number }
  | { kind: 'learn_style'; workspaceId: string }
  | { kind: 'comment'; event: Extract<InboundEvent, { type: 'comment' }> }
  | { kind: 'automation_step'; runId: string; step: number }
  | { kind: 'summarize'; conversationId: string; workspaceId: string }
  | { kind: 'webhook'; deliveryId: string }
  | { kind: 'inbound'; event: InboundEvent }
  | { kind: 'wa_read'; channelId: string; mid: string }
  | { kind: 'ig_profile'; conversationId: string }
  | { kind: 'wa_partner_removed'; wabaId: string }
  | { kind: 'wa_alert_link'; waId: string; text: string }
  | { kind: 'sweep' };

// Finished jobs are kept for an hour (duplicate job ids collapse meanwhile) but capped so a traffic spike can't fill Redis.
const keep = { removeOnComplete: { age: 3600, count: 50_000 }, removeOnFail: { age: 7 * 86400, count: 50_000 } };

export const queue = new Queue<JobData>(QUEUE, {
  connection: redis,
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, ...keep },
});

export const inboundQueue = new Queue<JobData>(INBOUND_QUEUE, {
  connection: redis,
  defaultJobOptions: { attempts: 8, backoff: { type: 'exponential', delay: 1000 }, ...keep },
});

export const closeQueues = () => Promise.allSettled([queue.close(), inboundQueue.close()]);
