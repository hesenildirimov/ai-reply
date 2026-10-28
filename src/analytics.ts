import { z } from 'zod';
import { q } from './db.js';
import { limitsOf } from './plans.js';

/** Analytics filters shared by the page, CSV exports and tests. Times are [from, to) in UTC; days are Asia/Baku. */
export const filterSchema = z.object({
  range: z.enum(['today', '7d', '30d', 'custom']).catch('7d').default('7d'),
  from: z
    .string()
    .regex(/^\d{4}-\d\d-\d\d$/)
    .or(z.literal(''))
    .catch('')
    .default(''),
  to: z
    .string()
    .regex(/^\d{4}-\d\d-\d\d$/)
    .or(z.literal(''))
    .catch('')
    .default(''),
  ch: z.enum(['', 'instagram', 'whatsapp']).catch('').default(''),
  automation: z
    .union([z.literal(''), z.uuid()])
    .catch('')
    .default(''),
  tag: z
    .union([z.literal(''), z.uuid()])
    .catch('')
    .default(''),
});
export type AnalyticsFilters = z.infer<typeof filterSchema>;

const BAKU_OFFSET_MS = 4 * 3600_000; // UTC+4, no DST
const bakuDayStart = (d: Date) => new Date(Math.floor((d.getTime() + BAKU_OFFSET_MS) / 86400_000) * 86400_000 - BAKU_OFFSET_MS);

export interface Window {
  from: Date;
  to: Date;
  days: number;
  clamped: boolean;
}

/** Resolves the date window; custom ranges max 366 days; the plan's history_days limit clamps the start. */
export async function windowFor(workspaceId: string, f: AnalyticsFilters, now = new Date()): Promise<Window> {
  let to = new Date(bakuDayStart(now).getTime() + 86400_000);
  let from = new Date(to.getTime() - (f.range === 'today' ? 1 : f.range === '30d' ? 30 : 7) * 86400_000);
  if (f.from && f.to) {
    from = new Date(Date.parse(`${f.from}T00:00:00+04:00`));
    to = new Date(Date.parse(`${f.to}T00:00:00+04:00`) + 86400_000);
    if (!(to > from)) to = new Date(from.getTime() + 86400_000);
    if (to.getTime() - from.getTime() > 366 * 86400_000) from = new Date(to.getTime() - 366 * 86400_000);
  }
  let clamped = false;
  const hist = (await limitsOf(workspaceId)).history_days;
  if (hist) {
    const min = new Date(bakuDayStart(now).getTime() - (hist - 1) * 86400_000);
    if (from < min) {
      from = min;
      clamped = true;
    }
  }
  return { from, to, days: Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400_000)), clamped };
}

/** Builds the conversation scope (channel / tag / automation filters) as SQL with numbered params. */
function scope(workspaceId: string, f: AnalyticsFilters, w: Window) {
  const params: unknown[] = [workspaceId, w.from, w.to];
  const p = (v: unknown) => `$${params.push(v)}`;
  const where = ['c.workspace_id = $1'];
  if (f.ch) where.push(`ch.type = ${p(f.ch)}`);
  if (f.tag) where.push(`EXISTS (SELECT 1 FROM contact_tags x WHERE x.contact_id = c.contact_id AND x.tag_id = ${p(f.tag)})`);
  if (f.automation) where.push(`EXISTS (SELECT 1 FROM automation_runs r WHERE r.conversation_id = c.id AND r.automation_id = ${p(f.automation)})`);
  return {
    params,
    p,
    cte: `scope AS (SELECT c.id, c.contact_id, c.unread_count, c.channel_id FROM conversations c JOIN channels ch ON ch.id = c.channel_id WHERE ${where.join(' AND ')}),
    m AS (SELECT m.* FROM messages m JOIN scope s ON s.id = m.conversation_id WHERE m.created_at >= $2 AND m.created_at < $3)`,
  };
}

