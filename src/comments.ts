import { type CommentTriage, triageComment } from './ai.js';
import { capability } from './automations/capabilities.js';
import type { ChannelRow } from './channels/types.js';
import { config } from './config.js';
import { type ContactRow, ensureConversation } from './contacts.js';
import { businessFacts, knowledgeFor } from './context.js';
import { one, q } from './db.js';
import { audit } from './events.js';
import { publicTextOk } from './guard.js';
import { igMediaCaption, igReplyToComment } from './integrations/ig.js';
import { isLatinRussian } from './language.js';
import { openText, sealBody, sealText } from './messages.js';
import { notifyWaiting } from './notify.js';
import { aiBudgetExceeded, automationBlocked, limitAlert } from './plans.js';
import { queue, redis } from './queue.js';
import { publish } from './realtime.js';

/**
 * AI answers to Instagram comments (comments that no keyword automation took).
 *
 * 1. triage (fast model): question / complaint / other, plus a short public reply ("details are in your DM") and a
 *    public invite ("write to us in DM") — no prices, links or phone numbers in either (publicTextOk).
 * 2. other: nothing is posted. complaint: staff are notified, the AI writes nothing.
 * 3. question: the comment joins the commenter's DM conversation as a message ([Şərh: "..."]) and the normal reply
 *    pipeline answers it (knowledge base, price guard, staff pause, limits): inside Meta's 24 h window as a normal DM,
 *    otherwise as the one private reply Meta allows per comment. Only after that DM is sent does the public reply go up
 *    (afterCommentDm), at most once per person per post per day. If Meta refuses the DM, the public invite goes up.
 * With approval on, the DM and public reply wait as drafts until staff press "Göndər" (/app/comments).
 */

const MAX_AI_COMMENTS_PER_PERSON_HOUR = 3; // a person flooding comments costs nothing after this
const PUBLIC_REPLY_EVERY = '24 hours'; // per person per post

export interface CommentRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  media_id: string;
  from_id: string;
  from_username: string;
  body: string;
  ai_status: string | null;
  conversation_id: string | null;
  message_id: string | null;
  public_reply: string;
  public_invite: string;
  dm_draft: string;
  received_at: Date;
}

/** Called by processComment when no keyword automation matched: queues the AI handling (own job, retried on its own). */
export async function queueCommentAi(commentId: string): Promise<void> {
  const on = await one(`SELECT 1 FROM ig_comments c JOIN assistants a ON a.workspace_id = c.workspace_id WHERE c.id = $1 AND a.enabled AND a.comment_ai`, [
    commentId,
  ]);
  if (!on) return;
  await queue.add('comment_ai', { kind: 'comment_ai', commentId }, { jobId: `comment-ai-${commentId}` });
}

export const setCommentStatus = (id: string, status: string, extra: Record<string, unknown> = {}) => {
  const cols = Object.keys(extra);
  return q(`UPDATE ig_comments SET ai_status = $2, handled_at = now()${cols.map((c, i) => `, ${c} = $${i + 3}`).join('')} WHERE id = $1`, [
    id,
    status,
    ...Object.values(extra),
  ]);
};

// Only text that could be a question: emoji, @mentions of friends and punctuation never cost an AI call.
const hasWords = (text: string) => /[\p{L}\p{N}]/u.test(text.replace(/@[\w.]+/g, ''));

