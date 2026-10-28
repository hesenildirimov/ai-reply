export { deliver, WINDOW_MS } from './conversation.js';

import { aiRetryable, generateReply } from './ai.js';
import { aiConfig } from './aiconfig.js';
import { runMessageAutomations } from './automations/engine.js';
import { reserveReply } from './billing.js';
import { SendError } from './channels/index.js';
import { instagramUsername } from './channels/instagram.js';
import type { ChannelRow, InboundEvent, Media } from './channels/types.js';
import { afterCommentDm, afterCommentDmRefused, commentOfMessage, holdForApproval, privateReplyOpen, setCommentStatus } from './comments.js';
import { config } from './config.js';
import { type ContactRow, upsertContact } from './contacts.js';
import { buildContext, businessFacts } from './context.js';
import { type ConvCtx, deliver, failedBody, handoff, inWindow, loadConv } from './conversation.js';
import { decrypt, encrypt, sha256 } from './crypto.js';
import { one, q } from './db.js';
import { audit, recordEvent } from './events.js';
import { checkReply } from './guard.js';
import { withLock } from './locks.js';
import { mediaNote } from './media.js';
import { MEDIA_PLACEHOLDER, openBody, openRows, sealBody, sealText, searchTokensOf } from './messages.js';
import { notifyWaiting } from './notify.js';
import { aiBudgetExceeded, automationBlocked, LIMIT_LABELS, limitAlert } from './plans.js';
import { inboundQueue, queue, redis } from './queue.js';
import { publish } from './realtime.js';
import { emit } from './webhooks.js';

// Also Russian in Latin letters ("chelovek", "menedzher"), see language.ts.
const HUMAN_KEYWORDS = /(?<!\p{L})(operator|human|agent|insan|canl[ıi]|menecer|оператор|менеджер|человек|chelovek|menedzher|menedjer|menejer)(?!\p{L})/iu;
const STOP_RE = /^(stop|unsubscribe|dayan|dayandir|dayandır|abunelikden cix|abunəlikdən çıx|стоп)$/i;
const START_RE = /^(start|basla|başla|старт)$/i;

export async function ingest(ev: InboundEvent): Promise<void> {
  if (ev.type === 'comment') {
    // Comments are processed by the worker (one job per comment id: duplicate webhooks collapse).
    await queue.add('comment', { kind: 'comment', sealed: encrypt(JSON.stringify(ev)) }, { jobId: `comment-${ev.commentId}` });
    return;
  }
  const ch = await one<ChannelRow>(`SELECT * FROM channels WHERE type = $1 AND external_id = $2 AND status = 'active'`, [ev.channelType, ev.channelExternalId]);
  if (!ch) return;

  if (ev.type === 'echo') {
    // No fixed delay: processEcho identifies our own sends by state, not by timing.
    await inboundQueue.add(
      'ig_echo',
      { kind: 'ig_echo', channelId: ch.id, userId: ev.userId, mid: ev.mid, sealed: encrypt(ev.text) },
      { jobId: `echo-${ch.id}-${sha256(ev.mid).toString('hex').slice(0, 32)}` },
    );
    return;
  }

  const contact = await upsertContact(ch, ev.userId, ev.userName);
  if (contact.blocked) return; // blocked contacts are ignored entirely
  const conv = await one<{ id: string; display_name: string }>(
    `INSERT INTO conversations (workspace_id, channel_id, external_user_id, display_name, contact_id, last_inbound_at, last_message_at, unread_count)
     VALUES ($1, $2, $3, $4, $5, now(), now(), 1)
     ON CONFLICT (channel_id, external_user_id) DO UPDATE
       SET last_inbound_at = now(), last_message_at = now(), contact_id = EXCLUDED.contact_id, status = 'open', unread_count = conversations.unread_count + 1,
           display_name = CASE WHEN EXCLUDED.display_name <> '' THEN EXCLUDED.display_name ELSE conversations.display_name END
     RETURNING id, display_name`,
    [ch.workspace_id, ch.id, ev.userId, ev.userName.slice(0, 200), contact.id],
  );
  const body = ev.text ?? (ev.kind === 'story_mention' ? '[Story-də sizi qeyd etdi]' : MEDIA_PLACEHOLDER);
  const sealed = sealBody(body.slice(0, 8000));
  const msg = await one<{ id: string }>(
    `INSERT INTO messages (workspace_id, conversation_id, direction, sender, external_id, body, enc, search_tokens, status, kind, media, payload)
     VALUES ($1, $2, 'in', 'customer', $3, $4, true, $5, 'received', $6, $7, $8) ON CONFLICT DO NOTHING RETURNING id`,
    [
      ch.workspace_id,
      conv!.id,
      ev.mid,
      sealed.body,
      sealed.search_tokens,
      ev.kind ?? 'text',
      ev.media ? JSON.stringify(ev.media) : null,
      ev.payload?.slice(0, 1000) ?? null,
    ],
  );
  if (!msg) {
    await q(`UPDATE conversations SET unread_count = greatest(unread_count - 1, 0) WHERE id = $1`, [conv!.id]); // duplicate delivery
    return;
  }
  // Funnel: the contact answered a flow message within 24h.
  await q(`UPDATE automation_runs SET replied_at = now() WHERE contact_id = $1 AND sent_at > now() - interval '24 hours' AND replied_at IS NULL`, [contact.id]);
  await publish(ch.workspace_id, { type: 'message', conversationId: conv!.id });
  await emit(ch.workspace_id, 'message.received', {
    message_id: msg.id,
    conversation_id: conv!.id,
    contact_id: contact.id,
    channel: ch.type,
    kind: ev.kind ?? 'text',
    text: body.slice(0, 2000),
    contact: { username: contact.username, name: contact.display_name },
  });

  // Instagram webhooks carry no name: look the username up once, off the reply path (inbox display only).
  if (ch.type === 'instagram' && !conv!.display_name)
    await inboundQueue.add('ig_profile', { kind: 'ig_profile', conversationId: conv!.id }, { attempts: 2, jobId: `profile-${conv!.id}` }).catch(() => {});
  // Read receipt + typing indicator: cosmetic, its own job (one try), so a slow Graph call never delays anything.
  if (ch.type === 'whatsapp')
    await inboundQueue.add('wa_read', { kind: 'wa_read', channelId: ch.id, mid: ev.mid }, { attempts: 1, jobId: `read-${msg.id}` }).catch(() => {});
  // Debounce: customers often send several short messages; only the latest job replies.
  await queue.add('reply', { kind: 'reply', conversationId: conv!.id, messageId: msg.id }, { delay: config.AI_DEBOUNCE_MS, jobId: `reply-${msg.id}` });
}

