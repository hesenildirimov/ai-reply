export { deliver, WINDOW_MS } from './conversation.js';
import { aiRetryable, generateReply, type Turn } from './ai.js';
import { deliver, failedBody, handoff, inWindow, loadConv, WINDOW_MS } from './conversation.js';
import { instagramUsername } from './channels/instagram.js';
import type { ChannelRow, InboundEvent } from './channels/types.js';
import { markWhatsAppRead } from './channels/whatsapp.js';
import { config } from './config.js';
import { decrypt } from './crypto.js';
import { one, q } from './db.js';
import { notifyWaiting } from './notify.js';
import { runMessageAutomations } from './automations/engine.js';
import { upsertContact, type ContactRow } from './contacts.js';
import { recordEvent } from './events.js';
import { publish } from './realtime.js';
import { withLock } from './locks.js';
import { queue, redis } from './queue.js';

const HUMAN_PAUSE = "interval '12 hours'";
const HUMAN_KEYWORDS = /(?<!\p{L})(operator|human|agent|insan|canl[ıi]|menecer|оператор|менеджер|человек)(?!\p{L})/iu;
const STOP_RE = /^(stop|unsubscribe|dayan|dayandir|dayandır|abunelikden cix|abunəlikdən çıx|стоп)$/i;
const START_RE = /^(start|basla|başla|старт)$/i;
const MEDIA_PLACEHOLDER = '[Customer sent an attachment (photo/voice/video/sticker) that cannot be viewed]';

export async function ingest(ev: InboundEvent): Promise<void> {
  if (ev.type === 'comment') {
    // Comments are processed by the worker (one job per comment id: duplicate webhooks collapse).
    await queue.add('comment', { kind: 'comment', event: ev }, { jobId: `comment-${ev.commentId}` });
    return;
  }
  const ch = await one<ChannelRow>(`SELECT * FROM channels WHERE type = $1 AND external_id = $2 AND status = 'active'`, [ev.channelType, ev.channelExternalId]);
  if (!ch) return;

  if (ev.type === 'echo') {
    // Delay so our own outbound record (written after the send API returns) exists before we compare.
    await queue.add('ig_echo', { kind: 'ig_echo', channelId: ch.id, userId: ev.userId, mid: ev.mid, text: ev.text }, { delay: 5000 });
    return;
  }

  const contact = await upsertContact(ch, ev.userId, ev.userName);
  if (contact.blocked) return; // blocked contacts are ignored entirely
  const conv = await one<{ id: string }>(
    `INSERT INTO conversations (workspace_id, channel_id, external_user_id, display_name, contact_id, last_inbound_at, last_message_at, unread_count)
     VALUES ($1, $2, $3, $4, $5, now(), now(), 1)
     ON CONFLICT (channel_id, external_user_id) DO UPDATE
       SET last_inbound_at = now(), last_message_at = now(), contact_id = EXCLUDED.contact_id, status = 'open', unread_count = conversations.unread_count + 1,
           display_name = CASE WHEN EXCLUDED.display_name <> '' THEN EXCLUDED.display_name ELSE conversations.display_name END
     RETURNING id`,
    [ch.workspace_id, ch.id, ev.userId, ev.userName.slice(0, 200), contact.id],
  );
  const body = ev.text ?? (ev.kind === 'story_mention' ? '[Story-də sizi qeyd etdi]' : MEDIA_PLACEHOLDER);
  const msg = await one<{ id: string }>(
    `INSERT INTO messages (workspace_id, conversation_id, direction, sender, external_id, body, status, kind, media, payload)
     VALUES ($1, $2, 'in', 'customer', $3, $4, 'received', $5, $6, $7) ON CONFLICT DO NOTHING RETURNING id`,
    [ch.workspace_id, conv!.id, ev.mid, body.slice(0, 8000), ev.kind ?? 'text', ev.media ? JSON.stringify(ev.media) : null, ev.payload?.slice(0, 1000) ?? null],
  );
  if (!msg) {
    await q(`UPDATE conversations SET unread_count = greatest(unread_count - 1, 0) WHERE id = $1`, [conv!.id]); // duplicate delivery
    return;
  }
  // Funnel: the contact answered a flow message within 24h.
  await q(`UPDATE automation_runs SET replied_at = now() WHERE contact_id = $1 AND sent_at > now() - interval '24 hours' AND replied_at IS NULL`, [contact.id]);
  await publish(ch.workspace_id, { type: 'message', conversationId: conv!.id });

  // Read receipt is cosmetic: it must never block storing the message.
  if (ch.type === 'whatsapp') await Promise.resolve().then(() => markWhatsAppRead(decrypt(ch.access_token_enc), ch.external_id, ev.mid)).catch(() => {});
  // Debounce: customers often send several short messages; only the latest job replies.
  await queue.add('reply', { kind: 'reply', conversationId: conv!.id, messageId: msg.id }, { delay: config.AI_DEBOUNCE_MS, jobId: `reply-${msg.id}` });
}

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
  // Staff is handling this conversation (assigned / handed over / paused): no bot, just tell them.
  if (c.needs_human || c.ai_paused || c.assignee_user_id) return notifyWaiting(c.workspace_id, c.id, who, c.channel.type, 'yeni mesaj');

  const contact = await one<ContactRow>(`SELECT * FROM contacts WHERE id = $1`, [c.contact_id]);
  const latest = await one<{ id: string; kind: string; payload: string | null; body: string }>(`SELECT id, kind, payload, body FROM messages WHERE id = $1`, [messageId]);
  if (contact && latest) {
    // Opt-out / opt-in keywords (WhatsApp & Instagram policy: honour STOP).
    if (STOP_RE.test(latest.body.trim())) {
      await q(`UPDATE contacts SET opted_out = true WHERE id = $1`, [contact.id]);
      return notifyWaiting(c.workspace_id, c.id, who, c.channel.type, 'müştəri avtomatik mesajları dayandırdı (STOP)');
    }
    if (START_RE.test(latest.body.trim())) await q(`UPDATE contacts SET opted_out = false WHERE id = $1`, [contact.id]);
    else if (contact.opted_out) return notifyWaiting(c.workspace_id, c.id, who, c.channel.type, 'yeni mesaj (avtomatik cavablar söndürülüb)');
    // Rule-based flows first: they cost no AI tokens.
    const since = await q<{ body: string }>(
      `SELECT body FROM messages WHERE conversation_id = $1 AND direction = 'in' AND created_at > coalesce((SELECT max(created_at) FROM messages WHERE conversation_id = $1 AND direction = 'out'), '-infinity') ORDER BY created_at`,
      [c.id],
    );
    const auto = await runMessageAutomations(c, contact, { id: latest.id, kind: latest.kind, payload: latest.payload, text: since.map((m) => m.body).join(' ') || latest.body });
    if (auto !== 'none' && auto !== 'ai') return;
  }
  if (!a?.enabled) return notifyWaiting(c.workspace_id, c.id, who, c.channel.type, 'yeni mesaj');

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
