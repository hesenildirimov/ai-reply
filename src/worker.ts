import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { refreshInstagramToken } from './channels/instagram.js';
import { config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { pool, q } from './db.js';
import { processEcho, processReply } from './pipeline.js';
import { QUEUE, queue, redis, type JobData } from './queue.js';

type Data = JobData | { kind: 'maintenance' };

async function maintenance() {
  await q('DELETE FROM sessions WHERE expires_at < now()');
  await q(`DELETE FROM auth_tokens WHERE expires_at < now() - interval '1 day'`);
  await q('DELETE FROM oauth_states WHERE expires_at < now()');
  // Data minimization: drop old messages and empty conversations.
  await q(`DELETE FROM messages WHERE created_at < now() - make_interval(days => $1)`, [config.RETENTION_DAYS]);
  await q(`DELETE FROM conversations c WHERE last_message_at < now() - make_interval(days => $1) AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)`, [config.RETENTION_DAYS]);

  // Instagram long-lived tokens last 60 days; refresh when <15 days remain.
  const due = await q(`SELECT id, access_token_enc FROM channels WHERE type = 'instagram' AND status = 'active' AND token_expires_at < now() + interval '15 days'`);
  for (const ch of due) {
    try {
      const r = await refreshInstagramToken(decrypt(ch.access_token_enc));
      await q('UPDATE channels SET access_token_enc = $2, token_expires_at = $3 WHERE id = $1', [ch.id, encrypt(r.token), r.expiresAt]);
    } catch (e) {
      console.error(`token refresh failed for channel ${ch.id}`, (e as Error).message);
      await q(`UPDATE channels SET status = 'error' WHERE id = $1 AND token_expires_at < now()`, [ch.id]);
    }
  }
}

const worker = new Worker<Data>(
  QUEUE,
  async (job) => {
    const d = job.data;
    if (d.kind === 'reply') return processReply(d.conversationId, d.messageId);
    if (d.kind === 'ig_echo') return processEcho(d.channelId, d.userId, d.mid, d.text);
    if (d.kind === 'maintenance') return maintenance();
  },
  { connection: new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }), concurrency: 5 },
);

worker.on('failed', (job, err) => console.error(`job ${job?.name} ${job?.id} failed:`, err.message));
await queue.upsertJobScheduler('maintenance', { every: 3600_000 }, { name: 'maintenance', data: { kind: 'maintenance' } as never });
console.log('worker started');

const close = async () => {
  await worker.close();
  await Promise.allSettled([queue.close(), pool.end()]);
  redis.disconnect();
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
