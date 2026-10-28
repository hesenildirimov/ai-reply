import { one } from './db.js';
import { audit } from './events.js';
import { redis } from './queue.js';

export const LIMIT_KEYS = [
  'contacts',
  'channels',
  'active_automations',
  'members',
  'bot_messages_month',
  'ai_budget_usd_month',
  'ai_budget_usd_day',
  'history_days',
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export const LIMIT_LABELS: Record<LimitKey, string> = {
  contacts: 'Aktiv kontaktlar (30 gün)',
  channels: 'Bağlı hesablar',
  active_automations: 'Aktiv avtomatlaşdırmalar',
  members: 'Komanda üzvləri',
  bot_messages_month: 'Avtomatik mesajlar (ay)',
  ai_budget_usd_month: 'AI büdcəsi, $ (ay, təxmini)',
  ai_budget_usd_day: 'AI büdcəsi, $ (gün, təxmini)',
  history_days: 'Tarixçə və analitika (gün)',
};

/** Effective limits = plan limits overridden per workspace. null = unlimited. */
export async function limitsOf(workspaceId: string): Promise<Record<LimitKey, number | null>> {
  const row = await one<{ limits: Record<string, number | null> | null; overrides: Record<string, number | null> }>(
    `SELECT p.limits, w.limit_overrides AS overrides FROM workspaces w LEFT JOIN plans p ON p.id = w.plan_id WHERE w.id = $1`,
    [workspaceId],
  );
  const merged = { ...(row?.limits ?? {}), ...(row?.overrides ?? {}) };
  return Object.fromEntries(LIMIT_KEYS.map((k) => [k, typeof merged[k] === 'number' ? merged[k] : null])) as Record<LimitKey, number | null>;
}

const USAGE_SQL: Record<LimitKey, string | null> = {
  contacts: `SELECT count(*)::float AS n FROM contacts WHERE workspace_id = $1 AND merged_into IS NULL AND last_seen_at > now() - interval '30 days'`,
  channels: `SELECT count(*)::float AS n FROM channels WHERE workspace_id = $1`,
  active_automations: `SELECT count(*)::float AS n FROM automations WHERE workspace_id = $1 AND status = 'active'`,
  members: `SELECT count(*)::float AS n FROM memberships WHERE workspace_id = $1`,
  bot_messages_month: `SELECT count(*)::float AS n FROM messages WHERE workspace_id = $1 AND sender IN ('bot', 'ai') AND status = 'sent' AND created_at >= date_trunc('month', now())`,
  ai_budget_usd_month: `SELECT coalesce(sum(est_cost_usd), 0)::float AS n FROM ai_usage WHERE workspace_id = $1 AND created_at >= date_trunc('month', now())`,
  ai_budget_usd_day: `SELECT coalesce(sum(est_cost_usd), 0)::float AS n FROM ai_usage WHERE workspace_id = $1 AND created_at >= date_trunc('day', now())`,
  history_days: null,
};

export async function usageOf(workspaceId: string, key: LimitKey): Promise<number> {
  const sql = USAGE_SQL[key];
  return sql ? Number((await one<{ n: number }>(sql, [workspaceId]))?.n ?? 0) : 0;
}

/** Backend enforcement point. `adding` = how many units the action would add. */
export async function checkLimit(workspaceId: string, key: LimitKey, adding = 1): Promise<{ ok: boolean; used: number; limit: number | null }> {
  const limit = (await limitsOf(workspaceId))[key];
  const used = await usageOf(workspaceId, key);
  return { ok: limit === null || used + adding <= limit, used: Math.round(used * 100) / 100, limit };
}

const botCounter = async (workspaceId: string) => {
  const key = `botmsg:${workspaceId}:${new Date().toISOString().slice(0, 7)}`;
  // Seeded once per month from the database, then kept atomically in Redis.
  if (!(await redis.exists(key))) await redis.set(key, String(await usageOf(workspaceId, 'bot_messages_month')), 'EX', 40 * 86400, 'NX');
  return key;
};

/**
 * Plan limits that stop automated (bot/AI) messages: active contacts over the plan, or the monthly automated-message
 * allowance used up. Incoming messages are always stored and staff can still reply by hand. (Read-only check.)
 */
export async function automationBlocked(workspaceId: string): Promise<LimitKey | null> {
  const limits = await limitsOf(workspaceId);
  if (limits.contacts !== null && (await usageOf(workspaceId, 'contacts')) > limits.contacts) return 'contacts';
  if (limits.bot_messages_month !== null && Number(await redis.get(await botCounter(workspaceId))) >= limits.bot_messages_month) return 'bot_messages_month';
  return null;
}

/**
 * Atomically reserves one automated message right before it is sent (once per idempotency key, so retries of the
 * same message don't count twice). Concurrent sends therefore cannot overshoot the monthly limit.
 */
export async function reserveAutomated(workspaceId: string, key: string): Promise<boolean> {
  const limit = (await limitsOf(workspaceId)).bot_messages_month;
  const counter = await botCounter(workspaceId);
  if ((await redis.set(`botres:${workspaceId}:${key}`, '1', 'EX', 7 * 86400, 'NX')) !== 'OK') return true;
  // Always counted (also without a limit) so the counter stays equal to real usage if a limit is set later.
  if ((await redis.incr(counter)) <= (limit ?? Infinity)) return true;
  await redis.decr(counter);
  await redis.del(`botres:${workspaceId}:${key}`);
  return false;
}

/** One audit entry per workspace, limit and day (shown in the audit log and the admin panel). */
export async function limitAlert(workspaceId: string, key: string, meta: Record<string, unknown> = {}) {
  if ((await redis.set(`limit-alert:${workspaceId}:${key}:${new Date().toISOString().slice(0, 10)}`, '1', 'EX', 86400, 'NX')) === 'OK') {
    await audit(workspaceId, null, 'plan.limit_reached', 'workspace', workspaceId, { limit: key, ...meta });
  }
}

/** AI budget (day or month) spent: no new AI calls. Unlike checkLimit, a budget of 0 means "no AI at all". */
export async function aiBudgetExceeded(workspaceId: string): Promise<{ key: LimitKey; used: number; limit: number } | null> {
  const limits = await limitsOf(workspaceId);
  for (const key of ['ai_budget_usd_day', 'ai_budget_usd_month'] as const) {
    const limit = limits[key];
    if (limit === null) continue;
    const used = await usageOf(workspaceId, key);
    if (used >= limit) return { key, used: Math.round(used * 100) / 100, limit };
  }
  return null;
}