/** Lock TTL must exceed the slowest path: Claude (30 s timeout × 2 tries) + Meta send + DB. */
const CONV_LOCK_MS = 300_000; // also covers media analysis (download, ffmpeg, speech-to-text, one vision call)

/**
 * Handles the newest inbound message of a conversation. Serialized per conversation with a Redis lock
 * ('busy' = another worker is on it; the caller re-queues). `finalAttempt` = last BullMQ try: on AI failure we hand off
 * to staff instead of failing silently.
 */
export async function processReply(conversationId: string, messageId: string, finalAttempt = true): Promise<'done' | 'busy' | 'throttled'> {
  const r = await withLock(`conv:${conversationId}`, CONV_LOCK_MS, () => replyLocked(conversationId, messageId, finalAttempt));
  return r === 'busy' || r === 'throttled' ? r : 'done';
}

/** Writes the media note (src/media.ts) of each unanswered customer message with attachments. */
async function annotateMedia(c: ConvCtx, finalAttempt: boolean): Promise<void> {
  const pending = await q<{ id: string; media: Media[] }>(
    `SELECT id, media FROM messages WHERE conversation_id = $1 AND direction = 'in' AND media IS NOT NULL AND media_text IS NULL
       AND created_at > coalesce((SELECT max(created_at) FROM messages WHERE conversation_id = $1 AND direction = 'out'), '-infinity')
     ORDER BY created_at LIMIT 5`,
    [c.id],
  );
  for (const m of pending) {
    let note: string;
    try {
      note = await mediaNote(c.channel, m.media, { workspaceId: c.workspace_id, conversationId: c.id });
    } catch (e) {
      if (aiRetryable(e) && !finalAttempt) throw e; // Claude busy: the job retries
      note = '[Fayl: baxmaq mümkün olmadı]';
    }
    // Transcripts and descriptions become searchable in the inbox too.
    await q(`UPDATE messages SET media_text = $2, search_tokens = search_tokens || $3::text[] WHERE id = $1 AND media_text IS NULL`, [
      m.id,
      sealText(note),
      searchTokensOf(note),
    ]);
  }
}

