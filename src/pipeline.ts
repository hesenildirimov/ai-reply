import { aiRetryable, generateReply, type Turn } from './ai.js';
import { SendError, sendText, textLimit, type SendOpts } from './channels/index.js';
import { instagramUsername } from './channels/instagram.js';
import type { ChannelRow, InboundEvent } from './channels/types.js';
import { markWhatsAppRead } from './channels/whatsapp.js';
import { config } from './config.js';
import { decrypt } from './crypto.js';
import { one, q } from './db.js';
import { notifyWaiting } from './notify.js';
import { recordEvent } from './events.js';
import { withLock } from './locks.js';
import { queue, redis } from './queue.js';

/** Meta only allows free-form replies within 24h of the customer's last message. */
export const WINDOW_MS = 24 * 3600 * 1000;
const HUMAN_PAUSE = "interval '12 hours'";
const HUMAN_KEYWORDS = /(?<!\p{L})(operator|human|agent|insan|canl[ıi]|menecer|оператор|менеджер|человек)(?!\p{L})/iu;
const MEDIA_PLACEHOLDER = '[Customer sent an attachment (photo/voice/video/sticker) that cannot be viewed]';

export async function ingest(ev: InboundEvent): Promise<void> {
  const ch = await one<ChannelRow>(`SELECT * FROM channels WHERE type = $1 AND external_id = $2 AND status = 'active'`, [ev.channelType, ev.channelExternalId]);
  if (!ch) return;

  if (ev.type === 'echo') {
    // Delay so our own outbound record (written after the send API returns) exists before we compare.
    await queue.add('ig_echo', { kind: 'ig_echo', channelId: ch.id, userId: ev.userId, mid: ev.mid, text: ev.text }, { delay: 5000 });
    return;
  }

  const conv = await one<{ id: string }>(
    `INSERT INTO conversations (workspace_id, channel_id, external_user_id, display_name, last_inbound_at, last_message_at)
     VALUES ($1, $2, $3, $4, now(), now())
     ON CONFLICT (channel_id, external_user_id) DO UPDATE
       SET last_inbound_at = now(), last_message_at = now(),
           display_name = CASE WHEN EXCLUDED.display_name <> '' THEN EXCLUDED.display_name ELSE conversations.display_name END
     RETURNING id`,
    [ch.workspace_id, ch.id, ev.userId, ev.userName.slice(0, 200)],
  );
  const msg = await one<{ id: string }>(
    `INSERT INTO messages (workspace_id, conversation_id, direction, sender, external_id, body)
     VALUES ($1, $2, 'in', 'customer', $3, $4) ON CONFLICT DO NOTHING RETURNING id`,
    [ch.workspace_id, conv!.id, ev.mid, (ev.text ?? MEDIA_PLACEHOLDER).slice(0, 8000)],
  );
  if (!msg) return; // duplicate webhook delivery

  // Read receipt is cosmetic: it must never block storing the message.
  if (ch.type === 'whatsapp') await Promise.resolve().then(() => markWhatsAppRead(decrypt(ch.access_token_enc), ch.external_id, ev.mid)).catch(() => {});
  // Debounce: customers often send several short messages; only the latest job replies.
  await queue.add('reply', { kind: 'reply', conversationId: conv!.id, messageId: msg.id }, { delay: config.AI_DEBOUNCE_MS });
}

interface ConvCtx {
  id: string;
  workspace_id: string;
  external_user_id: string;
  display_name: string;
  needs_human: boolean;
  ai_paused: boolean;
  last_inbound_at: Date | null;
  latest_in: string | null;
  ai_sent: number;
  channel: ChannelRow;
}

async function loadConv(conversationId: string): Promise<ConvCtx | undefined> {
  const row = await one(
    `SELECT c.id, c.workspace_id, c.external_user_id, c.display_name, c.needs_human, c.last_inbound_at,
            coalesce(c.ai_paused_until > now(), false) AS ai_paused,
            (SELECT id FROM messages WHERE conversation_id = c.id AND direction = 'in' ORDER BY created_at DESC LIMIT 1) AS latest_in,
            (SELECT count(*)::int FROM messages WHERE conversation_id = c.id AND sender = 'ai') AS ai_sent,
            to_jsonb(ch.*) AS channel
     FROM conversations c JOIN channels ch ON ch.id = c.channel_id WHERE c.id = $1`,
    [conversationId],
  );
  return row as ConvCtx | undefined;
}

const inWindow = (c: Pick<ConvCtx, 'last_inbound_at'>) => !!c.last_inbound_at && Date.now() - new Date(c.last_inbound_at).getTime() < WINDOW_MS;

/**
 * Idempotent send. The message row is claimed (status 'pending') under its idempotency key BEFORE calling Meta:
 * - key already sent / pending / unknown -> nothing is sent again (returns 'duplicate');
 * - key failed earlier with a definite Meta error -> the stored text is re-sent (no new AI call);
 * - Meta error -> row 'failed' (+ SendError, retryable or not); network error -> row 'unknown', never resent automatically.
 */