export async function overview(workspaceId: string, f: AnalyticsFilters, w: Window) {
  const s = scope(workspaceId, f, w);
  const [row] = await q(
    `WITH ${s.cte},
     first_msg AS (SELECT conversation_id, min(created_at) AS t FROM messages WHERE conversation_id IN (SELECT id FROM scope) GROUP BY conversation_id),
     ordered AS (SELECT conversation_id, created_at, direction, lag(direction) OVER (PARTITION BY conversation_id ORDER BY created_at) AS prev FROM m),
     turns AS (
       SELECT o.created_at AS asked, r.created_at AS answered, r.sender FROM ordered o
       CROSS JOIN LATERAL (SELECT created_at, sender FROM messages x WHERE x.conversation_id = o.conversation_id AND x.direction = 'out' AND x.status = 'sent' AND x.created_at > o.created_at
                           ORDER BY x.created_at LIMIT 1) r
       WHERE o.direction = 'in' AND (o.prev IS NULL OR o.prev = 'out') AND r.created_at < o.created_at + interval '7 days')
     SELECT
       (SELECT count(DISTINCT conversation_id) FROM m)::int AS conversations,
       (SELECT count(*) FROM first_msg WHERE t >= $2 AND t < $3)::int AS new_conversations,
       (SELECT count(*) FROM m WHERE direction = 'in')::int AS incoming,
       (SELECT count(*) FROM m WHERE direction = 'out' AND status = 'sent')::int AS outgoing,
       (SELECT count(*) FROM m WHERE sender = 'ai' AND status = 'sent')::int AS ai_messages,
       (SELECT count(*) FROM m WHERE sender = 'bot' AND status = 'sent')::int AS bot_messages,
       (SELECT count(*) FROM m WHERE sender = 'human' AND status = 'sent')::int AS human_messages,
       (SELECT count(*) FROM m WHERE direction = 'out' AND status IN ('failed', 'unknown'))::int AS failed_sends,
       (SELECT count(DISTINCT s.contact_id) FROM m JOIN scope s ON s.id = m.conversation_id WHERE m.direction = 'in')::int AS unique_contacts,
       (SELECT count(*) FROM scope WHERE unread_count > 0)::int AS unread_now,
       (SELECT count(*) FROM audit_log a JOIN scope s ON s.id::text = a.target_id WHERE a.action = 'conversation.handoff' AND a.created_at >= $2 AND a.created_at < $3)::int AS handoffs,
       (SELECT count(*) FROM turns)::int AS answered_turns,
       (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM answered - asked)) FROM turns) AS median_response_s,
       (SELECT avg(extract(epoch FROM answered - asked)) FROM turns) AS avg_response_s,
       (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM answered - asked)) FROM turns WHERE sender = 'human') AS median_human_response_s`,
    s.params,
  );
  const runs = await q(
    `SELECT count(*)::int AS runs, count(*) FILTER (WHERE r.status = 'sent')::int AS sent, count(*) FILTER (WHERE r.status = 'failed')::int AS failed,
            count(*) FILTER (WHERE r.status = 'skipped')::int AS skipped
     FROM automation_runs r JOIN automations a ON a.id = r.automation_id LEFT JOIN channels ch ON ch.id = a.channel_id
     WHERE r.workspace_id = $1 AND r.matched_at >= $2 AND r.matched_at < $3 AND ($4::text = '' OR r.automation_id::text = $4) AND ($5::text = '' OR ch.type = $5)`,
    [workspaceId, w.from, w.to, f.automation, f.ch],
  );
  const events = await q(
    `SELECT kind, count(*)::int AS n FROM channel_events e LEFT JOIN channels ch ON ch.id = e.channel_id
     WHERE e.workspace_id = $1 AND e.created_at >= $2 AND e.created_at < $3 AND ($4::text = '' OR ch.type = $4) GROUP BY kind`,
    [workspaceId, w.from, w.to, f.ch],
  );
  const ev = Object.fromEntries(events.map((e) => [e.kind, e.n]));
  return {
    ...row,
    median_response_s: row.median_response_s === null ? null : Number(row.median_response_s),
    avg_response_s: row.avg_response_s === null ? null : Number(row.avg_response_s),
    median_human_response_s: row.median_human_response_s === null ? null : Number(row.median_human_response_s),
    automation: runs[0],
    api_errors: ev.api_error ?? 0,
    rate_limits: ev.rate_limit ?? 0,
    token_invalid: ev.token_invalid ?? 0,
    ai_timeouts: (ev.ai_timeout ?? 0) + (ev.ai_error ?? 0),
  };
}

