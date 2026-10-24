import { decrypt } from '../crypto.js';
import { q } from '../db.js';
import { GraphError } from './graph.js';
import { sendInstagramText, unsubscribeInstagram } from './instagram.js';
import type { ChannelRow } from './types.js';
import { sendWhatsAppText, unsubscribeWhatsApp } from './whatsapp.js';

export async function sendText(ch: ChannelRow, to: string, text: string): Promise<string> {
  const token = decrypt(ch.access_token_enc);
  try {
    return ch.type === 'whatsapp' ? await sendWhatsAppText(token, ch.external_id, to, text) : await sendInstagramText(token, ch.external_id, to, text);
  } catch (e) {
    if (e instanceof GraphError && e.tokenInvalid) await q(`UPDATE channels SET status = 'error' WHERE id = $1`, [ch.id]);
    throw e;
  }
}

/** Stops webhook delivery for this channel (best effort) and deletes it with all its conversations. */
export async function removeChannel(ch: ChannelRow): Promise<void> {
  try {
    const token = decrypt(ch.access_token_enc);
    if (ch.type === 'whatsapp' && ch.waba_id) await unsubscribeWhatsApp(token, ch.waba_id);
    if (ch.type === 'instagram') await unsubscribeInstagram(token);
  } catch {
    // Token may already be revoked; local data is deleted regardless.
  }
  await q('DELETE FROM channels WHERE id = $1', [ch.id]);
}

export const textLimit = (ch: Pick<ChannelRow, 'type'>) => (ch.type === 'whatsapp' ? 4096 : 1000);
