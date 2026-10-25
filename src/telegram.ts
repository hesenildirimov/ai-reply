import { config } from './config.js';

export const telegramEnabled = () => Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_BOT_USERNAME && config.TELEGRAM_WEBHOOK_SECRET);

/** Telegram Bot API call. The token is part of the URL, so errors never include the URL. */
export async function tg(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${config.TELEGRAM_API_BASE}/bot${config.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${res.status} ${data.description ?? ''}`.trim());
  return data.result;
}

export const tgSend = (chatId: string, text: string) => tg('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } });

export async function registerTelegramWebhook(): Promise<void> {
  if (!telegramEnabled()) return;
  await tg('setWebhook', {
    url: `${config.APP_URL}/webhooks/telegram`,
    secret_token: config.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  });
}
