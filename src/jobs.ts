import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { processComment, resumeRun } from './automations/engine.js';
import { removeChannel, SendError } from './channels/index.js';
import { GraphError } from './channels/graph.js';
import { refreshInstagramToken } from './channels/instagram.js';
import type { ChannelRow } from './channels/types.js';
import { markWhatsAppRead } from './channels/whatsapp.js';
import { config } from './config.js';
import { updateSummary } from './context.js';
import { decrypt, decryptWithInfo, encrypt } from './crypto.js';
import { one, q } from './db.js';
import { markReauth, recordEvent } from './events.js';
import { finishKeyRotation } from './keycheck.js';
import { withLock } from './locks.js';
import { linkWhatsAppAlerts, notifyChannelProblem } from './notify.js';
import { ingest, processEcho, processReply } from './pipeline.js';
import type { JobData } from './queue.js';
import { learnStyle } from './style.js';
import { deliverWebhook } from './webhooks.js';

export type Data = JobData | { kind: 'maintenance' };

/** Echo re-checks while one of our own sends is still in flight (see processEcho): 30 × 2 s covers the 15 s send timeout. */
const ECHO_CHECKS = 30;

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

export async function maintenance() {
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

async function waRead(channelId: string, mid: string) {
  const ch = await one<ChannelRow>(`SELECT * FROM channels WHERE id = $1 AND status = 'active'`, [channelId]);
  if (ch) await markWhatsAppRead(decrypt(ch.access_token_enc), ch.external_id, mid);
}

async function partnerRemoved(wabaId: string) {
  for (const ch of await q<ChannelRow>(`SELECT * FROM channels WHERE type = 'whatsapp' AND waba_id = $1`, [wabaId])) await removeChannel(ch);
}

/** Maps failures to BullMQ semantics: permanent ones must not be retried (they would just repeat the error). */
function rethrow(e: unknown): never {
  if (e instanceof SendError && !e.retryable) throw new UnrecoverableError(e.message);
  throw e;
}

/** Re-queues the job without consuming an attempt. */
async function later(job: Job<Data>, token: string | undefined, ms: number): Promise<never> {
  await job.moveToDelayed(Date.now() + ms, token);
  throw new DelayedError();
}

/** The worker's job handler (both queues). */
export async function runJob(job: Job<Data>, token?: string): Promise<void> {
  const d = job.data;
  try {
    switch (d.kind) {
      case 'inbound':
        return await ingest(d.event);
      case 'reply': {
        const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        const r = await processReply(d.conversationId, d.messageId, final);
        // Busy (another worker holds this conversation) or throttled (workspace AI burst limit): retry later.
        if (r !== 'done') await later(job, token, r === 'busy' ? 3000 : 15000);
        return;
      }
      case 'ig_echo': {
        const tries = d.tries ?? 0;
        if ((await processEcho(d.channelId, d.userId, d.mid, d.text, tries >= ECHO_CHECKS)) === 'wait') {
          await job.updateData({ ...d, tries: tries + 1 });
          await later(job, token, 2000);
        }
        return;
      }
      case 'wa_read':
        return await waRead(d.channelId, d.mid);
      case 'wa_partner_removed':
        return await partnerRemoved(d.wabaId);
      case 'wa_alert_link':
        return await linkWhatsAppAlerts(d.waId, d.text);
      case 'learn_style':
        return void (await learnStyle(d.workspaceId));
      case 'comment':
        return await processComment(d.event);
      case 'automation_step':
        return await resumeRun(d.runId, d.step);
      case 'summarize':
        return await updateSummary(d.conversationId, d.workspaceId);
      case 'webhook':
        return await deliverWebhook(d.deliveryId, job.attemptsMade + 1, job.attemptsMade + 1 >= (job.opts.attempts ?? 1));
      case 'maintenance':
        return await maintenance();
    }
  } catch (e) {
    if (e instanceof DelayedError) throw e;
    rethrow(e);
  }
}
