import { config } from '../config.js';
import { fbPath, graph } from './graph.js';
import type { InboundEvent } from './types.js';

export const IG_TEXT_LIMIT = 1000;
// Least privilege: only what auto-replies need.
export const IG_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments'];
const IG = () => config.IG_GRAPH_BASE;

/** Only https URLs from the webhook are kept: they are rendered later in the operator's browser. */
const httpsUrl = (v: unknown) => (typeof v === 'string' && URL.parse(v)?.protocol === 'https:' ? v : undefined);

// Meta's media CDNs. Images/videos from anywhere else are shown as plain links: an <img> from a customer-chosen
// host would hand the operator's IP and timing to a third party.
const META_CDN = /(^|\.)(cdninstagram\.com|fbcdn\.net|fbsbx\.com)$/i;
export const onMetaCdn = (u: string) => {
  const x = URL.parse(u);
  return !!x && x.protocol === 'https:' && META_CDN.test(x.hostname);
};

export const igRedirectUri = () => `${config.APP_URL}/oauth/instagram/callback`;

export function instagramAuthorizeUrl(state: string): string {
  const u = new URL('https://www.instagram.com/oauth/authorize');
  u.search = new URLSearchParams({
    enable_fb_login: '0',
    force_reauth: 'true',
    client_id: config.IG_APP_ID!,
    redirect_uri: igRedirectUri(),
    response_type: 'code',
    scope: IG_SCOPES.join(','),
    state,
  }).toString();
  return u.toString();
}

/** code -> short-lived token -> long-lived (60 day) token + professional account id. */
export async function exchangeInstagramCode(code: string) {
  const short: any = await graph(config.IG_API_BASE, '/oauth/access_token', {
    form: { client_id: config.IG_APP_ID!, client_secret: config.IG_APP_SECRET!, grant_type: 'authorization_code', redirect_uri: igRedirectUri(), code },
  });
  const s = Array.isArray(short?.data) ? short.data[0] : short;
  const granted: string[] = typeof s?.permissions === 'string' ? s.permissions.split(',') : (s?.permissions ?? IG_SCOPES);
  if (!IG_SCOPES.every((p) => granted.includes(p))) throw new Error('Required Instagram permissions were not granted');

  const long = await graph<{ access_token: string; expires_in: number }>(IG(), '/access_token', {
    query: { grant_type: 'ig_exchange_token', client_secret: config.IG_APP_SECRET!, access_token: s.access_token },
  });
  // `user_id` is the professional account id used in webhooks (`id` is app-scoped).
  const me = await graph<{ user_id: string; username: string }>(IG(), fbPath('me'), { token: long.access_token, query: { fields: 'user_id,username' } });
  return {
    token: long.access_token,
    expiresAt: new Date(Date.now() + long.expires_in * 1000),
    igId: String(me.user_id),
    username: me.username,
    scopes: granted,
  };
}

export async function refreshInstagramToken(token: string) {
  const r = await graph<{ access_token: string; expires_in: number }>(IG(), '/refresh_access_token', {
    query: { grant_type: 'ig_refresh_token', access_token: token },
  });
  return { token: r.access_token, expiresAt: new Date(Date.now() + r.expires_in * 1000) };
}

export const subscribeInstagram = (token: string) =>
  graph(IG(), fbPath('me/subscribed_apps'), { method: 'POST', token, query: { subscribed_fields: 'messages,messaging_postbacks,comments' } });

export const unsubscribeInstagram = (token: string) => graph(IG(), fbPath('me/subscribed_apps'), { method: 'DELETE', token });

export async function sendInstagramText(
  token: string,
  igId: string,
  to: string,
  text: string,
  opts: { commentId?: string; quickReplies?: { title: string; payload: string }[] } = {},
): Promise<string> {
  const message: Record<string, unknown> = { text: text.slice(0, IG_TEXT_LIMIT) };
  // Quick replies: max 13, title max 20 chars, text only (Meta limits).
  if (opts.quickReplies?.length)
    message.quick_replies = opts.quickReplies
      .slice(0, 13)
      .map((q) => ({ content_type: 'text', title: q.title.slice(0, 20), payload: q.payload.slice(0, 1000) }));
  const r = await graph<{ message_id: string }>(IG(), fbPath(`${igId}/messages`), {
    token,
    json: { recipient: opts.commentId ? { comment_id: opts.commentId } : { id: to }, message },
  });
  return r.message_id;
}

