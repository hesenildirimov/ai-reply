import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config.js';

export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const QUEUE = 'messages';
export type JobData =
  | { kind: 'reply'; conversationId: string; messageId: string }
  | { kind: 'ig_echo'; channelId: string; userId: string; mid: string; text: string };

export const queue = new Queue<JobData>(QUEUE, {
  connection: redis,
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 },
});
