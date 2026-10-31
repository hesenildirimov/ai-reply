import { GraphError } from '../channels/graph.js';
import type { ChannelRow } from '../channels/types.js';
import { recordIntegrationEvent } from './events.js';
import { instagramProvider } from './index.js';
import type { Card, IgAccount, InstagramMedia, QuickReply, Recipient, SendResult } from './types.js';

type ChannelLike = Pick<ChannelRow, 'id' | 'workspace_id' | 'external_id' | 'access_token_enc'>;

export const acctOf = (ch: ChannelLike): IgAccount => ({
  channelId: ch.id,
  workspaceId: ch.workspace_id,
  externalId: ch.external_id,
  accessTokenEnc: ch.access_token_enc,
});

/** Coarse failure reason for the event feed (never message text, never a token). */
const reasonOf = (e: unknown) => (e instanceof GraphError ? `api_${e.code ?? e.status}` : 'network');

/**
 * Every outbound Instagram call goes through here: the configured provider does the work, and the outcome lands in the
 * integration event feed with the provider's own status (SIMULATED in mock mode, DELIVERED only from the real API).
 */
async function out(ch: ChannelLike, kind: string, summary: string, payload: unknown, run: (a: IgAccount) => Promise<SendResult>): Promise<SendResult> {
  try {
    const r = await run(acctOf(ch));
    await recordIntegrationEvent({
      workspaceId: ch.workspace_id,
      provider: 'instagram',
      direction: 'out',
      kind,
      status: r.status,
      summary,
      payload,
      externalId: r.id,
    });
    return r;
  } catch (e) {
    await recordIntegrationEvent({
      workspaceId: ch.workspace_id,
      provider: 'instagram',
      direction: 'out',
      kind,
      status: 'FAILED',
      summary,
      payload,
      error: reasonOf(e),
    });
    throw e;
  }
}

export const igSendText = (ch: ChannelLike, to: Recipient, text: string, quickReplies?: QuickReply[]) =>
  out(
    ch,
    to.commentId ? 'private_reply' : 'dm',
    `${to.commentId ? 'Şəxsi cavab (şərhə)' : 'DM'}: ${text}`,
    { to: to.userId, commentId: to.commentId, text, quickReplies },
    (a) => instagramProvider().sendText(a, to, text, quickReplies),
  );

export const igSendCards = (ch: ChannelLike, to: Recipient, cards: Card[]) =>
  out(ch, 'cards', `Məhsul kartları (${cards.length}): ${cards.map((c) => c.title).join(', ')}`, { to: to.userId, commentId: to.commentId, cards }, (a) =>
    instagramProvider().sendCards(a, to, cards),
  );

export const igReplyToComment = (ch: ChannelLike, commentId: string, text: string) =>
  out(ch, 'public_reply', `İctimai cavab: ${text}`, { commentId, text }, (a) => instagramProvider().replyToComment(a, commentId, text));

export const igListRecentMedia = (ch: ChannelLike, limit?: number): Promise<InstagramMedia[]> => instagramProvider().listRecentMedia(acctOf(ch), limit);

/** Posts for the automation / comment post pickers (short captions, thumbnails only from Meta's CDN or none). */
export async function igMediaForPicker(ch: ChannelLike) {
  return (await igListRecentMedia(ch, 24)).map((m) => ({
    id: m.id,
    caption: m.caption.slice(0, 120),
    type: m.mediaType,
    thumb: m.thumbUrl,
    permalink: m.permalink,
    timestamp: m.timestamp,
  }));
}
export const igMediaCaption = (ch: ChannelLike, mediaId: string) => instagramProvider().mediaCaption(acctOf(ch), mediaId);
export const igProfileName = (ch: ChannelLike, igsid: string) => instagramProvider().profileName(acctOf(ch), igsid);
export const igOwnMessages = (ch: ChannelLike) => instagramProvider().ownMessages(acctOf(ch));
export const igUnsubscribe = (ch: ChannelLike) => instagramProvider().unsubscribe(acctOf(ch));
