import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { csrfField, html, raw, type Safe } from './html.js';
import { channelIcon, type IconName, icon } from './icons.js';

export const BAKU = { timeZone: 'Asia/Baku' } as const;
export const fmt = (d: Date | string | null) => (d ? new Date(d).toLocaleString('az-AZ', { ...BAKU, dateStyle: 'short', timeStyle: 'short' }) : '—');
/** "14:05" today, otherwise "24.10". */
export const when = (d: Date | string) => {
  const t = new Date(d);
  const sameDay = t.toLocaleDateString('az-AZ', BAKU) === new Date().toLocaleDateString('az-AZ', BAKU);
  return sameDay
    ? t.toLocaleTimeString('az-AZ', { ...BAKU, hour: '2-digit', minute: '2-digit' })
    : t.toLocaleDateString('az-AZ', { ...BAKU, day: '2-digit', month: '2-digit' });
};
/** Calendar date (YYYY-MM-DD) of a date column, '' for null (date inputs, payment dates). */
export const day = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');
export const typeLabel = (t: string) => (t === 'whatsapp' ? 'WhatsApp' : 'Instagram');
export const initials = (name: string) => (name.replace(/^@/, '').trim().slice(0, 1) || '?').toUpperCase();
export const avatar = (name: string, type: string) =>
  html`<span class="avatar ${type === 'whatsapp' ? 'wa' : 'ig'}">${initials(name)}<span class="badge">${channelIcon(type)}</span></span>`;
export type ChipTone = 'ok' | 'warn' | 'danger' | 'neutral' | 'info';
export const chip = (cls: ChipTone, text: string) => html`<span class="chip ${cls}">${text}</span>`;
export const stat = (ic: IconName, label: string, value: unknown, meta: unknown = '', tone = '') =>
  html`<div class="stat ${tone}"><span class="stat-ic">${icon(ic)}</span><div><p class="stat-label">${label}</p><p class="stat-value">${value}</p>${meta ? html`<p class="stat-meta">${meta}</p>` : ''}</div></div>`;
export const postForm = (action: string, csrf: string, label: Safe | string, cls: string, opts: { confirm?: string; extra?: Safe } = {}) =>
  html`<form method="post" action="${action}" class="inline" ${opts.confirm ? html`data-confirm="${opts.confirm}"` : ''}>${csrfField(csrf)}${opts.extra}<button class="${cls}">${label}</button></form>`;
export const idParam = (req: FastifyRequest, key = 'id') => z.uuid().safeParse((req.params as any)[key]).data;
export const empty = (ic: IconName, text: string, action?: Safe) => html`<div class="empty">${icon(ic, 'i lg')}<p>${text}</p>${action ?? ''}</div>`;
/** Embeds JSON for client scripts without allowing it to break out of the <script> element. */
export const jsonData = (id: string, data: unknown) =>
  raw(`<script type="application/json" id="${id}">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`);
export const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '—');
