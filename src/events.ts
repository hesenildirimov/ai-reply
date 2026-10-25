import { one, q } from './db.js';

export type ChannelEventKind = 'api_error' | 'rate_limit' | 'token_invalid' | 'ai_timeout' | 'ai_error';

/** Monitoring record for provider failures. Never pass message text or tokens here. */
export const recordEvent = (workspaceId: string, channelId: string | null, kind: ChannelEventKind, code = '') =>
  q('INSERT INTO channel_events (workspace_id, channel_id, kind, code) VALUES ($1, $2, $3, $4)', [workspaceId, channelId, kind, code.slice(0, 60)]).catch(() => {});

/** Append-only audit trail of who changed what (assignments, statuses, roles, automations, plans). */
export const audit = (workspaceId: string | null, userId: string | null, action: string, targetType = '', targetId = '', meta: Record<string, unknown> = {}) =>
  q('INSERT INTO audit_log (workspace_id, user_id, action, target_type, target_id, meta) VALUES ($1, $2, $3, $4, $5, $6)', [
    workspaceId,
    userId,
    action,
    targetType,
    targetId,
    JSON.stringify(meta),
  ]);

/** Marks a channel as needing re-authorization (first time only) and returns true if it flipped. */
export async function markReauth(channelId: string, reason: string): Promise<boolean> {
  const row = await one(`UPDATE channels SET status = 'reauth_required', status_reason = $2 WHERE id = $1 AND status = 'active' RETURNING id`, [channelId, reason.slice(0, 200)]);
  return !!row;
}
