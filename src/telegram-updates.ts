import { handleCatalogCallback } from './commerce/telegram-actions.js';
import { randomToken, sha256 } from './crypto.js';
import { one, q } from './db.js';
import { recordIntegrationEvent } from './integrations/events.js';
import { redis } from './queue.js';
import { tgSend } from './telegram.js';

/**
 * One Telegram update (message or button press) from the real webhook or from the mock simulator: both feed this same
 * function, so account linking and product pickers behave identically in both modes.
 */
export async function handleTelegramUpdate(update: any): Promise<void> {
  if (update?.callback_query) return handleCatalogCallback(update.callback_query);
  const msg = update?.message;
  const chatId = msg?.chat?.id;
  const text = typeof msg?.text === 'string' ? msg.text.trim() : '';
  if (typeof chatId !== 'number' || msg.chat.type !== 'private') return;
  const chat = String(chatId);
  const code = /^\/start ([A-Za-z0-9_-]{10,64})$/.exec(text)?.[1];
  if (code) {
    const raw = await redis.getdel(`tglink:${sha256(code).toString('hex')}`);
    const link = raw ? (JSON.parse(raw) as { workspaceId: string; userId: string }) : null;
    if (!link) {
      await tgSend(chat, 'Link etibarsızdır və ya vaxtı keçib. Paneldə Ayarlar → Bildirişlər bölməsindən yenidən cəhd edin.');
      return;
    }
    const label = [msg.from?.first_name, msg.from?.username && `@${msg.from.username}`].filter(Boolean).join(' ').slice(0, 100);
    await q(`INSERT INTO notify_targets (workspace_id, user_id, kind, chat_id, label) VALUES ($1, $2, 'telegram', $3, $4) ON CONFLICT DO NOTHING`, [
      link.workspaceId,
      link.userId,
      chat,
      label,
    ]);
    const ws = await one('SELECT name FROM workspaces WHERE id = $1', [link.workspaceId]);
    await recordIntegrationEvent({
      workspaceId: link.workspaceId,
      provider: 'telegram',
      direction: 'in',
      kind: 'account_connected',
      status: 'RECEIVED',
      summary: `Telegram hesabı qoşuldu: ${label || chat}`,
    });
    await tgSend(chat, `✅ Bildirişlər qoşuldu: ${ws?.name ?? ''}. Müştəri cavabınızı gözləyəndə burada xəbər verəcəyəm. Dayandırmaq üçün /stop yazın.`, {
      workspaceId: link.workspaceId,
      kind: 'account_connected',
    });
  } else if (text === '/stop') {
    await q(`DELETE FROM notify_targets WHERE kind = 'telegram' AND chat_id = $1`, [chat]);
    await tgSend(chat, 'Bildirişlər dayandırıldı.');
  } else {
    await tgSend(chat, 'Bu bot AI Reply bildirişləri üçündür. Qoşulmaq üçün paneldə Ayarlar → Bildirişlər → "Telegram-ı qoş" düyməsini basın.');
  }
}

/** One-time code (hash in Redis, 15 min) that the bot's /start deep link carries back. */
export async function createTelegramLinkCode(workspaceId: string, userId: string): Promise<string> {
  const code = randomToken(18);
  await redis.set(`tglink:${sha256(code).toString('hex')}`, JSON.stringify({ workspaceId, userId }), 'EX', 900);
  return code;
}
