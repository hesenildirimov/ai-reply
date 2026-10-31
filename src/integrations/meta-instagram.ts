import {
  instagramOwnMessages,
  instagramUsername,
  listInstagramMedia,
  mediaCaption,
  replyToComment,
  sendInstagramCards,
  sendInstagramText,
  unsubscribeInstagram,
} from '../channels/instagram.js';
import { decrypt } from '../crypto.js';
import type { Card, IgAccount, InstagramMedia, InstagramProvider, QuickReply, Recipient, SendResult } from './types.js';

/**
 * The real Instagram integration (Instagram API with Instagram Login). It wraps the existing Graph calls in
 * src/channels/instagram.ts and throws GraphError exactly like them, so token expiry, rate limits and retries are
 * handled by the callers as before.
 *
 * DELIVERED here means: Meta's API accepted the message and returned a message id. Needs real credentials; it is never
 * constructed in mock mode. Generic Template (sendCards) and the media listing used for new-post detection are not yet
 * verified against the live API: they are only reachable once META_COMMERCE_VERIFIED=on.
 */
export class MetaInstagramProvider implements InstagramProvider {
  readonly name = 'meta' as const;
  private token = (a: IgAccount) => decrypt(a.accessTokenEnc);

  async sendText(a: IgAccount, to: Recipient, text: string, quickReplies?: QuickReply[]): Promise<SendResult> {
    const id = await sendInstagramText(this.token(a), a.externalId, to.userId, text, { commentId: to.commentId, quickReplies });
    return { id, status: 'DELIVERED' };
  }

  async sendCards(a: IgAccount, to: Recipient, cards: Card[]): Promise<SendResult> {
    const id = await sendInstagramCards(this.token(a), a.externalId, to.userId, cards, { commentId: to.commentId });
    return { id, status: 'DELIVERED' };
  }

  async replyToComment(a: IgAccount, commentId: string, text: string): Promise<SendResult> {
    return { id: await replyToComment(this.token(a), commentId, text), status: 'DELIVERED' };
  }

  async listRecentMedia(a: IgAccount, limit?: number): Promise<InstagramMedia[]> {
    return listInstagramMedia(this.token(a), limit);
  }

  mediaCaption(a: IgAccount, mediaId: string): Promise<string> {
    return mediaCaption(this.token(a), mediaId);
  }

  profileName(a: IgAccount, igsid: string): Promise<string> {
    return instagramUsername(this.token(a), igsid);
  }

  ownMessages(a: IgAccount): Promise<string[]> {
    return instagramOwnMessages(this.token(a), a.externalId);
  }

  async unsubscribe(a: IgAccount): Promise<void> {
    await unsubscribeInstagram(this.token(a));
  }
}
