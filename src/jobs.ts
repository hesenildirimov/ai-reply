import { DelayedError, type Job, UnrecoverableError } from 'bullmq';
import { processComment, resumeRun } from './automations/engine.js';
import { GraphError } from './channels/graph.js';
import { removeChannel, SendError } from './channels/index.js';
import { refreshInstagramToken } from './channels/instagram.js';
import type { ChannelRow } from './channels/types.js';
import { markWhatsAppRead } from './channels/whatsapp.js';
import { handleCommentAi } from './comments.js';
import { config } from './config.js';
import { updateSummary } from './context.js';
import { decrypt, decryptWithInfo, encrypt } from './crypto.js';
import { one, q } from './db.js';
import { markReauth, recordEvent } from './events.js';
import { finishKeyRotation } from './keycheck.js';
import { withLock } from './locks.js';
import { openText, resealIfStale, sealBody, sealText, searchTokensOf } from './messages.js';
import { linkWhatsAppAlerts, notifyChannelProblem } from './notify.js';
import { ingest, lookupInstagramName, processEcho, processReply } from './pipeline.js';
import { type JobData, queue } from './queue.js';
import { learnStyle } from './style.js';
import { SESSION_MAX_DAYS } from './web/auth.js';
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
        await q('UPDATE channels SET access_token_enc = $2, token_expires_at = $3, token_refreshed_at = now() WHERE id = $1', [
          ch.id,
          encrypt(r.token),
          r.expiresAt,
        ]);
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

const BATCH = 1000;
const FREE_TEXT = [
  ['conversations', 'summary'],
  ['conversation_notes', 'body'],
] as const;
type Resealed = { id: string; body: string; tokens: string[]; note?: string | null };
/** One statement for a whole batch of message rows (`note` given = media note re-encrypted too). */
const writeSealed = (rows: Resealed[]) =>
  q(
    `UPDATE messages m SET body = x.body, enc = true, search_tokens = ARRAY(SELECT jsonb_array_elements_text(x.tokens)),
       media_text = CASE WHEN x.note IS NOT NULL THEN x.note ELSE m.media_text END
     FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, body text, tokens jsonb, note text) WHERE m.id = x.id`,
    [JSON.stringify(rows)],
  );

/** Encrypts message text stored before encryption existed (bounded work per maintenance run). */
export async function sealLegacyMessages(budgetMs = 60_000): Promise<number> {
  const until = Date.now() + budgetMs;
  let total = 0;
  while (Date.now() < until) {
    const rows = await q<{ id: string; body: string }>(`SELECT id, body FROM messages WHERE NOT enc ORDER BY id LIMIT ${BATCH}`);
    if (rows.length) await writeSealed(rows.map((r) => ({ id: r.id, ...sealed(r.body) })));
    total += rows.length;
    if (rows.length < BATCH) break;
  }
  // Free text without a flag column: AI summaries and staff notes ("v1:" = already encrypted).
  for (const [table, col] of FREE_TEXT) {
    for (const r of await q<{ id: string; v: string }>(`SELECT id, ${col} AS v FROM ${table} WHERE ${col} <> '' AND ${col} NOT LIKE 'v1:%' LIMIT 5000`)) {
      await q(`UPDATE ${table} SET ${col} = $2 WHERE id = $1 AND ${col} = $3`, [r.id, sealText(r.v), r.v]);
    }
  }
  return total;
}
const sealed = (text: string) => {
  const s = sealBody(text);
  return { body: s.body, tokens: s.search_tokens };
};

/**
 * Key rotation for message text: re-encrypts (and re-indexes) rows still under the previous key, resuming from a
 * cursor so a large table is spread over several maintenance runs. Returns true when every row is done.
 */
