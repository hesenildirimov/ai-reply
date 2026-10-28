import { SendError, type SendOpts, sendText, textLimit } from './channels/index.js';
import type { ChannelRow } from './channels/types.js';
import { one, q } from './db.js';
import { openBody, sealBody } from './messages.js';
import { notifyWaiting } from './notify.js';
import { limitAlert, reserveAutomated } from './plans.js';
import { publish } from './realtime.js';
import { emit } from './webhooks.js';

/** Meta only allows free-form replies within 24h of the customer's last message. */
export const WINDOW_MS = 24 * 3600 * 1000;

export interface ConvCtx {
  id: string;
  workspace_id: string;
  external_user_id: string;
  display_name: string;
  needs_human: boolean;
  ai_paused: boolean;
  last_inbound_at: Date | null;
  latest_in: string | null;
  ai_sent: number;
  contact_id: string | null;
  assignee_user_id: string | null;
  channel: ChannelRow;
}

export async function loadConv(conversationId: string): Promise<ConvCtx | undefined> {
  const row = await one(
    `SELECT c.id, c.workspace_id, c.external_user_id, c.display_name, c.needs_human, c.last_inbound_at,
            coalesce(c.ai_paused_until > now(), false) AS ai_paused,
            (SELECT id FROM messages WHERE conversation_id = c.id AND direction = 'in' ORDER BY created_at DESC LIMIT 1) AS latest_in,
            (SELECT count(*)::int FROM messages WHERE conversation_id = c.id AND sender = 'ai') AS ai_sent,
            c.contact_id, c.assignee_user_id,
            to_jsonb(ch.*) AS channel
     FROM conversations c JOIN channels ch ON ch.id = c.channel_id WHERE c.id = $1`,
    [conversationId],
  );
  return row as ConvCtx | undefined;
}

export const inWindow = (c: Pick<ConvCtx, 'last_inbound_at'>) => !!c.last_inbound_at && Date.now() - new Date(c.last_inbound_at).getTime() < WINDOW_MS;

/**
 * Idempotent send. The message row is claimed (status 'pending') under its idempotency key BEFORE calling Meta:
 * - key already sent / pending / unknown -> nothing is sent again (returns 'duplicate');
 * - key failed earlier with a definite Meta error -> the stored text is re-sent (no new AI call);
 * - Meta error -> row 'failed' (+ SendError, retryable or not); network error -> row 'unknown', never resent automatically.
 */
export async function deliver(
  c: Pick<ConvCtx, 'id' | 'workspace_id' | 'external_user_id' | 'channel'>,
  text: string,
  sender: 'ai' | 'human' | 'bot',
  key: string,
  opts: SendOpts = {},
  kind: 'text' | 'private_reply' = 'text',
): Promise<'sent' | 'duplicate'> {
  const body = text.slice(0, textLimit(c.channel));
  if (sender !== 'human' && !(await reserveAutomated(c.workspace_id, key))) {
    await limitAlert(c.workspace_id, 'bot_messages_month');
    throw new SendError('plan_limit', true, false); // definite, not retryable: nothing was sent
  }
  const sealed = sealBody(body);
  const claimed =
    (await one<{ id: string; body: string; enc: boolean }>(
      `INSERT INTO messages (workspace_id, conversation_id, direction, sender, body, enc, search_tokens, status, idempotency_key, kind)
       VALUES ($1, $2, 'out', $3, $4, true, $5, 'pending', $6, $7) ON CONFLICT (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id, body, enc`,
      [c.workspace_id, c.id, sender, sealed.body, sealed.search_tokens, key, kind],
    )) ??
    (await one<{ id: string; body: string; enc: boolean }>(
      `UPDATE messages SET status = 'pending', error = NULL WHERE workspace_id = $1 AND idempotency_key = $2 AND status = 'failed' RETURNING id, body, enc`,
      [c.workspace_id, key],
    ));
  if (!claimed) return 'duplicate';
  let mid: string;
  try {
    mid = await sendText(c.channel, c.external_user_id, openBody(claimed), opts);
  } catch (e) {
    const se = e instanceof SendError ? e : new SendError('network', false, false);
    // An echo that already carried this message's id (processEcho) proves it was delivered despite the error.
    await q(
      `UPDATE messages SET status = CASE WHEN external_id IS NOT NULL THEN 'sent' ELSE $2 END, error = CASE WHEN external_id IS NOT NULL THEN NULL ELSE $3 END WHERE id = $1`,
      [claimed.id, se.definite ? 'failed' : 'unknown', se.reason],
    );
    throw se;
  }
  // The send API's id is authoritative (an echo may have attached one first, see processEcho); never steal another row's id.
  await q(
    `UPDATE messages SET status = 'sent', error = NULL, created_at = now(),
       external_id = CASE WHEN EXISTS (SELECT 1 FROM messages x WHERE x.conversation_id = messages.conversation_id AND x.external_id = $2 AND x.id <> messages.id) THEN external_id ELSE $2 END
     WHERE id = $1`,
    [claimed.id, mid],
  );
  await q('UPDATE conversations SET last_message_at = now() WHERE id = $1', [c.id]);
  await publish(c.workspace_id, { type: 'message', conversationId: c.id });
  return 'sent';
}

/** Body of an earlier attempt that failed definitively, so a retry re-sends it instead of paying for a new AI call. */
export async function failedBody(workspaceId: string, key: string): Promise<{ body: string; status: string } | null> {
  const row = await one<{ body: string; enc: boolean; status: string }>(
    `SELECT body, enc, status FROM messages WHERE workspace_id = $1 AND idempotency_key = $2`,
    [workspaceId, key],
  );
  return row ? { body: openBody(row), status: row.status } : null;
}

export async function handoff(c: ConvCtx, holdingReply: string, reason: string, messageId: string): Promise<void> {
  const flipped = await one(`UPDATE conversations SET needs_human = true WHERE id = $1 AND needs_human = false RETURNING id`, [c.id]);
  if (!flipped) return;
  // Analytics: counts handed-over conversations (no message text stored).
  await q(`INSERT INTO audit_log (workspace_id, action, target_type, target_id, meta) VALUES ($1, 'conversation.handoff', 'conversation', $2, $3)`, [
    c.workspace_id,
    c.id,
    JSON.stringify({ reason: reason.slice(0, 80) }),
  ]);
  await emit(c.workspace_id, 'conversation.handoff', { conversation_id: c.id, contact_id: c.contact_id, channel: c.channel.type, reason: reason.slice(0, 80) });
  if (holdingReply.trim()) await deliver(c, holdingReply, 'ai', `hold:${messageId}`).catch((e) => console.error('holding reply failed:', (e as Error).message));
  await notifyWaiting(c.workspace_id, c.id, c.display_name || c.external_user_id, c.channel.type, reason);
}