/** Job: triage one comment. 'throttled' = workspace AI burst limit, the caller retries later. */
export async function handleCommentAi(commentId: string): Promise<'done' | 'throttled'> {
  const c = await one<CommentRow>(`SELECT * FROM ig_comments WHERE id = $1`, [commentId]);
  if (!c || c.ai_status) return 'done'; // handled already (duplicate job)
  const ch = await one<ChannelRow>(`SELECT * FROM channels WHERE id = $1`, [c.channel_id]);
  const a = await one(`SELECT * FROM assistants WHERE workspace_id = $1`, [c.workspace_id]);
  if (ch?.status !== 'active' || !a?.enabled || !a.comment_ai || capability('comment', ch).status !== 'available') return 'done';
  const skip = async (extra: Record<string, unknown> = {}) => {
    await setCommentStatus(c.id, 'skipped', extra);
    return 'done' as const;
  };
  if ((a.comment_excluded_media as string[]).includes(c.media_id)) return skip();
  const contact = await one<ContactRow>(`SELECT * FROM contacts WHERE channel_id = $1 AND external_id = $2`, [ch.id, c.from_id]);
  if (!contact || contact.blocked || contact.opted_out) return skip();
  if (!hasWords(c.body)) return skip(); // no AI call, so it does not count towards the per-person limit below
  const recent = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM ig_comments WHERE channel_id = $1 AND from_id = $2 AND ai_category IS NOT NULL AND received_at > now() - interval '1 hour'`,
    [ch.id, c.from_id],
  );
  if (recent!.n >= MAX_AI_COMMENTS_PER_PERSON_HOUR) return skip();

  const blocked = await automationBlocked(c.workspace_id);
  if (blocked) {
    await limitAlert(c.workspace_id, blocked);
    return 'done';
  }
  const spent = await aiBudgetExceeded(c.workspace_id);
  if (spent) {
    if ((await redis.set(`budget-alert:${c.workspace_id}:${spent.key}:${new Date().toISOString().slice(0, 10)}`, '1', 'EX', 86400, 'NX')) === 'OK') {
      await audit(c.workspace_id, null, 'ai.budget_exceeded', 'workspace', c.workspace_id, { limit: spent.key, used: spent.used, max: spent.limit });
    }
    return 'done';
  }
  const minute = Math.floor(Date.now() / 60_000);
  const calls = await redis.incr(`airpm:${c.workspace_id}:${minute}`);
  if (calls === 1) await redis.expire(`airpm:${c.workspace_id}:${minute}`, 120);
  if (calls > config.AI_WORKSPACE_RPM) return 'throttled';

  const caption = await cachedCaption(ch, c.media_id);
  const { pinned, knowledge } = await knowledgeFor(c.workspace_id, c.body);
  const t: CommentTriage = await triageComment(
    a,
    { text: c.body, caption },
    { workspaceId: c.workspace_id, purpose: 'comment' },
    { pinnedKnowledge: pinned || undefined, knowledge, latinRussian: isLatinRussian(c.body) },
  );

  if (t.category === 'other') return skip({ ai_category: 'other' });
  const conversationId = await ensureConversation(ch, contact, c.from_id);
  const messageId = await addToConversation(c, conversationId, caption);
  if (t.category === 'complaint') {
    // Staff answer complaints themselves: the conversation is flagged, nothing is sent.
    await q(`UPDATE conversations SET needs_human = true WHERE id = $1`, [conversationId]);
    await q(`INSERT INTO audit_log (workspace_id, action, target_type, target_id, meta) VALUES ($1, 'conversation.handoff', 'conversation', $2, $3)`, [
      c.workspace_id,
      conversationId,
      JSON.stringify({ reason: 'şərhdə şikayət' }),
    ]);
    await setCommentStatus(c.id, 'handoff', { ai_category: 'complaint', conversation_id: conversationId, message_id: messageId });
    await notifyWaiting(c.workspace_id, conversationId, c.from_username ? `@${c.from_username}` : c.from_id, 'instagram', 'şərhdə şikayət (AI cavab yazmadı)');
    return 'done';
  }
  const facts = await businessFacts(c.workspace_id, a.knowledge, knowledge);
  const safe = (s: string) => (publicTextOk(s, facts) ? sealText(s) : '');
  await setCommentStatus(c.id, 'queued', {
    ai_category: 'question',
    conversation_id: conversationId,
    message_id: messageId,
    public_reply: safe(t.publicReply),
    public_invite: safe(t.publicInvite),
  });
  await queue.add('reply', { kind: 'reply', conversationId, messageId }, { delay: config.AI_DEBOUNCE_MS, jobId: `reply-${messageId}` });
  return 'done';
}

async function cachedCaption(ch: ChannelRow, mediaId: string): Promise<string> {
  const key = `igcaption:${mediaId}`;
  const hit = await redis.get(key).catch(() => null);
  if (hit !== null) return openText(hit);
  const caption = await igMediaCaption(ch, mediaId).catch(() => '');
  await redis.set(key, sealText(caption) || '', 'EX', 3600).catch(() => {});
  return caption;
}

/** The comment as an inbound message of the DM conversation, so the AI and staff see it in context. */
async function addToConversation(c: CommentRow, conversationId: string, caption: string): Promise<string> {
  const quote = (s: string) => `"${s.replace(/"/g, "'").replace(/\s+/g, ' ').trim()}"`;
  const body = `[Şərh: ${quote(c.body.slice(0, 1000))}]${caption ? `\n[Post: ${quote(caption.slice(0, 300))}]` : ''}`;
  const sealed = sealBody(body);
  // last_inbound_at stays as it is: a comment does not open Meta's 24 h messaging window.
  const m = await one<{ id: string }>(
    `INSERT INTO messages (workspace_id, conversation_id, direction, sender, external_id, body, enc, search_tokens, status, kind, payload)
     VALUES ($1, $2, 'in', 'customer', $3, $4, true, $5, 'received', 'comment', $6)
     ON CONFLICT DO NOTHING RETURNING id`,
    [c.workspace_id, conversationId, `comment:${c.id}`, sealed.body, sealed.search_tokens, c.id],
  );
  const id =
    m?.id ?? (await one<{ id: string }>(`SELECT id FROM messages WHERE conversation_id = $1 AND external_id = $2`, [conversationId, `comment:${c.id}`]))!.id;
  await q(`UPDATE conversations SET last_message_at = now(), status = 'open', unread_count = unread_count + 1 WHERE id = $1`, [conversationId]);
  await publish(c.workspace_id, { type: 'message', conversationId });
  return id;
}

