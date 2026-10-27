import type { InboundEvent } from './channels/types.js';
import { sha256 } from './crypto.js';
import { q, tx } from './db.js';
import { inboundQueue, type JobData } from './queue.js';

/**
 * Webhook intake. A Meta webhook only verifies the signature, turns the body into jobs and returns: storing the
 * message, the read receipt and the AI reply all run in the worker. Meta gets its 200 in milliseconds however slow
 * Graph or Claude are.
 *
 * Redis fallback: when the queue can't be reached quickly the jobs go to the Postgres outbox (inbound_outbox) and
 * the worker moves them into the queue once Redis is back. Only if both are down does the webhook fail (Meta retries).
 */

export interface IntakeJob {
  /** Stable per Meta event: duplicate deliveries collapse into one job (and one outbox row). */
  jobId: string;
  data: JobData;
}

const ENQUEUE_TIMEOUT_MS = 1500;
const BREAKER_MS = 10_000;
let redisDownUntil = 0;

const stableId = (prefix: string, key: string) => `${prefix}-${sha256(key).toString('hex').slice(0, 32)}`;

export function eventJob(ev: InboundEvent): IntakeJob {
  const ref = ev.type === 'comment' ? ev.commentId : ev.mid;
  return { jobId: stableId('in', `${ev.type}|${ev.channelType}|${ev.channelExternalId}|${ref}`), data: { kind: 'inbound', event: ev } };
}

export const keyedJob = (key: string, data: JobData): IntakeJob => ({ jobId: stableId('in', key), data });

/** Rejects when `p` takes longer than `ms` (ioredis queues commands while disconnected instead of failing). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), ms)))]).finally(() => clearTimeout(timer));
}

const enqueue = (jobs: IntakeJob[]) => inboundQueue.addBulk(jobs.map((j) => ({ name: j.data.kind, data: j.data, opts: { jobId: j.jobId } })));

/** Accepts webhook jobs: queue first, Postgres outbox when Redis is unavailable. Throws only if neither works. */
export async function accept(jobs: IntakeJob[]): Promise<'queued' | 'outbox' | 'empty'> {
  if (!jobs.length) return 'empty';
  if (Date.now() >= redisDownUntil) {
    try {
      await withTimeout(enqueue(jobs), ENQUEUE_TIMEOUT_MS);
      return 'queued';
    } catch {
      // Skip Redis for a few seconds so every webhook in an outage doesn't wait for the timeout.
      redisDownUntil = Date.now() + BREAKER_MS;
    }
  }
  const values = jobs.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
  await q(
    `INSERT INTO inbound_outbox (job_id, data) VALUES ${values} ON CONFLICT (job_id) DO NOTHING`,
    jobs.flatMap((j) => [j.jobId, JSON.stringify(j.data)]),
  );
  return 'outbox';
}

/** Moves outbox rows into the queue (worker, every few seconds). Safe with several workers (SKIP LOCKED). */
export async function drainOutbox(limit = 500): Promise<number> {
  return tx(async (c) => {
    const rows = (
      await c.query<{ id: string; job_id: string; data: JobData }>(`SELECT id, job_id, data FROM inbound_outbox ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [
        limit,
      ])
    ).rows;
    if (!rows.length) return 0;
    await withTimeout(enqueue(rows.map((r) => ({ jobId: r.job_id, data: r.data }))), 5000);
    await c.query(`DELETE FROM inbound_outbox WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id)]);
    return rows.length;
  });
}

/** Test hook: forget a tripped breaker. */
export function resetIntake() {
  redisDownUntil = 0;
}
