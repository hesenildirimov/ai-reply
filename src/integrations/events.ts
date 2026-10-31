import { config } from '../config.js';
import { one, q } from '../db.js';
import { openText, sealText } from '../messages.js';
import type { EventStatus } from './types.js';

export type EventProvider = 'instagram' | 'telegram';

export interface IntegrationEventInput {
  workspaceId: string | null;
  provider: EventProvider;
  direction: 'in' | 'out';
  kind: string;
  status: EventStatus;
  summary: string;
  payload?: unknown;
  externalId?: string;
  error?: string;
}

export interface IntegrationEvent {
  id: string;
  provider: EventProvider;
  direction: 'in' | 'out';
  kind: string;
  status: EventStatus;
  mode: 'mock' | 'production';
  summary: string;
  payload: unknown;
  externalId: string;
  error: string;
  createdAt: Date;
}

/**
 * Writes one row of the dashboard's event feed. In mock mode a status other than SIMULATED/FAILED is refused here
 * (and by a CHECK constraint): a simulated event must never read as a real delivery. Never throws: monitoring must not
 * break message handling.
 */
export async function recordIntegrationEvent(e: IntegrationEventInput): Promise<void> {
  const status = config.mockMode && e.status !== 'FAILED' ? 'SIMULATED' : e.status;
  try {
    await q(
      `INSERT INTO integration_events (workspace_id, provider, direction, kind, status, mode, summary, payload, external_id, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        e.workspaceId,
        e.provider,
        e.direction,
        e.kind,
        status,
        config.INTEGRATION_MODE,
        sealText(e.summary.slice(0, 500)),
        e.payload === undefined ? '' : sealText(JSON.stringify(e.payload).slice(0, 8000)),
        (e.externalId ?? '').slice(0, 200),
        (e.error ?? '').slice(0, 200),
      ],
    );
  } catch (err) {
    console.error('integration event not recorded:', (err as Error).message);
  }
}

const open = (r: any): IntegrationEvent => ({
  id: String(r.id),
  provider: r.provider,
  direction: r.direction,
  kind: r.kind,
  status: r.status,
  mode: r.mode,
  summary: openText(r.summary),
  payload: r.payload ? JSON.parse(openText(r.payload)) : null,
  externalId: r.external_id,
  error: r.error,
  createdAt: r.created_at,
});

export async function listIntegrationEvents(
  workspaceId: string,
  opts: { limit?: number; kind?: string; provider?: EventProvider } = {},
): Promise<IntegrationEvent[]> {
  const rows = await q(
    `SELECT * FROM integration_events WHERE workspace_id = $1 AND ($2::text IS NULL OR kind = $2) AND ($3::text IS NULL OR provider = $3) ORDER BY id DESC LIMIT $4`,
    [workspaceId, opts.kind ?? null, opts.provider ?? null, Math.min(opts.limit ?? 50, 200)],
  );
  return rows.map(open);
}

export const lastIntegrationEvent = async (workspaceId: string, kind: string) => {
  const r = await one(`SELECT * FROM integration_events WHERE workspace_id = $1 AND kind = $2 ORDER BY id DESC LIMIT 1`, [workspaceId, kind]);
  return r ? open(r) : undefined;
};