export async function deliver(c: Pick<ConvCtx, 'id' | 'workspace_id' | 'external_user_id' | 'channel'>, text: string, sender: 'ai' | 'human', key: string, opts: SendOpts = {}): Promise<'sent' | 'duplicate'> {
  const body = text.slice(0, textLimit(c.channel));
  const claimed =
    (await one<{ id: string; body: string }>(
      `INSERT INTO messages (workspace_id, conversation_id, direction, sender, body, status, idempotency_key)
       VALUES ($1, $2, 'out', $3, $4, 'pending', $5) ON CONFLICT (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id, body`,
      [c.workspace_id, c.id, sender, body, key],
    )) ??
    (await one<{ id: string; body: string }>(
      `UPDATE messages SET status = 'pending', error = NULL WHERE workspace_id = $1 AND idempotency_key = $2 AND status = 'failed' RETURNING id, body`,
      [c.workspace_id, key],
    ));
  if (!claimed) return 'duplicate';
  let mid: string;
  try {
    mid = await sendText(c.channel, c.external_user_id, claimed.body, opts);
  } catch (e) {
    const se = e instanceof SendError ? e : new SendError('network', false, false);
    await q(`UPDATE messages SET status = $2, error = $3 WHERE id = $1`, [claimed.id, se.definite ? 'failed' : 'unknown', se.reason]);
    throw se;
  }
  await q(`UPDATE messages SET status = 'sent', external_id = $2, created_at = now() WHERE id = $1`, [claimed.id, mid]);
  await q('UPDATE conversations SET last_message_at = now() WHERE id = $1', [c.id]);
  return 'sent';
}

/** Body of an earlier attempt that failed definitively, so a retry re-sends it instead of paying for a new AI call. */
const failedBody = async (workspaceId: string, key: string) =>
  (await one<{ body: string; status: string }>(`SELECT body, status FROM messages WHERE workspace_id = $1 AND idempotency_key = $2`, [workspaceId, key])) ?? null;

