import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { csvLine } from '../csv.js';
import { one, q } from '../db.js';
import { audit } from '../events.js';
import { addLeadNote, getLead, LEAD_STATUSES, type LeadStatus, leadCounts, leadNotes, listLeads, PLAN_LABELS, STATUS_LABELS, setLeadStatus } from '../leads.js';
import { createCustomer, customerCreated } from './admin.js';
import { requireAdmin } from './auth.js';
import { csrfField, html, pageHead, raw } from './html.js';
import { icon } from './icons.js';
import { MESSAGES, view } from './public.js';
import { TEXT } from './site-i18n.js';
import { type ChipTone, chip, empty, fmt, idParam } from './ui.js';

Object.assign(MESSAGES, {
  lead_saved: { type: 'ok', text: 'Lead yeniləndi.' },
});

const TONE: Record<LeadStatus, ChipTone> = { new: 'info', contacted: 'warn', meeting: 'warn', won: 'ok', lost: 'neutral' };
const statusChip = (s: LeadStatus) => chip(TONE[s], STATUS_LABELS[s]);
const az = TEXT.az.form;
const filterSchema = z.object({ status: z.enum(LEAD_STATUSES).or(z.literal('')).catch(''), q: z.string().trim().max(100).catch('') });
const plusDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

/** Platform admin: website requests (leads) — list, details, status, notes, one-click "create customer". */
export function leadRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', requireAdmin);
    const lead = (req: FastifyRequest) => {
      const id = idParam(req);
      return id ? getLead(id) : Promise.resolve(undefined);
    };

    r.get('/admin/leads', async (req, reply) => {
      const f = filterSchema.parse(req.query ?? {});
      const [rows, counts] = await Promise.all([listLeads(f), leadCounts()]);
      const count = (s: LeadStatus) => counts.find((c) => c.status === s)?.n ?? 0;
      const total = counts.reduce((n, c) => n + c.n, 0);
      const tab = (s: LeadStatus | '', label: string, n: number) =>
        html`<a class="${f.status === s ? 'on' : ''}" href="/admin/leads${s ? `?status=${s}` : ''}">${label} <span class="count">${n}</span></a>`;
      return view(
        req,
        reply,
        'Lead-lər',
        html`<p><a href="/admin" class="more">${icon('back', 'i xs')} Müştərilər</a></p>
        ${pageHead('Lead-lər', 'Saytdan gələn müraciətlər: görüş və zəng istəyənlər.', html`<a class="btn secondary" href="/admin/leads.csv${f.status ? `?status=${f.status}` : ''}">${icon('download')}Excel (CSV)</a>`)}
        <div class="filters"><div class="seg">${tab('', 'Hamısı', total)}${LEAD_STATUSES.map((s) => tab(s, STATUS_LABELS[s], count(s)))}</div>
          <form method="get" action="/admin/leads" class="inline-form">${f.status ? html`<input type="hidden" name="status" value="${f.status}">` : ''}<input name="q" value="${f.q}" placeholder="Ad, biznes, telefon, e-poçt"><button class="btn secondary">Axtar</button></form></div>
        ${
          rows.length
            ? html`<section class="card flush"><div class="table-wrap"><table><thead><tr><th>Tarix</th><th>Biznes</th><th>Paket</th><th>İstək</th><th>Telefon</th><th>Status</th></tr></thead><tbody>
            ${rows.map(
              (l) => html`<tr><td>${fmt(l.created_at)}</td>
                <td><a class="strong" href="/admin/leads/${l.id}">${l.business}</a><small class="muted block">${l.name}${l.notes ? html` · ${l.notes} qeyd` : ''}</small></td>
                <td>${PLAN_LABELS[l.plan]}</td><td>${l.intent === 'demo' ? 'Demo' : 'Zəng'}</td><td>${l.phone}</td><td>${statusChip(l.status)}</td></tr>`,
            )}</tbody></table></div></section>`
            : html`<section class="card">${empty('inbox', f.q || f.status ? 'Bu filtrlə lead yoxdur.' : 'Hələ saytdan müraciət gəlməyib.')}</section>`
        }`,
      );
    });

    r.get('/admin/leads.csv', async (req, reply) => {
      const f = filterSchema.parse(req.query ?? {});
      const rows = await listLeads(f, 10_000);
      const csv = [
        [
          'created_at',
          'status',
          'business',
          'name',
          'phone',
          'email',
          'instagram',
          'industry',
          'monthly_messages',
          'plan',
          'intent',
          'preferred_time',
          'message',
          'lang',
        ],
        ...rows.map((l) => [
          new Date(l.created_at).toISOString(),
          STATUS_LABELS[l.status],
          l.business,
          l.name,
          l.phone,
          l.email,
          l.instagram,
          az.industries[l.industry] ?? l.industry,
          az.volumes[l.monthly_messages] ?? l.monthly_messages,
          PLAN_LABELS[l.plan],
          l.intent,
          l.preferred_time,
          l.message,
          l.lang,
        ]),
      ]
        .map(csvLine)
        .join('');
      await audit(null, req.user!.id, 'admin.leads_export', 'leads', '', { rows: rows.length });
      return reply.header('Content-Disposition', 'attachment; filename="leads.csv"').type('text/csv; charset=utf-8').send(`﻿${csv}`);
    });

    r.get('/admin/leads/:id', async (req, reply) => {
      const l = await lead(req);
      if (!l) return reply.code(404).send('Not found');
      const [notes, plans, ws] = await Promise.all([
        leadNotes(l.id),
        q<{ id: string; name: string; price_note: string }>(`SELECT id, name, price_note FROM plans ORDER BY created_at`),
        l.workspace_id ? one<{ name: string }>(`SELECT name FROM workspaces WHERE id = $1`, [l.workspace_id]) : undefined,
      ]);
      const row = (k: string, v: unknown) => (v ? html`<dt>${k}</dt><dd>${String(v)}</dd>` : '');
      const planName = PLAN_LABELS[l.plan] === 'Bilmir' ? 'Biznes' : PLAN_LABELS[l.plan];
      return view(
        req,
        reply,
        l.business,
        html`<p><a href="/admin/leads" class="more">${icon('back', 'i xs')} Lead-lər</a></p>
        ${pageHead(l.business, html`${statusChip(l.status)} · ${fmt(l.created_at)}`)}
        <div class="cols"><div>
          <section class="card"><dl class="kv">
            ${row('Ad', l.name)}${row('Telefon', l.phone)}${row('E-poçt', l.email)}${row('Instagram', l.instagram)}
            ${row('Sahə', az.industries[l.industry] ?? l.industry)}${row('Mesaj sayı (ay)', az.volumes[l.monthly_messages] ?? l.monthly_messages)}
            ${row('Paket', PLAN_LABELS[l.plan])}${row('İstək', l.intent === 'demo' ? az.intents.demo : az.intents.call)}
            ${row('Uyğun vaxt', l.preferred_time)}${row('Qeyd', l.message)}${row('Dil', l.lang.toUpperCase())}</dl></section>
          <section class="card"><div class="card-head"><h2>${icon('list')}Qeydlər</h2></div>
            ${notes.length ? html`<ul class="list-plain">${notes.map((n) => html`<li><p>${n.body}</p><small class="muted">${n.email ?? '—'} · ${fmt(n.created_at)}</small></li>`)}</ul>` : html`<p class="muted">Hələ qeyd yoxdur.</p>`}
            <form method="post" action="/admin/leads/${l.id}/note">${csrfField(req.csrfToken)}<textarea name="body" rows="2" maxlength="2000" required placeholder="məs. Cümə axşamı 15:00-da görüş"></textarea><button class="btn secondary">Qeyd əlavə et</button></form></section>
        </div><div>
          <section class="card"><div class="card-head"><h2>Status</h2></div>
            <form method="post" action="/admin/leads/${l.id}/status" class="inline-form">${csrfField(req.csrfToken)}
              <select name="status">${LEAD_STATUSES.map((s) => html`<option value="${s}" ${s === l.status ? raw('selected') : ''}>${STATUS_LABELS[s]}</option>`)}</select><button class="btn secondary">Yadda saxla</button></form></section>
          <section class="card"><div class="card-head"><h2>${icon('plus')}Müştəri yarat</h2></div>
            ${
              l.workspace_id
                ? html`<p>Müştəri yaradılıb: <a href="/admin/w/${l.workspace_id}">${ws?.name ?? 'hesab'}</a></p>`
                : html`<p class="muted">Görüşdən sonra razılaşanda: hesab lead-in məlumatları ilə açılır, müştəriyə şifrə linki gedir.</p>
              <form method="post" action="/admin/leads/${l.id}/convert">${csrfField(req.csrfToken)}
                <label>Tarif<select name="plan_id">${plans.map((p) => html`<option value="${p.id}" ${p.name === planName ? raw('selected') : ''}>${p.name} · ${p.price_note}</option>`)}</select></label>
                <label>Ödənilib (bu tarixə qədər)<input name="paid_until" type="date" value="${plusDays(30)}"></label>
                <button class="btn block">${icon('plus')}Müştəri yarat</button></form>`
            }</section>
        </div></div>`,
      );
    });

    r.post('/admin/leads/:id/status', async (req, reply) => {
      const l = await lead(req);
      const s = z.enum(LEAD_STATUSES).safeParse((req.body as Record<string, unknown>)?.status);
      if (!l || !s.success) return reply.code(404).send('Not found');
      await setLeadStatus(l.id, s.data);
      await audit(null, req.user!.id, 'admin.lead_status', 'lead', l.id, { from: l.status, to: s.data });
      return reply.redirect(`/admin/leads/${l.id}?m=lead_saved`);
    });

    r.post('/admin/leads/:id/note', async (req, reply) => {
      const l = await lead(req);
      const body = z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .safeParse((req.body as Record<string, unknown>)?.body);
      if (!l || !body.success) return reply.redirect(`/admin/leads/${l?.id ?? ''}?m=invalid`);
      await addLeadNote(l.id, req.user!.id, body.data);
      return reply.redirect(`/admin/leads/${l.id}?m=lead_saved`);
    });

    r.post('/admin/leads/:id/convert', async (req, reply) => {
      const l = await lead(req);
      if (!l) return reply.code(404).send('Not found');
      if (l.workspace_id) return reply.redirect(`/admin/w/${l.workspace_id}`);
      const p = z.object({ plan_id: z.uuid(), paid_until: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]) }).safeParse(req.body);
      if (!p.success) return reply.redirect(`/admin/leads/${l.id}?m=invalid`);
      if (await one('SELECT 1 FROM users WHERE email = $1', [l.email])) return reply.redirect(`/admin/leads/${l.id}?m=customer_exists`);
      const c = await createCustomer(req, {
        name: l.business,
        email: l.email,
        limit: null,
        paidUntil: p.data.paid_until || null,
        note: `${l.name} · ${l.phone}`,
        planId: p.data.plan_id,
        region: 'az',
      });
      await q(`UPDATE leads SET workspace_id = $2, status = 'won', updated_at = now() WHERE id = $1`, [l.id, c.workspaceId]);
      await audit(c.workspaceId, req.user!.id, 'admin.lead_converted', 'lead', l.id);
      return customerCreated(req, reply, c);
    });
  });
}
