import type pg from 'pg';
import { one, q } from './db.js';

/**
 * Subscriptions: the single place for their rules (screens and the reply pipeline only call these functions).
 * - paid_until: the subscription runs through that day; afterwards AI replies stop (null = no end date);
 * - monthly_reply_limit: AI replies per calendar month, counted in usage_counters (one row per workspace and month);
 * - plan_id + limit_overrides: plan limits, enforced by plans.ts.
 * Whatever the state, incoming messages are stored and staff can answer by hand.
 */

const PERIOD = `to_char(now(), 'YYYY-MM')`;
const EXPIRED = `coalesce(w.paid_until < current_date, false)`;

export interface Subscription {
  name: string;
  paidUntil: Date | null;
  expired: boolean;
  replyLimit: number;
  repliesUsed: number;
  planId: string | null;
  planName: string | null;
  priceNote: string | null;
  note: string;
  createdAt: Date;
}

export async function subscriptionOf(workspaceId: string): Promise<Subscription | undefined> {
  const r = await one(
    `SELECT w.name, w.paid_until, ${EXPIRED} AS expired, w.monthly_reply_limit, w.plan_id, p.name AS plan_name, p.price_note, w.note, w.created_at,
            coalesce((SELECT ai_replies FROM usage_counters uc WHERE uc.workspace_id = w.id AND uc.period = ${PERIOD}), 0) AS used
     FROM workspaces w LEFT JOIN plans p ON p.id = w.plan_id WHERE w.id = $1`,
    [workspaceId],
  );
  return (
    r && {
      name: r.name,
      paidUntil: r.paid_until,
      expired: r.expired,
      replyLimit: r.monthly_reply_limit,
      repliesUsed: r.used,
      planId: r.plan_id,
      planName: r.plan_name,
      priceNote: r.price_note,
      note: r.note,
      createdAt: r.created_at,
    }
  );
}

/** Counts one AI reply against the monthly limit (atomic: concurrent replies can't overshoot). 'expired' = not paid. */
export async function reserveReply(workspaceId: string): Promise<'ok' | 'limit' | 'expired'> {
  const ws = await one<{ monthly_reply_limit: number; expired: boolean }>(
    `SELECT w.monthly_reply_limit, ${EXPIRED} AS expired FROM workspaces w WHERE w.id = $1`,
    [workspaceId],
  );
  if (!ws || ws.expired) return 'expired';
  if (ws.monthly_reply_limit <= 0) return 'limit';
  const row = await one(
    `INSERT INTO usage_counters (workspace_id, period, ai_replies) VALUES ($1, ${PERIOD}, 1)
     ON CONFLICT (workspace_id, period) DO UPDATE SET ai_replies = usage_counters.ai_replies + 1
     WHERE usage_counters.ai_replies < $2 RETURNING ai_replies`,
    [workspaceId, ws.monthly_reply_limit],
  );
  return row ? 'ok' : 'limit';
}

/** Whole days until the paid date (negative = expired), null = no end date. */
export function daysLeft(paidUntil: Date | null): number | null {
  if (!paidUntil) return null;
  const day = (d: Date) => Date.parse(new Date(d).toISOString().slice(0, 10));
  return Math.ceil((day(paidUntil) - day(new Date())) / 86400_000);
}

/** Payment received: extends from the later of today and the current paid date. */
export const extendSubscription = (workspaceId: string, days = 30) =>
  q(`UPDATE workspaces SET paid_until = greatest(coalesce(paid_until, current_date), current_date) + $2::int WHERE id = $1`, [workspaceId, days]);

export interface SubscriptionTerms {
  name: string;
  replyLimit: number;
  /** YYYY-MM-DD, or null for no end date. */
  paidUntil: string | null;
  note: string;
  /** Where the business sells: 'eu' turns AI self-identification on for good (EU AI Act, audit M-4). */
  region?: Region;
}
export const REGIONS = { az: 'Azərbaycan', eu: 'Avropa İttifaqı', other: 'Digər' } as const;
export type Region = keyof typeof REGIONS;

export const updateSubscription = (workspaceId: string, t: SubscriptionTerms) =>
  q('UPDATE workspaces SET name = $2, monthly_reply_limit = $3, paid_until = $4, note = $5, region = coalesce($6, region) WHERE id = $1', [
    workspaceId,
    t.name,
    t.replyLimit,
    t.paidUntil,
    t.note,
    t.region ?? null,
  ]);

/** New customer workspace (inside the caller's transaction). Unknown plan id -> the default "Biznes" plan. */
export async function createSubscription(c: pg.PoolClient, t: SubscriptionTerms & { planId?: string | null }): Promise<string> {
  const r = await c.query(
    `INSERT INTO workspaces (name, monthly_reply_limit, paid_until, note, plan_id, region)
     VALUES ($1, $2, $3, $4, coalesce((SELECT id FROM plans WHERE id = $5), (SELECT id FROM plans WHERE name = 'Biznes')), $6) RETURNING id`,
    [t.name, t.replyLimit, t.paidUntil, t.note, t.planId ?? null, t.region ?? 'az'],
  );
  return r.rows[0].id;
}

/** All customers for the admin list, soonest-expiring first. */
export const listSubscriptions = () =>
  q(
    `SELECT w.id, w.name, w.paid_until, w.monthly_reply_limit, w.note, ${EXPIRED} AS expired,
       (SELECT string_agg(u.email, ', ') FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = w.id) AS emails,
       (SELECT bool_or(u.email_verified_at IS NOT NULL) FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = w.id) AS activated,
       (SELECT ai_replies FROM usage_counters uc WHERE uc.workspace_id = w.id AND uc.period = ${PERIOD}) AS used,
       (SELECT string_agg(type, ', ') FROM channels c WHERE c.workspace_id = w.id) AS channels
     FROM workspaces w ORDER BY w.paid_until NULLS LAST, w.name`,
  );
