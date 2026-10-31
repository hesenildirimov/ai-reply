import type { InlineButton, SendResult, TelegramProvider } from './types.js';

let counter = 0;
// Telegram message ids are integers; the simulator turns them back into callback updates.
const messageId = () => String(Date.now() * 1000 + (counter++ % 1000));

/**
 * Telegram stand-in for INTEGRATION_MODE=mock: no request to api.telegram.org, every result is SIMULATED. The text and
 * keyboard of each "sent" message are kept in the integration event feed, where the dashboard simulator can press the
 * buttons (it then builds a real-shaped callback_query update and feeds it to the same handler the webhook uses).
 */
export class MockTelegramProvider implements TelegramProvider {
  readonly name = 'mock' as const;

  enabled() {
    return true;
  }

  async sendMessage(_chatId: string, _text: string, _kb?: InlineButton[][]): Promise<SendResult> {
    return { id: messageId(), status: 'SIMULATED' };
  }

  async editKeyboard(_chatId: string, id: string, _kb: InlineButton[][]): Promise<SendResult> {
    return { id, status: 'SIMULATED' };
  }

  async answerCallback(id: string): Promise<SendResult> {
    return { id, status: 'SIMULATED' };
  }
}
