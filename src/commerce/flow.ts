import type { ChannelRow, InboundEvent } from '../channels/types.js';
import { setCommentStatus } from '../comments.js';
import { config } from '../config.js';
import type { ContactRow } from '../contacts.js';
import { ensureConversation } from '../contacts.js';
import { type ConvCtx, deliver, loadConv } from '../conversation.js';
import { q } from '../db.js';
import { automationBlocked, limitAlert } from '../plans.js';
import { normalize } from '../text.js';
import { PRODUCT_PAYLOAD, productAnswer, productBySeq, productCard, productUnavailableAnswer } from './catalog.js';
import { productsOfPost } from './posts.js';

/**
 * Deterministic product flows. No AI is called anywhere in this file: the answers are built from rows of the products
 * table, so they cost nothing and cannot invent a price.
 *
 *   comment "Qiymət?" under a post with saved products
 *     one product  -> the predefined price answer, as the one private reply Meta allows per comment
 *     many         -> a Generic Template carousel (one card per product, button "Qiyməti göstər")
 *   customer taps a card's button (postback "prod:<seq>") -> the predefined answer with the price read from PostgreSQL
 *
 * Posts without saved products, and comments that are not price questions, are left to the other flows (keyword
 * automations, AI comment answers).
 */

// Normalized (see normalize): "Qiymət?" -> "qiymet". Whole words/phrases, in Azerbaijani, Turkish, Russian and English.
const PRICE_WORDS = [
  'qiymet',
  'qiymeti',
  'qiymetler',
  'qiymetini',
  'qiymetdir',
  'neceye',
  'necedir',
  'nece manat',
  'ne qeder',
  'nə qədər',
  'price',
  'how much',
  'cost',
  'fiyat',
  'kac para',
  'цена',
  'цену',
  'сколько',
  'стоит',
  'cena',
  'skolko',
].map(normalize);

export const isPriceQuestion = (text: string) => {
  const t = ` ${normalize(text)} `;
  return PRICE_WORDS.some((w) => t.includes(` ${w} `));
};

/**
 * A comment under a post with saved products that asks for the price. Returns true when this flow answered (or refused
 * on purpose, e.g. plan limit) and the caller must stop; false hands the comment on to the other flows.
 */
export async function handleCatalogComment(ch: ChannelRow, contact: ContactRow, ev: Extract<InboundEvent, { type: 'comment' }>): Promise<boolean> {
  if (!config.commerceEnabled || !isPriceQuestion(ev.text)) return false;
  const products = await productsOfPost(ch.workspace_id, ch.id, ev.mediaId);
  if (!products.length) return false;
  const blocked = await automationBlocked(ch.workspace_id);
  if (blocked) {
    await limitAlert(ch.workspace_id, blocked);
    return true;
  }
  const conversationId = await ensureConversation(ch, contact, ev.fromId);
  const conv = await loadConv(conversationId);
  // Staff are on this conversation (handed over, assigned, or just answered): the bot stays quiet, the usual flow notifies them.
  if (!conv || conv.needs_human || conv.ai_paused || conv.assignee_user_id) return false;

  await q(`UPDATE ig_comments SET matched = true WHERE id = $1`, [ev.commentId]);
  const key = `catalog:${ev.commentId}`;
  try {
    if (products.length === 1) {
      await deliver(conv, productAnswer(products[0]!), 'bot', key, { commentId: ev.commentId }, 'private_reply');
    } else {
      const summary = `🛍 ${products.map((p) => p.name).join(' · ')}`;
      await deliver(conv, summary, 'bot', key, { commentId: ev.commentId, cards: products.map(productCard) }, 'private_reply');
    }
  } catch (e) {
    await setCommentStatus(ev.commentId, 'failed', { conversation_id: conversationId });
    if ((e as { retryable?: boolean }).retryable) throw e; // the comment job is retried; the idempotency key prevents a double send
    return true;
  }
  await setCommentStatus(ev.commentId, 'catalog', { ai_category: 'question', conversation_id: conversationId });
  return true;
}

/**
 * The customer tapped "Qiyməti göstər" on a card. Returns true when answered. The product is read by its number AND the
 * conversation's business, so a payload copied from another business's card finds nothing.
 */
export async function answerProductPostback(conv: ConvCtx, payload: string | null, messageId: string): Promise<boolean> {
  const seq = payload ? PRODUCT_PAYLOAD.exec(payload)?.[1] : undefined;
  if (!config.commerceEnabled || !seq) return false;
  const product = await productBySeq(conv.workspace_id, seq);
  const text = product?.active ? productAnswer(product) : productUnavailableAnswer();
  await deliver(conv, text, 'bot', `catalog:pb:${messageId}`);
  return true;
}