async function rotateMessages(budgetMs = 120_000): Promise<boolean> {
  const until = Date.now() + budgetMs;
  let cursor = (await one<{ value: string }>(`SELECT value FROM app_meta WHERE key = 'msg_rotation_cursor'`))?.value ?? '00000000-0000-0000-0000-000000000000';
  while (Date.now() < until) {
    const rows = await q<{ id: string; body: string; media_text: string | null }>(
      `SELECT id, body, media_text FROM messages WHERE enc AND id > $1 ORDER BY id LIMIT ${BATCH}`,
      [cursor],
    );
    const stale = rows.flatMap((r) => {
      const s = resealIfStale(r.body);
      if (!s) return [];
      // Tokens are re-made from both texts, so the media note stays searchable under the new key.
      const note = r.media_text ? openText(r.media_text) : '';
      return [{ id: r.id, body: s.body, tokens: [...s.search_tokens, ...searchTokensOf(note)], note: note ? sealText(note) : null }];
    });
    if (stale.length) await writeSealed(stale);
    if (rows.length < BATCH) {
      await q(`DELETE FROM app_meta WHERE key = 'msg_rotation_cursor'`);
      return true;
    }
    cursor = rows.at(-1)!.id;
    await q(`INSERT INTO app_meta (key, value) VALUES ('msg_rotation_cursor', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [cursor]);
  }
  return false;
}

/** During a key rotation (ENCRYPTION_KEY_PREVIOUS set) re-encrypts every secret and message with the current key. */
export async function reencryptSecrets() {
  if (!process.env.ENCRYPTION_KEY_PREVIOUS) return;
  const cols: [string, string][] = [
    ['channels', 'access_token_enc'],
    ['channels', 'extra_enc'],
    ['users', 'totp_secret_enc'],
    ['notify_targets', 'data_enc'],
    ['webhooks', 'secret_enc'],
  ];
  for (const [table, col] of cols) {
    for (const row of await q(`SELECT id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`)) {
      const { plain, stale } = decryptWithInfo(row.v);
      if (stale) await q(`UPDATE ${table} SET ${col} = $2 WHERE id = $1 AND ${col} = $3`, [row.id, encrypt(plain), row.v]);
    }
  }
  // Encrypted free text (no flag column): summaries, staff notes, pending webhook payloads.
  for (const [table, col] of FREE_TEXT) {
    for (const r of await q<{ id: string; v: string }>(`SELECT id, ${col} AS v FROM ${table} WHERE ${col} LIKE 'v1:%'`)) {
      const { plain, stale } = decryptWithInfo(r.v);
      if (stale) await q(`UPDATE ${table} SET ${col} = $2 WHERE id = $1 AND ${col} = $3`, [r.id, encrypt(plain), r.v]);
    }
  }
  for (const d of await q<{ id: string; enc: string }>(`SELECT id, payload->>'enc' AS enc FROM webhook_deliveries WHERE payload ? 'enc'`)) {
    const { plain, stale } = decryptWithInfo(d.enc);
    if (stale) await q(`UPDATE webhook_deliveries SET payload = jsonb_build_object('enc', $2::text) WHERE id = $1`, [d.id, encrypt(plain)]);
  }
  // Only once nothing under the old key is left may the old key be removed.
  if (await rotateMessages()) await finishKeyRotation();
}

export async function maintenance() {
  await q(`DELETE FROM sessions WHERE expires_at < now() OR created_at < now() - make_interval(days => $1)`, [SESSION_MAX_DAYS]);
  await q(`DELETE FROM auth_tokens WHERE expires_at < now() - interval '1 day'`);
  await q('DELETE FROM oauth_states WHERE expires_at < now()');
  // Data minimization: drop old messages and empty conversations.
  await q(`DELETE FROM messages WHERE created_at < now() - make_interval(days => $1)`, [config.RETENTION_DAYS]);
  await q(
    `DELETE FROM conversations c WHERE last_message_at < now() - make_interval(days => $1) AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)`,
    [config.RETENTION_DAYS],
  );
  await q(`DELETE FROM channel_events WHERE created_at < now() - interval '180 days'`);
  await q(`DELETE FROM webhook_deliveries WHERE created_at < now() - interval '14 days'`);
  // A send that crashed mid-flight stays 'pending'; after 15 min mark it 'unknown' (shown to staff, never auto-resent).
  await q(`UPDATE messages SET status = 'unknown', error = 'interrupted' WHERE status = 'pending' AND created_at < now() - interval '15 minutes'`);
  await refreshTokens();
  await sealLegacyMessages();
  await reencryptSecrets();
}

/**
 * Safety net for jobs lost with Redis data (Redis restarted without persistence, failover): re-queues the reply for
 * recent customer messages that got no answer, no handoff and have no job any more. Safe to repeat: a reply is
 * never sent twice for one message (idempotency key in deliver).
 */
export async function requeueStranded(): Promise<number> {
  const rows = await q<{ id: string; conversation_id: string }>(
    `SELECT m.id, c.id AS conversation_id FROM conversations c
     JOIN LATERAL (SELECT id, created_at FROM messages WHERE conversation_id = c.id AND direction = 'in' ORDER BY created_at DESC LIMIT 1) m ON true
     WHERE c.last_inbound_at BETWEEN now() - interval '30 minutes' AND now() - interval '3 minutes'
       AND NOT c.needs_human AND c.assignee_user_id IS NULL AND (c.ai_paused_until IS NULL OR c.ai_paused_until < now())
       AND EXISTS (SELECT 1 FROM assistants a WHERE a.workspace_id = c.workspace_id AND a.enabled)
       AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.conversation_id = c.id AND o.direction = 'out' AND o.created_at >= m.created_at)
     LIMIT 1000`,
  );
  let n = 0;
  for (const r of rows) {
    if (await queue.getJob(`reply-${r.id}`)) continue; // queued, running, or finished without sending (e.g. a flow answered)
    await queue.add('reply', { kind: 'reply', conversationId: r.conversation_id, messageId: r.id }, { jobId: `reply-${r.id}` });
    n++;
  }
  if (n) console.warn(`requeued ${n} reply job(s) missing from Redis`);
  return n;
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
        return await ingest(JSON.parse(decrypt(d.sealed)));
      case 'reply': {
        const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        const r = await processReply(d.conversationId, d.messageId, final);
        // Busy (another worker holds this conversation) or throttled (workspace AI burst limit): retry later.
        if (r !== 'done') await later(job, token, r === 'busy' ? 3000 : 15000);
        return;
      }
      case 'ig_echo': {
        const tries = d.tries ?? 0;
        const text = d.sealed ? decrypt(d.sealed) : (d.text ?? '');
        if ((await processEcho(d.channelId, d.userId, d.mid, text, tries >= ECHO_CHECKS)) === 'wait') {
          await job.updateData({ ...d, tries: tries + 1 });
          await later(job, token, 2000);
        }
        return;
      }
      case 'wa_read':
        return await waRead(d.channelId, d.mid);
      case 'ig_profile':
        return await lookupInstagramName(d.conversationId);
      case 'wa_partner_removed':
        return await partnerRemoved(d.wabaId);
      case 'wa_alert_link':
        return await linkWhatsAppAlerts(d.waId, d.text);
      case 'learn_style':
        return void (await learnStyle(d.workspaceId));
      case 'comment':
        return await processComment(d.sealed ? JSON.parse(decrypt(d.sealed)) : d.event!);
      case 'comment_ai':
        // Throttled = workspace AI burst limit: retry later without using up an attempt.
        if ((await handleCommentAi(d.commentId)) === 'throttled') await later(job, token, 15000);
        return;
      case 'automation_step':
        return await resumeRun(d.runId, d.step);
      case 'summarize':
        return await updateSummary(d.conversationId, d.workspaceId);
      case 'webhook':
        return await deliverWebhook(d.deliveryId, job.attemptsMade + 1, job.attemptsMade + 1 >= (job.opts.attempts ?? 1));
      case 'maintenance':
        return await maintenance();
      case 'sweep':
        return void (await requeueStranded());
    }
  } catch (e) {
    if (e instanceof DelayedError) throw e;
    rethrow(e);
  }
}
