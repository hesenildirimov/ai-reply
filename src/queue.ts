import type { InboundEvent } from './channels/types.js';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config.js';

export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const QUEUE = 'messages';
export type JobData =
  | { kind: 'reply'; conversationId: string; messageId: string }
  | { kind: 'ig_echo'; channelId: string; userId: string; mid: string; text: string }
  | { kind: 'learn_style'; workspaceId: string }
  | { kind: 'comment'; event: Extract<InboundEvent, { type: 'comment' }> }
  | { kind: 'automation_step'; runId: string; step: number }
  | { kind: 'summarize'; conversationId: string; workspaceId: string };

export const queue = new Queue<JobData>(QUEUE, {
  connection: redis,
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: { age: 3600 }, removeOnFail: { age: 7 * 86400 } },
});
