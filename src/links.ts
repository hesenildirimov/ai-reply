import { config } from './config.js';
import { randomToken } from './crypto.js';
import { one, q } from './db.js';

const URL_RE = /\bhttps?:\/\/[^\s<>"]{3,500}/g;

/** Replaces links in an automation message with /r/<code> redirects so clicks can be counted (opt-in per step). */
export async function trackLinks(text: string, workspaceId: string, automationId: string, runId: string): Promise<string> {
  let out = text;
  for (const url of new Set(text.match(URL_RE) ?? [])) {
    const code = randomToken(6);
    await q(`INSERT INTO links (code, workspace_id, automation_id, run_id, url) VALUES ($1, $2, $3, $4, $5)`, [code, workspaceId, automationId, runId, url]);
    out = out.split(url).join(`${config.APP_URL}/r/${code}`);
  }
  return out;
}

export async function resolveClick(code: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{6,16}$/.test(code)) return null;
  const row = await one<{ url: string }>(`UPDATE links SET clicks = clicks + 1, first_click_at = coalesce(first_click_at, now()) WHERE code = $1 RETURNING url`, [code]);
  return row?.url ?? null;
}
