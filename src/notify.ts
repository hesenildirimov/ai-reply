import { sendWhatsAppTemplate, sendWhatsAppText } from './channels/whatsapp.js';
import { config } from './config.js';
import { decrypt } from './crypto.js';
import { one, q } from './db.js';
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

/** System alert to the business (Telegram, browser push, email) — e.g. a channel needs to be reconnected. */
export async function notifyChannelProblem(ch: { workspace_id: string; type: string; display_name: string }): Promise<void> {
  const where = ch.type === 'whatsapp' ? 'WhatsApp' : 'Instagram';
  const text = `⚠️ ${where} (${ch.display_name}) bağlantısı yenilənməlidir. Bu vaxta qədər mesajlara avtomatik cavab getmir.\n\nYenidən bağlayın: ${config.APP_URL}/app/channels`;
  const targets = await q<{ id: string; kind: string; chat_id: string; data_enc: string | null }>(`SELECT id, kind, chat_id, data_enc FROM notify_targets WHERE workspace_id = $1`, [ch.workspace_id]);
  const jobs: Promise<unknown>[] = targets.map(async (t) => {
    if (t.kind === 'telegram' && telegramEnabled()) return tgSend(t.chat_id, text);
    if (t.kind === 'webpush' && config.pushEnabled && t.data_enc) return sendPush(JSON.parse(decrypt(t.data_enc)), { title: `${where} bağlantısı yenilənməlidir`, body: ch.display_name, url: '/app/channels' });
  });
  if (config.mailEnabled) {
    const owners = await q<{ email: string }>(`SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.role IN ('owner', 'admin') AND u.email_verified_at IS NOT NULL`, [ch.workspace_id]);
    for (const o of owners) jobs.push(sendMail(o.email, `${where} bağlantısı yenilənməlidir`, text));
  }
  for (const r of await Promise.allSettled(jobs)) if (r.status === 'rejected') console.error('alert failed:', (r.reason as Error).message);
}

/** A message to the platform's own WhatsApp number: "AIREPLY <code>" links that number to a workspace's alerts. */
export async function linkWhatsAppAlerts(waId: string, text: string): Promise<void> {
  const say = (t: string) => sendWhatsAppText(config.PLATFORM_WA_TOKEN!, config.PLATFORM_WA_PHONE_NUMBER_ID!, waId, t).catch(() => {});
  const code = /AIREPLY\s+([A-Z0-9]{8})/i.exec(text)?.[1]?.toUpperCase();
  const raw = code ? await redis.getdel(`walink:${code}`) : null;
  if (!raw) return void (await say('Bildirişləri qoşmaq üçün paneldə Ayarlar → Bildirişlər → "WhatsApp-ı qoş" düyməsini basın.'));
  const link = JSON.parse(raw) as { workspaceId: string; userId: string };
  await q(`INSERT INTO notify_targets (workspace_id, user_id, kind, chat_id, label) VALUES ($1, $2, 'whatsapp', $3, $3) ON CONFLICT DO NOTHING`, [link.workspaceId, link.userId, waId]);
  const ws = await one('SELECT name FROM workspaces WHERE id = $1', [link.workspaceId]);
  await say(`✅ Bildirişlər qoşuldu: ${ws?.name ?? ''}. Müştəri cavabınızı gözləyəndə buraya yazacağıq.`);
}
