import { config } from '../config.js';
import { fbPath, graph } from './graph.js';
import type { InboundEvent } from './types.js';

export const IG_TEXT_LIMIT = 1000;
// Least privilege: only what auto-replies need.
export const IG_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages'];
const IG = () => config.IG_GRAPH_BASE;

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
  return { token: long.access_token, expiresAt: new Date(Date.now() + long.expires_in * 1000), igId: String(me.user_id), username: me.username, scopes: granted };
}

export async function refreshInstagramToken(token: string) {
  const r = await graph<{ access_token: string; expires_in: number }>(IG(), '/refresh_access_token', {
    query: { grant_type: 'ig_refresh_token', access_token: token },
  });
  return { token: r.access_token, expiresAt: new Date(Date.now() + r.expires_in * 1000) };
}

export const subscribeInstagram = (token: string) =>
  graph(IG(), fbPath('me/subscribed_apps'), { method: 'POST', token, query: { subscribed_fields: 'messages' } });

export const unsubscribeInstagram = (token: string) => graph(IG(), fbPath('me/subscribed_apps'), { method: 'DELETE', token });

export async function sendInstagramText(token: string, igId: string, to: string, text: string, opts: { commentId?: string; quickReplies?: { title: string; payload: string }[] } = {}): Promise<string> {
  const message: Record<string, unknown> = { text: text.slice(0, IG_TEXT_LIMIT) };
  // Quick replies: max 13, title max 20 chars, text only (Meta limits).
  if (opts.quickReplies?.length) message.quick_replies = opts.quickReplies.slice(0, 13).map((q) => ({ content_type: 'text', title: q.title.slice(0, 20), payload: q.payload.slice(0, 1000) }));
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

/** Normalizes an Instagram messaging webhook body. Reactions, reads, deletes are ignored. */
export function parseInstagramWebhook(body: any): InboundEvent[] {
  const out: InboundEvent[] = [];
  if (body?.object !== 'instagram') return out;
  for (const entry of body.entry ?? []) {
    const igId = String(entry?.id ?? '');
    for (const ev of entry?.messaging ?? []) {
      const m = ev?.message;
      const sender = String(ev?.sender?.id ?? '');
      const recipient = String(ev?.recipient?.id ?? '');
      if (!m || typeof m.mid !== 'string' || m.is_deleted || !igId) continue;
      if (m.is_echo) {
        out.push({ type: 'echo', channelType: 'instagram', channelExternalId: igId, userId: recipient, mid: m.mid, text: String(m.text ?? '') });
      } else if (sender && sender !== igId) {
        const text = typeof m.text === 'string' && m.text.trim() && !m.is_unsupported ? m.text : null;
        out.push({ type: 'message', channelType: 'instagram', channelExternalId: igId, userId: sender, userName: '', mid: m.mid, text });
      }
    }
  }
  return out;
}

/** Texts the business itself sent in its most recent DM threads (for style learning). Best effort. */
export async function instagramOwnMessages(token: string, igId: string): Promise<string[]> {
  const r = await graph<{ data?: { messages?: { data?: { message?: string; from?: { id?: string } }[] } }[] }>(IG(), fbPath('me/conversations'), {
    token,
    query: { platform: 'instagram', limit: '25', fields: 'messages.limit(20){message,from}' },
  });
  return (r.data ?? []).flatMap((c) => (c.messages?.data ?? []).filter((m) => m.from?.id === igId && typeof m.message === 'string').map((m) => m.message!));
}
