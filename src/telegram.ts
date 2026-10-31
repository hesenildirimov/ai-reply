import { config } from './config.js';
import { recordIntegrationEvent } from './integrations/events.js';
import { telegramProvider } from './integrations/index.js';
import { tg } from './integrations/telegram-api.js';
import type { InlineButton, SendResult } from './integrations/types.js';

/** The bot can be used: configured for real, or simulated in mock mode (see src/integrations). */
export const telegramEnabled = () => telegramProvider().enabled();

export interface TgOpts {
  /** When given, the message appears in that business's integration event feed. */
  workspaceId?: string | null;
  keyboard?: InlineButton[][];
  /** Event kind in the feed, e.g. 'notification', 'new_post'. */
  kind?: string;
}

/** Sends a Telegram message through the configured provider (real bot or mock) and records it when the business is known. */
export async function tgSend(chatId: string, text: string, o: TgOpts = {}): Promise<SendResult> {
  const provider = telegramProvider();
  const record = (status: SendResult['status'], extra: { id?: string; error?: string } = {}) =>
    o.workspaceId
      ? recordIntegrationEvent({
          workspaceId: o.workspaceId,
          provider: 'telegram',
          direction: 'out',
          kind: o.kind ?? 'notification',
          status,
          summary: text,
          payload: { chatId, text, keyboard: o.keyboard },
          externalId: extra.id,
          error: extra.error,
        })
      : undefined;
  try {
    const r = await provider.sendMessage(chatId, text, o.keyboard);
    await record(r.status, { id: r.id });
    return r;
  } catch (e) {
    await record('FAILED', { error: 'telegram_api' });
    throw e;
  }
}

export const tgEditKeyboard = (chatId: string, messageId: string, keyboard: InlineButton[][]) => telegramProvider().editKeyboard(chatId, messageId, keyboard);
export const tgAnswerCallback = (callbackQueryId: string, text?: string) => telegramProvider().answerCallback(callbackQueryId, text);

export async function registerTelegramWebhook(): Promise<void> {
  // Mock mode never talks to Telegram; without a real bot configured there is nothing to register.
  if (config.mockMode || !telegramProvider().enabled()) return;
  await tg('setWebhook', {
    url: `${config.APP_URL}/webhooks/telegram`,
    secret_token: config.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
}
