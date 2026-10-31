import type pg from 'pg';
import { alertAdmins } from './alerts.js';
import { config } from './config.js';
import { one, q } from './db.js';
import { tgSend } from './telegram.js';

/** Website requests ("Görüş təyin et" / "Bu paketlə başla"): the platform admin's sales list. */

export const LEAD_STATUSES = ['new', 'contacted', 'meeting', 'won', 'lost'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'Yeni',
  contacted: 'Əlaqə saxlanıldı',
  meeting: 'Görüş',
  won: 'Müştəri oldu',
  lost: 'İmtina',
};
export const LEAD_PLANS = ['start', 'biznes', 'pro', 'unknown'] as const;
export type LeadPlan = (typeof LEAD_PLANS)[number];
export const PLAN_LABELS: Record<LeadPlan, string> = { start: 'Start', biznes: 'Biznes', pro: 'Pro', unknown: 'Bilmir' };

export interface LeadInput {
  name: string;
  business: string;
  phone: string;
  email: string;
  instagram: string;
  industry: string;
  monthly_messages: string;
  plan: LeadPlan;
  intent: 'demo' | 'call';
  preferred_time: string;
  message: string;
  lang: 'az' | 'ru' | 'en';
}

export interface LeadRow extends LeadInput {
  id: string;
  status: LeadStatus;
  workspace_id: string | null;
  consent_at: Date;
  created_at: Date;
  updated_at: Date;
}

export async function createLead(l: LeadInput): Promise<LeadRow> {
  const row = (await one<LeadRow>(
    `INSERT INTO leads (name, business, phone, email, instagram, industry, monthly_messages, plan, intent, preferred_time, message, lang, consent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now()) RETURNING *`,
    [l.name, l.business, l.phone, l.email, l.instagram, l.industry, l.monthly_messages, l.plan, l.intent, l.preferred_time, l.message, l.lang],
  ))!;
  void notifyLead(row);
  return row;
}

/** E-mail to every platform admin and a Telegram message (LEADS_TELEGRAM_CHAT_ID). Never throws. */
async function notifyLead(l: LeadRow): Promise<void> {
  const text = [
    `${l.business} — ${l.name}`,
    `Paket: ${PLAN_LABELS[l.plan]} · ${l.intent === 'demo' ? 'Demo görüşü' : 'Zəng'}`,
    `Telefon: ${l.phone} · ${l.email}`,
    l.instagram ? `Instagram: ${l.instagram}` : '',
    l.preferred_time ? `Uyğun vaxt: ${l.preferred_time}` : '',
    `${config.APP_URL}/admin/leads/${l.id}`,
  ]
    .filter(Boolean)
    .join('\n');
  await alertAdmins(`yeni lead: ${l.business}`, text);
  if (config.TELEGRAM_BOT_TOKEN && config.LEADS_TELEGRAM_CHAT_ID)
    await tgSend(config.LEADS_TELEGRAM_CHAT_ID, `🆕 Yeni lead\n${text}`).catch((e) => console.error('lead telegram failed:', (e as Error).message));
}

export interface LeadFilter {
  status?: LeadStatus | '';
  q?: string;
}

export function listLeads(f: LeadFilter, limit = 200) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.status) {
    params.push(f.status);
    where.push(`l.status = $${params.length}`);
  }
  if (f.q) {
    params.push(`%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where.push(`(l.name || ' ' || l.business || ' ' || l.phone || ' ' || l.email || ' ' || l.instagram) ILIKE $${params.length}`);
  }
  return q<LeadRow & { notes: number }>(
    `SELECT l.*, (SELECT count(*)::int FROM lead_notes n WHERE n.lead_id = l.id) AS notes FROM leads l
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.created_at DESC LIMIT ${limit}`,
    params,
  );
}

export const leadCounts = () => q<{ status: LeadStatus; n: number }>(`SELECT status, count(*)::int AS n FROM leads GROUP BY status`);
export const getLead = (id: string) => one<LeadRow>(`SELECT * FROM leads WHERE id = $1`, [id]);
export const leadNotes = (id: string) =>
  q<{ body: string; created_at: Date; email: string | null }>(
    `SELECT n.body, n.created_at, u.email FROM lead_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.lead_id = $1 ORDER BY n.created_at`,
    [id],
  );
export const setLeadStatus = (id: string, status: LeadStatus, db?: pg.PoolClient) =>
  q(`UPDATE leads SET status = $2, updated_at = now() WHERE id = $1`, [id, status], db);
export const addLeadNote = (id: string, authorId: string, body: string) =>
  q(`INSERT INTO lead_notes (lead_id, author_id, body) VALUES ($1, $2, $3)`, [id, authorId, body]);