/** Incoming / outgoing per Baku day across the window (zero-filled). */
export async function daily(workspaceId: string, f: AnalyticsFilters, w: Window) {
  const s = scope(workspaceId, f, w);
  return q<{ day: string; incoming: number; outgoing: number }>(
    `WITH ${s.cte}
     SELECT to_char(d, 'YYYY-MM-DD') AS day,
            count(m.id) FILTER (WHERE m.direction = 'in')::int AS incoming,
            count(m.id) FILTER (WHERE m.direction = 'out' AND m.status = 'sent')::int AS outgoing
     FROM generate_series(($2::timestamptz AT TIME ZONE 'Asia/Baku')::date, (($3::timestamptz - interval '1 second') AT TIME ZONE 'Asia/Baku')::date, interval '1 day') d
     LEFT JOIN m ON (m.created_at AT TIME ZONE 'Asia/Baku')::date = d::date
     GROUP BY d ORDER BY d`,
    s.params,
  );
}

/** Per-automation performance. Trigger events are only measurable for comment automations (comments received in scope). */
export async function automationStats(workspaceId: string, f: AnalyticsFilters, w: Window) {
  return q(
    `SELECT a.id, a.name, a.trigger, a.status,
       count(r.id)::int AS matched,
       count(r.id) FILTER (WHERE r.attempted_at IS NOT NULL AND r.status <> 'skipped')::int AS attempted,
       count(r.sent_at)::int AS sent,
       count(r.id) FILTER (WHERE r.status = 'failed')::int AS failed,
       count(DISTINCT r.contact_id)::int AS contacts,
       count(r.replied_at)::int AS replied,
       (SELECT coalesce(sum(l.clicks), 0)::int FROM links l WHERE l.automation_id = a.id AND l.created_at >= $2 AND l.created_at < $3) AS clicks,
       (SELECT count(DISTINCT l.run_id)::int FROM links l WHERE l.automation_id = a.id AND l.clicks > 0 AND l.created_at >= $2 AND l.created_at < $3) AS clicked_runs,
       CASE WHEN a.trigger = 'comment' THEN (
         SELECT count(*)::int FROM ig_comments ic WHERE ic.workspace_id = a.workspace_id AND ic.received_at >= $2 AND ic.received_at < $3
           AND (a.channel_id IS NULL OR ic.channel_id = a.channel_id)
           AND (a.config->'media'->>'scope' <> 'selected' OR ic.media_id IN (SELECT jsonb_array_elements_text(a.config->'media'->'ids'))))
       END AS trigger_events,
       (SELECT coalesce(jsonb_object_agg(reason, n), '{}') FROM (SELECT reason, count(*)::int AS n FROM automation_runs x WHERE x.automation_id = a.id AND x.status = 'failed'
          AND x.matched_at >= $2 AND x.matched_at < $3 GROUP BY reason ORDER BY n DESC LIMIT 3) t) AS failure_reasons
     FROM automations a LEFT JOIN channels ch ON ch.id = a.channel_id
     LEFT JOIN automation_runs r ON r.automation_id = a.id AND r.matched_at >= $2 AND r.matched_at < $3
     WHERE a.workspace_id = $1 AND ($4 = '' OR a.id::text = $4) AND ($5 = '' OR ch.type = $5 OR a.channel_id IS NULL)
     GROUP BY a.id ORDER BY count(r.id) DESC, a.name`,
    [workspaceId, w.from, w.to, f.automation, f.ch],
  );
}

export type FunnelStep = { key: string; label: string; value: number | null; note: string };