async function replyLocked(conversationId: string, messageId: string, finalAttempt: boolean): Promise<void | 'throttled'> {
  const c = await loadConv(conversationId);
  // Only the newest message's job acts (debounce); broken channel = nothing to do.
  if (!c || c.latest_in !== messageId || c.channel.status !== 'active') return;
  // A comment (src/comments.ts) outside the 24 h window is answered with Meta's one private reply to that comment.
  const comment = await commentOfMessage(messageId);
  const via = !inWindow(c) && comment && privateReplyOpen(comment) ? { opts: { commentId: comment.id }, kind: 'private_reply' as const } : undefined;
  if (!inWindow(c) && !via) return; // closed window: nothing to do
  const key = `ai:${messageId}`;
  const send = async (conv: ConvCtx, text: string) => {
    try {
      await deliver(conv, text, 'ai', key, via?.opts, via?.kind);
    } catch (e) {
      // Meta refused the private reply for good (e.g. the person accepts no messages): invite them publicly instead.
      if (comment && e instanceof SendError && e.definite && !e.retryable && !['plan_limit', 'token_invalid'].includes(e.reason))
        return afterCommentDmRefused(comment, c.channel);
      throw e;
    }
    if (comment) await afterCommentDm(comment, c.channel);
  };
  const handover = async (conv: ConvCtx, hold: string, reason: string) => {
    if (comment) await setCommentStatus(comment.id, 'handoff');
    return handoff(conv, hold, reason, messageId, via);
  };
  const earlier = await failedBody(c.workspace_id, key);
  if (earlier && earlier.status !== 'failed') return; // already answered (or possibly answered): never twice
  if (earlier) return void (await send(c, earlier.body)); // resend stored text, no new AI call

  const a = await one(`SELECT * FROM assistants WHERE workspace_id = $1`, [c.workspace_id]);
  const who = c.display_name || c.external_user_id;
  // Staff is handling this conversation (assigned / handed over / paused): no bot, just tell them.
  if (c.needs_human || c.ai_paused || c.assignee_user_id) {
    if (comment) await setCommentStatus(comment.id, 'handoff');
    return notifyWaiting(c.workspace_id, c.id, who, c.channel.type, comment ? 'yeni şərh' : 'yeni mesaj');
  }

  const contact = await one<ContactRow>(`SELECT * FROM contacts WHERE id = $1`, [c.contact_id]);
  const latestRow = await one<{ id: string; kind: string; payload: string | null; body: string; enc: boolean }>(
    `SELECT id, kind, payload, body, enc FROM messages WHERE id = $1`,
    [messageId],
  );
  const latest = latestRow && { ...latestRow, body: openBody(latestRow) };
  if (contact && latest) {
    // Opt-out / opt-in keywords (WhatsApp & Instagram policy: honour STOP).
    if (STOP_RE.test(latest.body.trim())) {
      await q(`UPDATE contacts SET opted_out = true WHERE id = $1`, [contact.id]);
      return notifyWaiting(c.workspace_id, c.id, who, c.channel.type, 'müştəri avtomatik mesajları dayandırdı (STOP)');
    }
    if (START_RE.test(latest.body.trim())) await q(`UPDATE contacts SET opted_out = false WHERE id = $1`, [contact.id]);
    else if (contact.opted_out) return notifyWaiting(c.workspace_id, c.id, who, c.channel.type, 'yeni mesaj (avtomatik cavablar söndürülüb)');
    const blocked = await automationBlocked(c.workspace_id);
    if (blocked) {
      await limitAlert(c.workspace_id, blocked);
      return notifyWaiting(c.workspace_id, c.id, who, c.channel.type, `yeni mesaj (tarif limiti: ${LIMIT_LABELS[blocked]})`);
    }
    // Rule-based flows first: they cost no AI tokens. (A comment already went through the comment automations.)
    const since = openRows(
      await q<{ body: string; enc: boolean }>(
        `SELECT body, enc FROM messages WHERE conversation_id = $1 AND direction = 'in' AND created_at > coalesce((SELECT max(created_at) FROM messages WHERE conversation_id = $1 AND direction = 'out'), '-infinity') ORDER BY created_at`,
        [c.id],
      ),
    );
    const auto = comment
      ? 'none'
      : await runMessageAutomations(c, contact, {
          id: latest.id,
          kind: latest.kind,
          payload: latest.payload,
          text: since.map((m) => m.body).join(' ') || latest.body,
        });
    if (auto !== 'none' && auto !== 'ai') return;
  }
  if (!a?.enabled) return notifyWaiting(c.workspace_id, c.id, who, c.channel.type, 'yeni mesaj');

  const lastText = latest?.body ?? '';
  if (HUMAN_KEYWORDS.test(lastText)) return handover(c, a.handoff_message, 'müştəri insanla danışmaq istəyir');

  const hourly = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND sender = 'ai' AND created_at > now() - interval '1 hour'`,
    [c.id],
  );
  if (hourly!.n >= config.AI_CONV_HOURLY_CAP) return handover(c, '', 'çox sayda mesaj (spam ola bilər)');

  // Cost guardrails: workspace AI budget (plan) and a per-minute burst limit.
  const spent = await aiBudgetExceeded(c.workspace_id);
  if (spent) {
    if ((await redis.set(`budget-alert:${c.workspace_id}:${spent.key}:${new Date().toISOString().slice(0, 10)}`, '1', 'EX', 86400, 'NX')) === 'OK') {
      await audit(c.workspace_id, null, 'ai.budget_exceeded', 'workspace', c.workspace_id, { limit: spent.key, used: spent.used, max: spent.limit });
    }
    return handover(c, a.handoff_message, 'AI büdcəsi bitib');
  }
  const minute = Math.floor(Date.now() / 60_000);
  const calls = await redis.incr(`airpm:${c.workspace_id}:${minute}`);
  if (calls === 1) await redis.expire(`airpm:${c.workspace_id}:${minute}`, 120);
  if (calls > config.AI_WORKSPACE_RPM) return 'throttled';

  // Quota is charged once per inbound message, even if this job is retried.
  const firstTry = (await redis.set(`quota:${messageId}`, '1', 'EX', 86400, 'NX')) === 'OK';
  const quota = firstTry ? await reserveReply(c.workspace_id) : 'ok';
  if (quota === 'expired') return notifyWaiting(c.workspace_id, c.id, who, c.channel.type, 'abunəlik bitib, AI cavab vermir');
  if (quota === 'limit') return handover(c, a.handoff_message, 'aylıq AI limiti bitib');

  // Token-efficient context: budgeted recent turns + rolling summary + only the relevant knowledge items.
  // Photos, videos and voice messages since our last answer: looked at / transcribed once, before the AI answers.
  await annotateMedia(c, finalAttempt);
  const ctx = await buildContext(c.id, c.workspace_id);
  if (ctx.unsummarized >= aiConfig.limits.summary_after_messages) {
    await queue.add(
      'summarize',
      { kind: 'summarize', conversationId: c.id, workspaceId: c.workspace_id },
      { jobId: `sum-${c.id}-${Math.floor(Date.now() / 600_000)}` },
    );
  }
  let result: Awaited<ReturnType<typeof generateReply>>;
  try {
    result = await generateReply(
      a,
      ctx.history,
      a.ai_disclosure && c.ai_sent === 0,
      { workspaceId: c.workspace_id, conversationId: c.id, purpose: 'reply', route: ctx.route },
      ctx.extra,
    );
  } catch (e) {
    await recordEvent(c.workspace_id, c.channel.id, aiRetryable(e) ? 'ai_timeout' : 'ai_error', (e as Error).name);
    if (aiRetryable(e) && !finalAttempt) throw e; // BullMQ retries with backoff
    return handover(c, a.handoff_message, 'AI cavab verə bilmədi'); // never leave the customer silently unanswered
  }

  // Re-check: a newer message, a human takeover or a pause may have happened while the model ran.
  const fresh = await loadConv(conversationId);
  if (!fresh || fresh.latest_in !== messageId || fresh.needs_human || fresh.ai_paused || (!inWindow(fresh) && !via)) return;

  const facts = await businessFacts(c.workspace_id, a.knowledge);
  if (result.kind === 'handoff') {
    const hold = result.holdingReply && checkReply(result.holdingReply, facts).ok ? result.holdingReply : a.handoff_message;
    return handover(fresh, hold, result.reason);
  }
  const verdict = checkReply(result.text, facts);
  if (!verdict.ok) {
    await audit(c.workspace_id, null, 'ai.reply_blocked', 'conversation', c.id, { reason: verdict.reason, detail: verdict.detail.slice(0, 80) });
    return handover(
      fresh,
      a.handoff_message,
      verdict.reason === 'unverified_price' ? 'AI bazada olmayan qiymət yazdı (göndərilmədi)' : 'AI tanınmayan link yazdı (göndərilmədi)',
    );
  }
  // Approval mode for comments: staff check the answer first (/app/comments).
  if (comment && a.comment_approval) return holdForApproval(comment, c.id, result.text, who);
  try {
    await send(fresh, result.text);
  } catch (e) {
    // Monthly automated-message allowance used up by concurrent replies: staff takes over, nothing was sent.
    if (e instanceof SendError && e.reason === 'plan_limit')
      return notifyWaiting(c.workspace_id, c.id, who, c.channel.type, 'yeni mesaj (aylıq avtomatik mesaj limiti)');
    throw e;
  }
}

/** Fills in the Instagram @username of a conversation (best effort; Graph returns nothing for some accounts). */
export async function lookupInstagramName(conversationId: string): Promise<void> {
  const c = await loadConv(conversationId);
  if (!c || c.display_name || c.channel.type !== 'instagram' || c.channel.status !== 'active') return;
  const name = await instagramUsername(decrypt(c.channel.access_token_enc), c.external_user_id);
  if (name) await q(`UPDATE conversations SET display_name = $2 WHERE id = $1 AND display_name = ''`, [c.id, name.slice(0, 200)]);
}

const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/**
 * Instagram echoes every message the account sends, ours included. An echo is staff writing in the Instagram app
 * only when it matches none of our own sends. Identification does not depend on timing:
 * 1. a row of ours already carries this Meta message id;
 * 2. a row of ours without a Meta id yet (claimed before the send API was called, see deliver) has the same text:
 *    it is that send, so the id is attached now ('unknown' sends become 'sent': the echo proves delivery);
 * 3. otherwise, while one of our sends in this conversation is still in flight its id is not known yet, so the
 *    caller re-checks shortly ('wait'). `final` (re-check budget spent) decides with what is known.
 * Only then is it a human message: stored and the AI paused for this conversation.
 */
export async function processEcho(channelId: string, userId: string, mid: string, text: string, final = true): Promise<'done' | 'wait'> {
  const conv = await one<{ id: string; workspace_id: string }>('SELECT id, workspace_id FROM conversations WHERE channel_id = $1 AND external_user_id = $2', [
    channelId,
    userId,
  ]);
  if (!conv) return 'done';
  const unmatched = await q<{ id: string; body: string; enc: boolean; status: string }>(
    `SELECT id, body, enc, status FROM messages WHERE conversation_id = $1 AND direction = 'out' AND external_id IS NULL AND status IN ('pending', 'unknown')
       AND created_at > now() - interval '1 day' ORDER BY created_at`,
    [conv.id],
  );
  const mine = unmatched.find((m) => sameText(openBody(m), text));
  if (mine) {
    await q(
      `UPDATE messages SET external_id = $2, status = CASE WHEN status = 'unknown' THEN 'sent' ELSE status END, error = CASE WHEN status = 'unknown' THEN NULL ELSE error END WHERE id = $1 AND external_id IS NULL`,
      [mine.id, mid],
    );
    return 'done';
  }
  if (await one(`SELECT 1 FROM messages WHERE conversation_id = $1 AND external_id = $2`, [conv.id, mid])) return 'done';
  if (!final && unmatched.some((m) => m.status === 'pending')) return 'wait';
  const sealed = sealBody(text.slice(0, 8000));
  const inserted = await one(
    `INSERT INTO messages (workspace_id, conversation_id, direction, sender, external_id, body, enc, search_tokens) VALUES ($1, $2, 'out', 'human', $3, $4, true, $5)
     ON CONFLICT DO NOTHING RETURNING id`,
    [conv.workspace_id, conv.id, mid, sealed.body, sealed.search_tokens],
  );
  if (inserted) {
    await q(`UPDATE conversations SET ai_paused_until = now() + make_interval(mins => $2), last_message_at = now() WHERE id = $1`, [
      conv.id,
      config.HUMAN_PAUSE_MINUTES,
    ]);
    await publish(conv.workspace_id, { type: 'message', conversationId: conv.id });
  }
  return 'done';
}

export type ManualResult = 'sent' | 'window_closed' | 'not_found';

/** Staff reply from the inbox. Pauses the AI on that conversation. */
export async function sendManualReply(workspaceId: string, conversationId: string, text: string, nonce: string): Promise<ManualResult> {
  const c = await loadConv(conversationId);
  if (!c || c.workspace_id !== workspaceId) return 'not_found';
  if (!inWindow(c)) return 'window_closed';
  // nonce comes from the form: a double-click or browser resubmit can't send the same reply twice.
  await deliver(c, text, 'human', `human:${nonce}`);
  await q(`UPDATE conversations SET ai_paused_until = now() + make_interval(mins => $2) WHERE id = $1`, [c.id, config.HUMAN_PAUSE_MINUTES]);
  return 'sent';
}
