import { config } from './config.js';
import { q } from './db.js';
import { sendMail } from './mailer.js';
import { redis } from './queue.js';
import { telegramEnabled, tgSend } from './telegram.js';

const THROTTLE_SECONDS = 600; // at most one alert per conversation every 10 minutes

/** Tells the business a customer is waiting for a human reply (Telegram + email), throttled per conversation. */
export async function notifyWaiting(workspaceId: string, conversationId: string, customer: string, channel: string, reason: string): Promise<void> {
  if ((await redis.set(`notify:${conversationId}`, '1', 'EX', THROTTLE_SECONDS, 'NX')) !== 'OK') return;
  const [ws] = await q<{ name: string }>('SELECT name FROM workspaces WHERE id = $1', [workspaceId]);
  const [last] = await q<{ body: string }>(`SELECT body FROM messages WHERE conversation_id = $1 AND direction = 'in' ORDER BY created_at DESC LIMIT 1`, [conversationId]);
  const link = `${config.APP_URL}/app/inbox/${conversationId}`;
  const snippet = (last?.body ?? '').slice(0, 160);
  const text = `🔔 ${ws?.name ?? ''}: ${customer} (${channel === 'whatsapp' ? 'WhatsApp' : 'Instagram'}) cavabınızı gözləyir\n“${snippet}”\nSəbəb: ${reason}\n\nCavab verin: ${link}`;

  const jobs: Promise<unknown>[] = [];
  if (telegramEnabled()) {
    for (const t of await q<{ chat_id: string }>(`SELECT chat_id FROM notify_targets WHERE workspace_id = $1 AND kind = 'telegram'`, [workspaceId])) jobs.push(tgSend(t.chat_id, text));
  }
  if (config.mailEnabled) {
    const owners = await q<{ email: string }>(
      `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.email_verified_at IS NOT NULL`,
      [workspaceId],
    );
    for (const o of owners) jobs.push(sendMail(o.email, `${customer} cavabınızı gözləyir`, text));
  }
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === 'rejected') console.error('notify failed:', (r.reason as Error).message);
}