export async function instagramUsername(token: string, igsid: string): Promise<string> {
  const r = await graph<{ username?: string; name?: string }>(IG(), fbPath(igsid), { token, query: { fields: 'username,name' } }).catch(() => null);
  return r?.username ? `@${r.username}` : (r?.name ?? '');
}

/** Normalizes an Instagram webhook body: DMs (text, media, story replies/mentions, quick replies, postbacks), echoes, comments. */
export function parseInstagramWebhook(body: any): InboundEvent[] {
  const out: InboundEvent[] = [];
  if (body?.object !== 'instagram') return out;
  for (const entry of body.entry ?? []) {
    const igId = String(entry?.id ?? '');
    if (!igId) continue;
    for (const ev of entry?.messaging ?? []) {
      const sender = String(ev?.sender?.id ?? '');
      const recipient = String(ev?.recipient?.id ?? '');
      // Buttons / ice breakers arrive as postbacks: treat like a quick reply tap.
      if (ev?.postback && sender && sender !== igId) {
        const pb = ev.postback;
        out.push({
          type: 'message',
          channelType: 'instagram',
          channelExternalId: igId,
          userId: sender,
          userName: '',
          mid: String(pb.mid ?? `pb.${ev.timestamp}.${sender}`),
          text: typeof pb.title === 'string' ? pb.title : null,
          kind: 'quick_reply',
          payload: typeof pb.payload === 'string' ? pb.payload : undefined,
        });
        continue;
      }
      const m = ev?.message;
      if (!m || typeof m.mid !== 'string' || m.is_deleted) continue;
      if (m.is_echo) {
        out.push({ type: 'echo', channelType: 'instagram', channelExternalId: igId, userId: recipient, mid: m.mid, text: String(m.text ?? '') });
        continue;
      }
      if (!sender || sender === igId) continue;
      const attachments: any[] = Array.isArray(m.attachments) ? m.attachments : [];
      const media = attachments.map((a) => ({ type: String(a?.type ?? 'file'), url: httpsUrl(a?.payload?.url) }));
      const text = typeof m.text === 'string' && m.text.trim() && !m.is_unsupported ? m.text : null;
      const kind = m.quick_reply?.payload
        ? 'quick_reply'
        : media.some((x) => x.type === 'story_mention')
          ? 'story_mention'
          : m.reply_to?.story
            ? 'story_reply'
            : !text && media.length
              ? 'media'
              : 'text';
      const storyUrl = httpsUrl(m.reply_to?.story?.url);
      if (storyUrl) media.push({ type: 'story', url: storyUrl });
      out.push({
        type: 'message',
        channelType: 'instagram',
        channelExternalId: igId,
        userId: sender,
        userName: '',
        mid: m.mid,
        text,
        kind,
        media: media.length ? media : undefined,
        payload: m.quick_reply?.payload,
      });
    }
    for (const ch of entry?.changes ?? []) {
      const v = ch?.value;
      if (ch?.field !== 'comments' || typeof v?.id !== 'string' || typeof v?.from?.id !== 'string') continue;
      out.push({
        type: 'comment',
        channelType: 'instagram',
        channelExternalId: igId,
        commentId: v.id,
        parentId: v.parent_id,
        mediaId: String(v.media?.id ?? ''),
        fromId: v.from.id,
        fromUsername: String(v.from.username ?? ''),
        text: String(v.text ?? ''),
        time: Number(entry.time) > 1e12 ? Number(entry.time) : Number(entry.time ?? 0) * 1000 || Date.now(),
      });
    }
  }
  return out;
}

/** Public reply under a comment (shown to everyone). Requires instagram_business_manage_comments. */
export async function replyToComment(token: string, commentId: string, text: string): Promise<string> {
  const r = await graph<{ id: string }>(IG(), fbPath(`${commentId}/replies`), { token, form: { message: text.slice(0, 300) } });
  return r.id;
}

