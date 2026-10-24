import { generateReply, type Turn } from './ai.js';
import { sendText, textLimit } from './channels/index.js';
import { instagramUsername } from './channels/instagram.js';
import type { ChannelRow, InboundEvent } from './channels/types.js';
import { markWhatsAppRead } from './channels/whatsapp.js';
import { config } from './config.js';
import { decrypt } from './crypto.js';
import { one, q } from './db.js';
import { sendMail } from './mailer.js';
import { queue } from './queue.js';

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

  if (ch.type === 'whatsapp') await markWhatsAppRead(decrypt(ch.access_token_enc), ch.external_id, ev.mid);
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

async function deliver(c: ConvCtx, text: string, sender: 'ai' | 'human'): Promise<void> {
  const body = text.slice(0, textLimit(c.channel));
  const mid = await sendText(c.channel, c.external_user_id, body);
  await q(
    `INSERT INTO messages (workspace_id, conversation_id, direction, sender, external_id, body) VALUES ($1, $2, 'out', $3, $4, $5) ON CONFLICT DO NOTHING`,
    [c.workspace_id, c.id, sender, mid, body],
  );
  await q('UPDATE conversations SET last_message_at = now() WHERE id = $1', [c.id]);
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

async function handoff(c: ConvCtx, handoffMessage: string, reason: string): Promise<void> {
  const flipped = await one(`UPDATE conversations SET needs_human = true WHERE id = $1 AND needs_human = false RETURNING id`, [c.id]);
  if (!flipped) return;
  if (handoffMessage.trim()) await deliver(c, handoffMessage, 'ai');
  const owners = await q<{ email: string }>(
    `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.email_verified_at IS NOT NULL`,
    [c.workspace_id],
  );
  const link = `${config.APP_URL}/app/inbox/${c.id}`;
  await Promise.allSettled(
    owners.map((o) => sendMail(o.email, 'Söhbət operatora ötürüldü', `Müştəri: ${c.display_name || c.external_user_id}\nSəbəb: ${reason}\n\n${link}`)),
  );
}

export async function processReply(conversationId: string, messageId: string): Promise<void> {
  const c = await loadConv(conversationId);
  if (!c || c.channel.status !== 'active' || c.needs_human || c.ai_paused || c.latest_in !== messageId || !inWindow(c)) return;

  const a = await one(`SELECT * FROM assistants WHERE workspace_id = $1`, [c.workspace_id]);
  if (!a?.enabled) return;

  const recent = await q<{ sender: string; body: string }>(
    `SELECT sender, body FROM (SELECT sender, body, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 20) t ORDER BY created_at`,
    [c.id],
  );
  const lastText = recent.at(-1)?.body ?? '';
  if (HUMAN_KEYWORDS.test(lastText)) return handoff(c, a.handoff_message, 'customer asked for a human');

  const quota = await reserveReply(c.workspace_id);
  if (quota === 'expired') return; // unpaid: stay silent, staff answers from the inbox
  if (quota === 'limit') return handoff(c, a.handoff_message, 'monthly AI reply limit reached');

  if (c.channel.type === 'instagram' && !c.display_name) {
    const name = await instagramUsername(decrypt(c.channel.access_token_enc), c.external_user_id);
    if (name) await q('UPDATE conversations SET display_name = $2 WHERE id = $1', [c.id, name.slice(0, 200)]);
  }

  const history: Turn[] = recent.map((m) => ({ role: m.sender === 'customer' ? 'user' : 'assistant', text: m.body }));
  const result = await generateReply(a, history, a.ai_disclosure && c.ai_sent === 0);

  // Re-check: a newer message, a human takeover or a pause may have happened while the model ran.
  const fresh = await loadConv(conversationId);
  if (!fresh || fresh.latest_in !== messageId || fresh.needs_human || fresh.ai_paused || !inWindow(fresh)) return;

  if (result.kind === 'handoff') return handoff(fresh, a.handoff_message, result.reason);
  await deliver(fresh, result.text, 'ai');
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
export async function sendManualReply(workspaceId: string, conversationId: string, text: string): Promise<ManualResult> {
  const c = await loadConv(conversationId);
  if (!c || c.workspace_id !== workspaceId) return 'not_found';
  if (!inWindow(c)) return 'window_closed';
  await deliver(c, text, 'human');
  await q(`UPDATE conversations SET ai_paused_until = now() + ${HUMAN_PAUSE} WHERE id = $1`, [c.id]);
  return 'sent';
}
