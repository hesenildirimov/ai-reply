import { randomBytes } from 'node:crypto';
import { q } from '../db.js';
import type { Card, IgAccount, InstagramMedia, InstagramProvider, QuickReply, Recipient, SendResult } from './types.js';

const mid = () => `mock.mid.${randomBytes(8).toString('hex')}`;
const simulated = (): SendResult => ({ id: mid(), status: 'SIMULATED' });

/**
 * Instagram stand-in for INTEGRATION_MODE=mock. It only replaces the network edge: every send is answered SIMULATED
 * (nothing leaves this server, so DELIVERED is impossible), and the account's "posts" are rows of mock_ig_media that the
 * dashboard simulator (src/commerce/simulator.ts) creates. All business logic around it is the real one.
 */
export class MockInstagramProvider implements InstagramProvider {
  readonly name = 'mock' as const;

  async sendText(_a: IgAccount, _to: Recipient, _text: string, _qr?: QuickReply[]): Promise<SendResult> {
    return simulated();
  }

  async sendCards(_a: IgAccount, _to: Recipient, _cards: Card[]): Promise<SendResult> {
    return simulated();
  }

  async replyToComment(_a: IgAccount, _commentId: string, _text: string): Promise<SendResult> {
    return simulated();
  }

  async listRecentMedia(a: IgAccount, limit = 12): Promise<InstagramMedia[]> {
    const rows = await q(`SELECT * FROM mock_ig_media WHERE channel_id = $1 ORDER BY posted_at DESC, media_id DESC LIMIT $2`, [a.channelId, limit]);
    return rows.map((r) => ({
      id: r.media_id,
      caption: r.caption,
      mediaType: r.media_type,
      permalink: r.permalink,
      thumbUrl: r.thumb_url,
      timestamp: new Date(r.posted_at).toISOString(),
    }));
  }

  async mediaCaption(a: IgAccount, mediaId: string): Promise<string> {
    const rows = await q<{ caption: string }>(`SELECT caption FROM mock_ig_media WHERE channel_id = $1 AND media_id = $2`, [a.channelId, mediaId]);
    return rows[0]?.caption ?? '';
  }

  async profileName(): Promise<string> {
    return '';
  }

  async ownMessages(): Promise<string[]> {
    return [];
  }

  async unsubscribe(): Promise<void> {}
}
