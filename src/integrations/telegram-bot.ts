import { telegramConfigured, tg } from './telegram-api.js';
import type { InlineButton, SendResult, TelegramProvider } from './types.js';

const markup = (kb: InlineButton[][]) => ({ inline_keyboard: kb.map((row) => row.map((b) => ({ text: b.text.slice(0, 64), callback_data: b.callbackData }))) });

/**
 * The real Telegram integration (Bot API). DELIVERED = Telegram's API returned the sent message. Needs
 * TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME and TELEGRAM_WEBHOOK_SECRET; without them enabled() is false and callers
 * skip, as before. Never constructed in mock mode. Inline keyboards / callbacks are not yet verified against the live
 * bot (see META_COMMERCE_VERIFIED).
 */
export class TelegramBotProvider implements TelegramProvider {
  readonly name = 'bot' as const;

  enabled() {
    return telegramConfigured();
  }

  async sendMessage(chatId: string, text: string, keyboard?: InlineButton[][]): Promise<SendResult> {
    const r = await tg('sendMessage', {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(keyboard?.length ? { reply_markup: markup(keyboard) } : {}),
    });
    return { id: String(r?.message_id ?? ''), status: 'DELIVERED' };
  }

  async editKeyboard(chatId: string, messageId: string, keyboard: InlineButton[][]): Promise<SendResult> {
    await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: Number(messageId), reply_markup: markup(keyboard) });
    return { id: messageId, status: 'DELIVERED' };
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<SendResult> {
    await tg('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text: text.slice(0, 200) } : {}) });
    return { id: callbackQueryId, status: 'DELIVERED' };
  }
}