/** Caption of a post/reel (context for answering a comment under it). */
export async function mediaCaption(token: string, mediaId: string): Promise<string> {
  const r = await graph<{ caption?: string }>(IG(), fbPath(mediaId), { token, query: { fields: 'caption' } });
  return (r.caption ?? '').slice(0, 1000);
}

/** Recent posts/reels for the automation post picker. */
export async function recentMedia(token: string) {
  const r = await graph<{
    data?: { id: string; caption?: string; media_type?: string; thumbnail_url?: string; media_url?: string; timestamp?: string; permalink?: string }[];
  }>(IG(), fbPath('me/media'), { token, query: { fields: 'id,caption,media_type,thumbnail_url,media_url,timestamp,permalink', limit: '24' } });
  return (r.data ?? []).map((m) => ({
    id: m.id,
    caption: (m.caption ?? '').slice(0, 120),
    type: m.media_type ?? '',
    thumb: [m.thumbnail_url, m.media_url].find((u) => u && onMetaCdn(u)) ?? '',
    permalink: m.permalink ?? '',
    timestamp: m.timestamp ?? '',
  }));
}

/** Texts the business itself sent in its most recent DM threads (for style learning). Best effort. */
export async function instagramOwnMessages(token: string, igId: string): Promise<string[]> {
  const r = await graph<{ data?: { messages?: { data?: { message?: string; from?: { id?: string } }[] } }[] }>(IG(), fbPath('me/conversations'), {
    token,
    query: { platform: 'instagram', limit: '25', fields: 'messages.limit(20){message,from}' },
  });
  return (r.data ?? []).flatMap((c) => (c.messages?.data ?? []).filter((m) => m.from?.id === igId && typeof m.message === 'string').map((m) => m.message!));
}

/**
 * Generic Template (carousel / "Rich Card") message. Meta limits: 10 cards, title and subtitle 80 chars, 3 buttons per
 * card with titles up to 20 chars. NOT yet verified against the live API (see META_COMMERCE_VERIFIED).
 */
export async function sendInstagramCards(
  token: string,
  igId: string,
  to: string,
  cards: { title: string; subtitle?: string; imageUrl?: string; buttons: { type: 'postback'; title: string; payload: string }[] }[],
  opts: { commentId?: string } = {},
): Promise<string> {
  const elements = cards.slice(0, 10).map((c) => ({
    title: c.title.slice(0, 80),
    ...(c.subtitle ? { subtitle: c.subtitle.slice(0, 80) } : {}),
    ...(c.imageUrl ? { image_url: c.imageUrl } : {}),
    buttons: c.buttons.slice(0, 3).map((b) => ({ type: 'postback', title: b.title.slice(0, 20), payload: b.payload.slice(0, 1000) })),
  }));
  const r = await graph<{ message_id: string }>(IG(), fbPath(`${igId}/messages`), {
    token,
    json: {
      recipient: opts.commentId ? { comment_id: opts.commentId } : { id: to },
      message: { attachment: { type: 'template', payload: { template_type: 'generic', elements } } },
    },
  });
  return r.message_id;
}

/** Newest posts/reels with their full caption (new-post detection). Newest first. */
export async function listInstagramMedia(token: string, limit = 12) {
  const r = await graph<{
    data?: { id: string; caption?: string; media_type?: string; thumbnail_url?: string; media_url?: string; timestamp?: string; permalink?: string }[];
  }>(IG(), fbPath('me/media'), { token, query: { fields: 'id,caption,media_type,thumbnail_url,media_url,timestamp,permalink', limit: String(limit) } });
  return (r.data ?? []).map((m) => ({
    id: m.id,
    caption: (m.caption ?? '').slice(0, 1000),
    mediaType: m.media_type ?? '',
    permalink: m.permalink ?? '',
    thumbUrl: [m.thumbnail_url, m.media_url].find((u) => u && onMetaCdn(u)) ?? '',
    timestamp: m.timestamp ?? '',
  }));
}
