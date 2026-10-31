import { decrypt } from '../crypto.js';
import { q } from '../db.js';
import { markReauth, recordEvent } from '../events.js';
import { igSendCards, igSendText, igUnsubscribe } from '../integrations/ig.js';
import type { Card, SendResult } from '../integrations/types.js';
import { notifyChannelProblem } from '../notify.js';
import { GraphError } from './graph.js';
import type { ChannelRow } from './types.js';
import { sendWhatsAppText, unsubscribeWhatsApp } from './whatsapp.js';

/**
 * Delivery failure. `definite` = Meta answered with an error, so nothing was sent and a retry is safe when `retryable`.
 * Not definite (network error/timeout after the request left) = it may have been sent: never resend automatically.
 */
export class SendError extends Error {
  constructor(
    readonly reason: string,
    readonly definite: boolean,
    readonly retryable: boolean,
  ) {
    super(`send failed: ${reason}`);
  }
}

export interface SendOpts {
  /** Instagram private reply: recipient is the comment, not the user. */
  commentId?: string;
  quickReplies?: { title: string; payload: string }[];
  /** Instagram Generic Template (product carousel) instead of plain text; the text then only labels the stored message. */
  cards?: Card[];
}

/**
 * Sends one message. Instagram goes through the configured provider (real Meta API, or the mock in INTEGRATION_MODE=mock);
 * the result carries the provider's status: DELIVERED only when a real provider confirmed, SIMULATED in mock mode.
 */
export async function sendText(ch: ChannelRow, to: string, text: string, opts: SendOpts = {}): Promise<SendResult> {
  try {
    if (ch.type === 'whatsapp') {
      return { id: await sendWhatsAppText(decrypt(ch.access_token_enc), ch.external_id, to, text, opts.quickReplies), status: 'DELIVERED' };
    }
    const recipient = { userId: to, commentId: opts.commentId };
    return opts.cards?.length ? await igSendCards(ch, recipient, opts.cards) : await igSendText(ch, recipient, text, opts.quickReplies);
  } catch (e) {
    if (!(e instanceof GraphError)) throw new SendError('network', false, false);
    if (e.tokenInvalid) {
      if (await markReauth(ch.id, 'Giriş icazəsinin vaxtı bitib və ya ləğv edilib')) {
        await recordEvent(ch.workspace_id, ch.id, 'token_invalid', String(e.code ?? e.status));
        await notifyChannelProblem(ch);
      }
      throw new SendError('token_invalid', true, false);
    }
    await recordEvent(ch.workspace_id, ch.id, e.rateLimited ? 'rate_limit' : 'api_error', String(e.code ?? e.status));
    throw new SendError(e.rateLimited ? 'rate_limited' : `api_${e.code ?? e.status}`, true, e.retryable);
  }
}

/** Stops webhook delivery for this channel (best effort) and deletes it with all its conversations. */
export async function removeChannel(ch: ChannelRow): Promise<void> {
  try {
    if (ch.type === 'whatsapp' && ch.waba_id) await unsubscribeWhatsApp(decrypt(ch.access_token_enc), ch.waba_id);
    if (ch.type === 'instagram') await igUnsubscribe(ch);
  } catch {
    // Token may already be revoked; local data is deleted regardless.
  }
  await q('DELETE FROM channels WHERE id = $1', [ch.id]);
}

export const textLimit = (ch: Pick<ChannelRow, 'type'>) => (ch.type === 'whatsapp' ? 4096 : 1000);