/** Counts one AI reply against the monthly limit. 'expired' = subscription not paid (paid_until passed). */
export async function reserveReply(workspaceId: string): Promise<'ok' | 'limit' | 'expired'> {
  const ws = await one<{ monthly_reply_limit: number; expired: boolean }>(
    'SELECT monthly_reply_limit, coalesce(paid_until < current_date, false) AS expired FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (!ws || ws.expired) return 'expired';
  if (ws.monthly_reply_limit <= 0) return 'limit';
  const row = await one(
    `INSERT INTO usage_counters (workspace_id, period, ai_replies) VALUES ($1, to_char(now(), 'YYYY-MM'), 1)
     ON CONFLICT (workspace_id, period) DO UPDATE SET ai_replies = usage_counters.ai_replies + 1
     WHERE usage_counters.ai_replies < $2 RETURNING ai_replies`,
    [workspaceId, ws.monthly_reply_limit],
  );
  return row ? 'ok' : 'limit';
}

/** Max AI replies per conversation per hour: stops one spammer from burning the business's monthly quota. */
const CONV_HOURLY_CAP = 15;

async function handoff(c: ConvCtx, holdingReply: string, reason: string, messageId: string): Promise<void> {
  const flipped = await one(`UPDATE conversations SET needs_human = true WHERE id = $1 AND needs_human = false RETURNING id`, [c.id]);
  if (!flipped) return;
  if (holdingReply.trim()) await deliver(c, holdingReply, 'ai', `hold:${messageId}`).catch((e) => console.error('holding reply failed:', (e as Error).message));
  await notifyWaiting(c.workspace_id, c.id, c.display_name || c.external_user_id, c.channel.type, reason);
}

/** Lock TTL must exceed the slowest path: Claude (30 s timeout × 2 tries) + Meta send + DB. */
const CONV_LOCK_MS = 120_000;

/**
 * Handles the newest inbound message of a conversation. Serialized per conversation with a Redis lock
 * ('busy' = another worker is on it; the caller re-queues). `finalAttempt` = last BullMQ try: on AI failure we hand off
 * to staff instead of failing silently.
 */
export async function processReply(conversationId: string, messageId: string, finalAttempt = true): Promise<'done' | 'busy'> {
  const r = await withLock(`conv:${conversationId}`, CONV_LOCK_MS, () => replyLocked(conversationId, messageId, finalAttempt));
  return r === 'busy' ? 'busy' : 'done';
}

async function replyLocked(conversationId: string, messageId: string, finalAttempt: boolean): Promise<void> {
  const c = await loadConv(conversationId);
  // Only the newest message's job acts (debounce); closed window or broken channel = nothing to do.
  if (!c || c.latest_in !== messageId || c.channel.status !== 'active' || !inWindow(c)) return;
  const key = `ai:${messageId}`;
  const earlier = await failedBody(c.workspace_id, key);
  if (earlier && earlier.status !== 'failed') return; // already answered (or possibly answered): never twice
  if (earlier) return void (await deliver(c, earlier.body, 'ai', key)); // resend stored text, no new AI call

  const a = await one(`SELECT * FROM assistants WHERE workspace_id = $1`, [c.workspace_id]);
  const who = c.display_name || c.external_user_id;
  // Staff is handling this conversation (or AI is off): just tell them a new message arrived.
  if (c.needs_human || c.ai_paused || !a?.enabled) return notifyWaiting(c.workspace_id, c.id, who, c.channel.type, 'yeni mesaj');

  const recent = await q<{ sender: string; body: string }>(
    `SELECT sender, body FROM (SELECT sender, body, created_at FROM messages WHERE conversation_id = $1 AND status IN ('received', 'sent') ORDER BY created_at DESC LIMIT 20) t ORDER BY created_at`,
    [c.id],
  );
  const lastText = recent.at(-1)?.body ?? '';
  if (HUMAN_KEYWORDS.test(lastText)) return handoff(c, a.handoff_message, 'müştəri insanla danışmaq istəyir', messageId);

  const hourly = await one<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND sender = 'ai' AND created_at > now() - interval '1 hour'`, [c.id]);
  if (hourly!.n >= CONV_HOURLY_CAP) return handoff(c, '', 'çox sayda mesaj (spam ola bilər)', messageId);

  // Quota is charged once per inbound message, even if this job is retried.
  const firstTry = (await redis.set(`quota:${messageId}`, '1', 'EX', 86400, 'NX')) === 'OK';
  const quota = firstTry ? await reserveReply(c.workspace_id) : 'ok';
  if (quota === 'expired') return notifyWaiting(c.workspace_id, c.id, who, c.channel.type, 'abunəlik bitib, AI cavab vermir');
  if (quota === 'limit') return handoff(c, a.handoff_message, 'aylıq AI limiti bitib', messageId);

  if (c.channel.type === 'instagram' && !c.display_name) {
    const name = await instagramUsername(decrypt(c.channel.access_token_enc), c.external_user_id);
    if (name) await q('UPDATE conversations SET display_name = $2 WHERE id = $1', [c.id, name.slice(0, 200)]);
  }

  const history: Turn[] = recent.map((m) => ({ role: m.sender === 'customer' ? 'user' : 'assistant', text: m.body }));
  let result;
  try {
    result = await generateReply(a, history, a.ai_disclosure && c.ai_sent === 0, { workspaceId: c.workspace_id, conversationId: c.id, purpose: 'reply' });
  } catch (e) {
    await recordEvent(c.workspace_id, c.channel.id, aiRetryable(e) ? 'ai_timeout' : 'ai_error', (e as Error).name);
    if (aiRetryable(e) && !finalAttempt) throw e; // BullMQ retries with backoff
    return handoff(c, a.handoff_message, 'AI cavab verə bilmədi', messageId); // never leave the customer silently unanswered
  }

  // Re-check: a newer message, a human takeover or a pause may have happened while the model ran.
  const fresh = await loadConv(conversationId);
  if (!fresh || fresh.latest_in !== messageId || fresh.needs_human || fresh.ai_paused || !inWindow(fresh)) return;

  if (result.kind === 'handoff') return handoff(fresh, result.holdingReply || a.handoff_message, result.reason, messageId);
  await deliver(fresh, result.text, 'ai', key);
}

/** Instagram echo of a message we did not send through the API = staff replied in the Instagram app. */
export async function processEcho(channelId: string, userId: string, mid: string, text: string): Promise<void> {
  const conv = await one<{ id: string; workspace_id: string }>(
    'SELECT id, workspace_id FROM conversations WHERE channel_id = $1 AND external_user_id = $2',
    [channelId, userId],
  );
  if (!conv) return;
  const inserted = await one(
    `INSERT INTO messages (workspace_id, conversation_id, direction, sender, external_id, body) VALUES ($1, $2, 'out', 'human', $3, $4)
     ON CONFLICT DO NOTHING RETURNING id`,
    [conv.workspace_id, conv.id, mid, text.slice(0, 8000)],
  );
  if (inserted) await q(`UPDATE conversations SET ai_paused_until = now() + ${HUMAN_PAUSE}, last_message_at = now() WHERE id = $1`, [conv.id]);
}

export type ManualResult = 'sent' | 'window_closed' | 'not_found';

/** Staff reply from the inbox. Pauses the AI on that conversation. */
export async function sendManualReply(workspaceId: string, conversationId: string, text: string, nonce: string): Promise<ManualResult> {
  const c = await loadConv(conversationId);
  if (!c || c.workspace_id !== workspaceId) return 'not_found';
  if (!inWindow(c)) return 'window_closed';
  // nonce comes from the form: a double-click or browser resubmit can't send the same reply twice.
  await deliver(c, text, 'human', `human:${nonce}`);
  await q(`UPDATE conversations SET ai_paused_until = now() + ${HUMAN_PAUSE} WHERE id = $1`, [c.id]);
  return 'sent';
}