/** Comment-to-DM funnel. Steps Meta does not report are returned with value null and an explanation. */
export async function commentFunnel(workspaceId: string, f: AnalyticsFilters, w: Window): Promise<FunnelStep[]> {
  const [c] = await q(
    `SELECT
       (SELECT count(*)::int FROM ig_comments ic LEFT JOIN channels ch ON ch.id = ic.channel_id WHERE ic.workspace_id = $1 AND ic.received_at >= $2 AND ic.received_at < $3 AND ($4 = '' OR ch.type = $4)) AS received,
       (SELECT count(*)::int FROM ig_comments ic WHERE ic.workspace_id = $1 AND ic.received_at >= $2 AND ic.received_at < $3 AND ic.matched) AS matched_any`,
    [workspaceId, w.from, w.to, f.ch],
  );
  const [r] = await q(
    `SELECT count(*)::int AS triggered,
            count(*) FILTER (WHERE r.attempted_at IS NOT NULL AND r.status <> 'skipped')::int AS attempted,
            count(r.sent_at)::int AS accepted, count(r.replied_at)::int AS replied,
            (SELECT count(DISTINCT l.run_id)::int FROM links l JOIN automation_runs x ON x.id = l.run_id JOIN automations y ON y.id = x.automation_id
              WHERE x.workspace_id = $1 AND y.trigger = 'comment' AND l.clicks > 0 AND x.matched_at >= $2 AND x.matched_at < $3 AND ($4 = '' OR y.id::text = $4)) AS clicked
     FROM automation_runs r JOIN automations a ON a.id = r.automation_id
     WHERE r.workspace_id = $1 AND a.trigger = 'comment' AND r.matched_at >= $2 AND r.matched_at < $3 AND ($4 = '' OR a.id::text = $4)`,
    [workspaceId, w.from, w.to, f.automation],
  );
  return [
    { key: 'received', label: 'Gələn şərhlər', value: c.received, note: 'Webhook ilə alınan bütün şərhlər (öz şərhləriniz xaric).' },
    { key: 'matched', label: 'Uyğun şərhlər', value: f.automation ? r.triggered : c.matched_any, note: 'Açar söz və post şərtinə uyğun gələnlər.' },
    { key: 'triggered', label: 'İşə düşən avtomatlaşdırmalar', value: r.triggered, note: 'Hər şərh üçün bir icra (təkrar webhook sayılmır).' },
    { key: 'attempted', label: 'Göndərilməsinə cəhd edilən DM-lər', value: r.attempted, note: 'Şərt/7 gün limiti səbəbindən keçilənlər xaric.' },
    { key: 'accepted', label: 'Meta tərəfindən qəbul edilən', value: r.accepted, note: 'Meta API uğurlu cavab qaytarıb (message_id).' },
    { key: 'delivered', label: 'Çatdırılma', value: null, note: 'Ölçülmür: Meta private reply üçün çatdırılma statusu göndərmir.' },
    { key: 'replied', label: 'İstifadəçi cavab yazdı', value: r.replied, note: 'Mesajdan sonra 24 saat ərzində həmin şəxsdən gələn DM.' },
    { key: 'clicked', label: 'Link klikləri', value: r.clicked, note: 'Yalnız "linkləri izlə" aktiv olan mesajlarda; ən azı 1 klik olan icralar.' },
    { key: 'converted', label: 'Konversiya', value: null, note: 'Təyin edilməyib: konversiya hadisəsi (satış/sifariş) hələ qeyd olunmur.' },
  ];
}

/** AI cost/usage. Cost is an estimate from config/ai-models.json list prices, not the provider invoice. */
export async function aiStats(workspaceId: string, w: Window) {
  const [t] = await q(
    `SELECT count(*)::int AS calls, coalesce(sum(input_tokens), 0)::bigint AS input, coalesce(sum(output_tokens), 0)::bigint AS output,
            coalesce(sum(cache_read_tokens), 0)::bigint AS cache_read, coalesce(sum(cache_write_tokens), 0)::bigint AS cache_write,
            coalesce(sum(est_cost_usd), 0)::float AS cost,
            count(*) FILTER (WHERE purpose = 'reply')::int AS reply_calls,
            coalesce(avg(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) FILTER (WHERE purpose = 'reply'), 0)::float AS avg_tokens_reply,
            coalesce(avg(est_cost_usd) FILTER (WHERE purpose = 'reply'), 0)::float AS avg_cost_reply,
            count(*) FILTER (WHERE outcome = 'timeout')::int AS timeouts, count(*) FILTER (WHERE outcome = 'error')::int AS errors,
            count(*) FILTER (WHERE outcome = 'refusal')::int AS refusals, count(*) FILTER (WHERE outcome = 'handoff')::int AS handoffs,
            count(*) FILTER (WHERE route = 'fast')::int AS fast, count(*) FILTER (WHERE purpose = 'summary')::int AS summaries,
            coalesce(avg(latency_ms), 0)::int AS avg_latency_ms
     FROM ai_usage WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3`,
    [workspaceId, w.from, w.to],
  );
  const models = await q(
    `SELECT model, count(*)::int AS calls, sum(input_tokens)::bigint AS input, sum(output_tokens)::bigint AS output, sum(cache_read_tokens)::bigint AS cache_read,
            sum(cache_write_tokens)::bigint AS cache_write, sum(est_cost_usd)::float AS cost
     FROM ai_usage WHERE workspace_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY model ORDER BY cost DESC`,
    [workspaceId, w.from, w.to],
  );
  return { ...t, input: Number(t.input), output: Number(t.output), cache_read: Number(t.cache_read), cache_write: Number(t.cache_write), models };
}
