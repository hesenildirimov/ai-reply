import { sendWhatsAppTemplate } from './channels/whatsapp.js';
import { config } from './config.js';
import { decrypt } from './crypto.js';
import { q } from './db.js';
import { sendMail } from './mailer.js';
import { redis } from './queue.js';
import { telegramEnabled, tgSend } from './telegram.js';
import { sendPush } from './webpush.js';

const THROTTLE_SECONDS = 600; // at most one alert per conversation every 10 minutes

/** Tells the business a customer is waiting for a human reply, on every channel it connected. Throttled per conversation. */
export async function notifyWaiting(workspaceId: string, conversationId: string, customer: string, channel: string, reason: string): Promise<void> {
  if ((await redis.set(`notify:${conversationId}`, '1', 'EX', THROTTLE_SECONDS, 'NX')) !== 'OK') return;
  const [ws] = await q<{ name: string }>('SELECT name FROM workspaces WHERE id = $1', [workspaceId]);
  const [last] = await q<{ body: string }>(`SELECT body FROM messages WHERE conversation_id = $1 AND direction = 'in' ORDER BY created_at DESC LIMIT 1`, [conversationId]);
  const link = `${config.APP_URL}/app/inbox/${conversationId}`;
  const snippet = (last?.body ?? '').slice(0, 160);
  const business = ws?.name ?? '';
  const where = channel === 'whatsapp' ? 'WhatsApp' : 'Instagram';
  const text = `🔔 ${business}: ${customer} (${where}) cavabınızı gözləyir\n“${snippet}”\nSəbəb: ${reason}\n\nCavab verin: ${link}`;

  const targets = await q<{ id: string; kind: string; chat_id: string; data_enc: string | null }>(`SELECT id, kind, chat_id, data_enc FROM notify_targets WHERE workspace_id = $1`, [workspaceId]);
  const jobs = targets.map(async (t) => {
    if (t.kind === 'telegram' && telegramEnabled()) return tgSend(t.chat_id, text);
    if (t.kind === 'whatsapp' && config.waAlertsEnabled) {
      return sendWhatsAppTemplate(config.PLATFORM_WA_TOKEN!, config.PLATFORM_WA_PHONE_NUMBER_ID!, t.chat_id, config.PLATFORM_WA_TEMPLATE!, config.PLATFORM_WA_TEMPLATE_LANG, [business, `${customer} (${where})`, snippet]);
    }
    if (t.kind === 'webpush' && config.pushEnabled && t.data_enc) {
      const alive = await sendPush(JSON.parse(decrypt(t.data_enc)), { title: `${customer} cavabınızı gözləyir`, body: snippet || reason, url: `/app/inbox/${conversationId}` });
      if (!alive) await q('DELETE FROM notify_targets WHERE id = $1', [t.id]);
    }
  });
  if (config.mailEnabled) {
    const owners = await q<{ email: string }>(
      `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.email_verified_at IS NOT NULL`,
      [workspaceId],
    );
    for (const o of owners) jobs.push(sendMail(o.email, `${customer} cavabınızı gözləyir`, text));
  }
  for (const r of await Promise.allSettled(jobs)) if (r.status === 'rejected') console.error('notify failed:', (r.reason as Error).message);
}