/** The comment a message stands for (kind 'comment'), for the reply pipeline. */
export const commentOfMessage = (messageId: string) => one<CommentRow>(`SELECT * FROM ig_comments WHERE message_id = $1`, [messageId]);

/** Meta allows the private reply within 7 days of the comment. */
export const privateReplyOpen = (c: Pick<CommentRow, 'received_at'>) => Date.now() - new Date(c.received_at).getTime() < 7 * 86400_000;

/**
 * After the DM answering a comment went out: post the public reply (once per person per post per day) and mark the
 * person's other waiting comments in this conversation as answered too (the DM covered them).
 */
export async function afterCommentDm(c: CommentRow, ch: ChannelRow): Promise<void> {
  await q(`UPDATE ig_comments SET ai_status = 'replied', handled_at = now() WHERE conversation_id = $1 AND ai_status IN ('queued', 'pending_approval')`, [
    c.conversation_id,
  ]);
  await postPublic(c, ch, openText(c.public_reply));
}

/** Meta refused the DM (e.g. the person does not accept messages): ask them publicly to write to us instead. */
export async function afterCommentDmRefused(c: CommentRow, ch: ChannelRow): Promise<void> {
  await setCommentStatus(c.id, 'invited');
  await postPublic(c, ch, openText(c.public_invite));
}

async function postPublic(c: CommentRow, ch: ChannelRow, text: string): Promise<void> {
  if (!text) return;
  const recent = await one(`SELECT 1 FROM ig_comments WHERE channel_id = $1 AND from_id = $2 AND media_id = $3 AND public_replied_at > now() - $4::interval`, [
    c.channel_id,
    c.from_id,
    c.media_id,
    PUBLIC_REPLY_EVERY,
  ]);
  if (recent) return; // one public reply per person per post per day: no wall of identical replies
  // Claim first: a retried job never posts twice.
  const claimed = await one(`UPDATE ig_comments SET public_replied_at = now() WHERE id = $1 AND public_replied_at IS NULL RETURNING id`, [c.id]);
  if (!claimed) return;
  await igReplyToComment(ch, c.id, text).catch(async (e) => {
    await q(`UPDATE ig_comments SET public_replied_at = NULL WHERE id = $1`, [c.id]);
    console.error('public comment reply failed:', (e as Error).message);
  });
}

/** Approval mode: the reply pipeline stores the DM draft and asks staff instead of sending. */
export async function holdForApproval(c: CommentRow, conversationId: string, dmText: string, who: string): Promise<void> {
  await setCommentStatus(c.id, 'pending_approval', { dm_draft: sealText(dmText) });
  await notifyWaiting(c.workspace_id, conversationId, who, 'instagram', 'şərhə AI cavabı təsdiq gözləyir');
}
