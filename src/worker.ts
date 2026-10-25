import { deliverWebhook } from './webhooks.js';
import { DelayedError, UnrecoverableError, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { processComment, resumeRun } from './automations/engine.js';
import { SendError } from './channels/index.js';
import { GraphError } from './channels/graph.js';
import { refreshInstagramToken } from './channels/instagram.js';
import { config } from './config.js';
import { decryptWithInfo, encrypt } from './crypto.js';
import { pool, q } from './db.js';
import { markReauth, recordEvent } from './events.js';
import { assertEncryptionKey, finishKeyRotation } from './keycheck.js';
import { withLock } from './locks.js';
import { notifyChannelProblem } from './notify.js';
import { processEcho, processReply } from './pipeline.js';
import { QUEUE, queue, redis, type JobData } from './queue.js';
import { learnStyle } from './style.js';
import { updateSummary } from './context.js';

type Data = JobData | { kind: 'maintenance' };

async function refreshTokens() {
  // Instagram long-lived tokens last 60 days; refresh when <15 days remain. One refresher per channel at a time.
  const due = await q(`SELECT * FROM channels WHERE type = 'instagram' AND status = 'active' AND token_expires_at < now() + interval '15 days'`);
  for (const ch of due) {
    await withLock(`refresh:${ch.id}`, 60_000, async () => {
      try {
        const r = await refreshInstagramToken(decryptWithInfo(ch.access_token_enc).plain);
        await q('UPDATE channels SET access_token_enc = $2, token_expires_at = $3, token_refreshed_at = now() WHERE id = $1', [ch.id, encrypt(r.token), r.expiresAt]);
      } catch (e) {
        const invalid = e instanceof GraphError && e.tokenInvalid;
        const expired = new Date(ch.token_expires_at) < new Date();
        if ((invalid || expired) && (await markReauth(ch.id, invalid ? 'İcazə ləğv edilib' : 'Tokenin vaxtı bitib'))) {
          await recordEvent(ch.workspace_id, ch.id, 'token_invalid', 'refresh');
          await notifyChannelProblem(ch);
        }
        console.error(`token refresh failed for channel ${ch.id}:`, (e as Error).message);
      }
    });
  }
}

/** During a key rotation (ENCRYPTION_KEY_PREVIOUS set) re-encrypts every secret with the current key. */
async function reencryptSecrets() {
  if (!process.env.ENCRYPTION_KEY_PREVIOUS) return;
  const cols: [string, string][] = [['channels', 'access_token_enc'], ['channels', 'extra_enc'], ['users', 'totp_secret_enc'], ['notify_targets', 'data_enc'], ['webhooks', 'secret_enc']];
  for (const [table, col] of cols) {
    for (const row of await q(`SELECT id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`)) {
      const { plain, stale } = decryptWithInfo(row.v);
      if (stale) await q(`UPDATE ${table} SET ${col} = $2 WHERE id = $1 AND ${col} = $3`, [row.id, encrypt(plain), row.v]);
    }
  }
  await finishKeyRotation();
}

async function maintenance() {
  await q('DELETE FROM sessions WHERE expires_at < now()');
  await q(`DELETE FROM auth_tokens WHERE expires_at < now() - interval '1 day'`);
  await q('DELETE FROM oauth_states WHERE expires_at < now()');
  // Data minimization: drop old messages and empty conversations.
  await q(`DELETE FROM messages WHERE created_at < now() - make_interval(days => $1)`, [config.RETENTION_DAYS]);
  await q(`DELETE FROM conversations c WHERE last_message_at < now() - make_interval(days => $1) AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)`, [config.RETENTION_DAYS]);
  await q(`DELETE FROM channel_events WHERE created_at < now() - interval '180 days'`);
  await q(`DELETE FROM webhook_deliveries WHERE created_at < now() - interval '14 days'`);
  // A send that crashed mid-flight stays 'pending'; after 15 min mark it 'unknown' (shown to staff, never auto-resent).
  await q(`UPDATE messages SET status = 'unknown', error = 'interrupted' WHERE status = 'pending' AND created_at < now() - interval '15 minutes'`);
  await refreshTokens();
  await reencryptSecrets();
}

/** Maps failures to BullMQ semantics: permanent ones must not be retried (they would just repeat the error). */
function rethrow(e: unknown): never {
  if (e instanceof SendError && !e.retryable) throw new UnrecoverableError(e.message);
  throw e;
}

async function run(job: Job<Data>, token?: string) {
  const d = job.data;
  try {
    if (d.kind === 'reply') {
      const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const r = await processReply(d.conversationId, d.messageId, final);
      if (r !== 'done') {
        // Busy (another worker holds this conversation) or throttled (workspace AI burst limit): retry later
        // without consuming an attempt.
        await job.moveToDelayed(Date.now() + (r === 'busy' ? 3000 : 15000), token);
        throw new DelayedError();
      }
      return;
    }
    if (d.kind === 'ig_echo') return await processEcho(d.channelId, d.userId, d.mid, d.text);
    if (d.kind === 'learn_style') return void (await learnStyle(d.workspaceId));
    if (d.kind === 'comment') return await processComment(d.event);
    if (d.kind === 'automation_step') return await resumeRun(d.runId, d.step);
    if (d.kind === 'summarize') return await updateSummary(d.conversationId, d.workspaceId);
    if (d.kind === 'webhook') return await deliverWebhook(d.deliveryId, job.attemptsMade + 1, job.attemptsMade + 1 >= (job.opts.attempts ?? 1));
    if (d.kind === 'maintenance') return await maintenance();
  } catch (e) {
    if (e instanceof DelayedError) throw e;
    rethrow(e);
  }
}

await assertEncryptionKey();

const worker = new Worker<Data>(QUEUE, run, { connection: new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }), concurrency: 5 });

worker.on('failed', (job, err) => console.error(`job ${job?.name} ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message));
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
