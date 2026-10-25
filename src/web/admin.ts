import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { removeChannel } from '../channels/index.js';
import type { ChannelRow } from '../channels/types.js';
import { config } from '../config.js';
import { one, q, tx } from '../db.js';
import { sendMail } from '../mailer.js';
import { requireAdmin } from './auth.js';
import { csrfField, html, pageHead } from './html.js';
import { channelIcon, icon, type IconName } from './icons.js';
import { emailSchema, MESSAGES, passwordLink, view } from './public.js';

Object.assign(MESSAGES, {
  customer_exists: { type: 'error', text: 'Bu e-poçt ilə istifadəçi artıq var.' },
  customer_deleted: { type: 'ok', text: 'Müştəri və bütün məlumatları silindi.' },
});

const date = z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]);
const plusDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const stat = (ic: IconName, label: string, value: number, tone = '') =>
  html`<div class="stat ${tone}"><span class="stat-ic">${icon(ic)}</span><div><p class="stat-label">${label}</p><p class="stat-value">${value}</p></div></div>`;
const daysLeft = (d: Date | null) => (d ? Math.ceil((new Date(day(d)).getTime() - new Date(new Date().toISOString().slice(0, 10)).getTime()) / 86400_000) : null);
const payChip = (d: Date | null) => {
  const n = daysLeft(d);
  if (n === null) return html`<span class="chip neutral">limitsiz</span>`;
  if (n < 0) return html`<span class="chip danger">bitib · ${day(d)}</span>`;
  if (n <= 5) return html`<span class="chip warn">${n} gün qalıb · ${day(d)}</span>`;
  return html`<span class="chip ok">${day(d)}</span>`;
};
const idParam = (req: FastifyRequest) => z.uuid().safeParse((req.params as any).id).data;

const linkBox = (link: string, email: string) => html`<div class="card link-box"><div class="card-head"><h2>${icon('link')}Şifrə təyin etmə linki</h2></div>
  <p>Bu linki müştəriyə göndərin (WhatsApp və s.). Link <b>72 saat</b> etibarlıdır və yalnız bir dəfə işləyir. Müştəri şifrəsini təyin edib <b>${email}</b> ilə daxil olacaq.</p>
  <div class="copy-row"><input readonly value="${link}" class="copy" id="invite-link"><button type="button" class="btn secondary" data-copy="invite-link">${icon('link')}Kopyala</button></div>
  ${config.mailEnabled ? html`<p class="muted">Link e-poçtla da göndərildi.</p>` : ''}</div>`;

export function adminRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', requireAdmin);

    r.get('/admin', async (req, reply) => {
      const rows = await q(
        `SELECT w.id, w.name, w.paid_until, w.monthly_reply_limit, w.note,
           (SELECT string_agg(u.email, ', ') FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = w.id) AS emails,
           (SELECT bool_or(u.email_verified_at IS NOT NULL) FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = w.id) AS activated,
           (SELECT ai_replies FROM usage_counters uc WHERE uc.workspace_id = w.id AND period = to_char(now(), 'YYYY-MM')) AS used,
           (SELECT string_agg(type, ', ') FROM channels c WHERE c.workspace_id = w.id) AS channels,
           w.paid_until IS NOT NULL AND w.paid_until < current_date AS expired
         FROM workspaces w ORDER BY w.paid_until NULLS LAST, w.name`,
      );
      const n = (f: (w: any) => boolean) => rows.filter(f).length;
      return view(req, reply, 'Admin', html`${pageHead('Müştərilər', 'Hesabları yaradın, ödənişləri qeyd edin. Ödəniş tarixi keçəndə AI avtomatik dayanır.')}
        <div class="stats">
          ${stat('users', 'Cəmi müştəri', rows.length)}
          ${stat('check', 'Aktiv', n((w) => !w.expired))}
          ${stat('clock', '5 gün içində bitir', n((w) => { const d = daysLeft(w.paid_until); return d !== null && d >= 0 && d <= 5; }), 'warn')}
          ${stat('alert', 'Ödənişi bitib', n((w) => w.expired), 'danger')}
        </div>
        <section class="card"><div class="card-head"><h2>${icon('plus')}Yeni müştəri</h2></div>
        <form method="post" action="/admin/customers" class="grid">${csrfField(req.csrfToken)}
          <label>Biznesin adı<input name="name" required maxlength="120"></label>
          <label>E-poçt (giriş üçün)<input name="email" type="email" required></label>
          <label>Aylıq AI cavab limiti<input name="limit" type="number" min="0" max="1000000" value="${config.DEFAULT_REPLY_LIMIT}" required></label>
          <label>Ödənilib (bu tarixə qədər)<input name="paid_until" type="date" value="${plusDays(30)}"></label>
          <label>Qeyd (yalnız siz görürsünüz)<input name="note" maxlength="500" placeholder="Telefon, ödəniş üsulu..."></label>
          <button class="btn">${icon('plus')}Müştəri yarat</button></form></section>
        <section class="card flush"><div class="table-wrap"><table>
          <thead><tr><th>Biznes</th><th>Giriş</th><th>Ödənilib</th><th>Bu ay AI</th><th>Kanallar</th></tr></thead><tbody>
          ${rows.map((w) => html`<tr><td><a class="strong" href="/admin/w/${w.id}">${w.name}</a>${w.note ? html`<small class="muted block">${w.note}</small>` : ''}</td>
            <td>${w.emails}${w.activated ? '' : html` <span class="chip neutral">link gözləyir</span>`}</td>
            <td>${payChip(w.paid_until)}</td>
            <td class="num">${w.used ?? 0} / ${w.monthly_reply_limit}</td><td>${w.channels ? String(w.channels).split(', ').map((t) => html`${channelIcon(t)} `) : '—'}</td></tr>`)}
        </tbody></table></div></section>`);
    });

    r.post('/admin/customers', async (req, reply) => {
      const p = z
        .object({ name: z.string().trim().min(1).max(120), email: emailSchema, limit: z.coerce.number().int().min(0).max(1_000_000), paid_until: date, note: z.string().trim().max(500) })
        .safeParse(req.body);
      if (!p.success) return reply.redirect('/admin?m=invalid');
      const d = p.data;
      if (await one('SELECT 1 FROM users WHERE email = $1', [d.email])) return reply.redirect('/admin?m=customer_exists');
      const userId = await tx(async (c) => {
        // Unusable password until the customer sets one from the link.
        const u = (await c.query(`INSERT INTO users (email, password_hash) VALUES ($1, '!') RETURNING id`, [d.email])).rows[0];
        const w = (await c.query('INSERT INTO workspaces (name, monthly_reply_limit, paid_until, note) VALUES ($1, $2, $3, $4) RETURNING id', [d.name, d.limit, d.paid_until || null, d.note])).rows[0];
        await c.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [w.id, u.id]);
        await c.query('INSERT INTO assistants (workspace_id, business_name) VALUES ($1, $2)', [w.id, d.name]);
        return u.id as string;
      });
      const link = await passwordLink(userId, '72 hours');
      req.log.info({ event: 'admin_customer_created', admin: req.user!.id, user: userId }, 'audit');
      if (config.mailEnabled) await sendMail(d.email, 'AI Reply hesabınız', `Salam! ${d.name} üçün AI Reply hesabınız yaradıldı.\nŞifrənizi təyin edin (72 saat etibarlıdır):\n${link}`).catch(() => {});
      return view(req, reply, 'Müştəri yaradıldı', html`${pageHead(`${d.name} yaradıldı`, 'İndi şifrə linkini müştəriyə göndərin.')}${linkBox(link, d.email)}<p><a href="/admin" class="more">${icon('back', 'i xs')} Müştərilər</a></p>`);
    });

    const load = async (req: FastifyRequest) => {
      const id = idParam(req);
      return id ? one('SELECT * FROM workspaces WHERE id = $1', [id]) : undefined;
    };

    r.get('/admin/w/:id', async (req, reply) => {
      const w = await load(req);
      if (!w) return reply.code(404).send('Not found');
      const users = await q(`SELECT u.email, u.email_verified_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1`, [w.id]);
      const f = (action: string, label: string, cls = '', confirm = '') =>
        html`<form method="post" action="/admin/w/${w.id}/${action}" class="inline" ${confirm ? html`data-confirm="${confirm}"` : ''}>${csrfField(req.csrfToken)}<button class="${cls}">${label}</button></form>`;
      return view(req, reply, w.name, html`<p><a href="/admin" class="more">${icon('back', 'i xs')} Müştərilər</a></p>${pageHead(w.name, html`Ödəniş: ${payChip(w.paid_until)}`)}<section class="card">
        <p>İstifadəçi: ${users.map((u) => html`<b>${u.email}</b> ${u.email_verified_at ? '' : html`<span class="tag">link gözləyir</span>`} `)}</p>
        <form method="post" action="/admin/w/${w.id}/update">${csrfField(req.csrfToken)}
          <label>Biznesin adı<input name="name" value="${w.name}" required maxlength="120"></label>
          <label>Aylıq AI cavab limiti<input name="limit" type="number" min="0" max="1000000" value="${w.monthly_reply_limit}" required></label>
          <label>Ödənilib (bu tarixə qədər; boş = limitsiz)<input name="paid_until" type="date" value="${day(w.paid_until)}"></label>
          <label>Qeyd<input name="note" value="${w.note}" maxlength="500"></label>
          <button class="btn">Yadda saxla</button></form></section>
        <section class="card"><div class="actions">${f('extend', '+30 gün ödəniş', 'btn')}${f('link', 'Yeni şifrə linki', 'btn secondary')}${f('delete', 'Müştərini sil', 'btn danger-ghost', 'Müştəri, kanalları və bütün söhbətləri həmişəlik silinsin?')}</div>
        <p class="hint">Ödəniş tarixi keçəndə AI avtomatik dayanır, müştəri panelə girib əl ilə cavab verə bilir.</p></section>`);
    });

    r.post('/admin/w/:id/update', async (req, reply) => {
      const w = await load(req);
      const p = z.object({ name: z.string().trim().min(1).max(120), limit: z.coerce.number().int().min(0).max(1_000_000), paid_until: date, note: z.string().trim().max(500) }).safeParse(req.body);
      if (!w || !p.success) return reply.redirect('/admin?m=invalid');
      await q('UPDATE workspaces SET name = $2, monthly_reply_limit = $3, paid_until = $4, note = $5 WHERE id = $1', [w.id, p.data.name, p.data.limit, p.data.paid_until || null, p.data.note]);
      req.log.info({ event: 'admin_customer_updated', admin: req.user!.id, workspace: w.id, paid_until: p.data.paid_until, limit: p.data.limit }, 'audit');
      return reply.redirect(`/admin/w/${w.id}?m=saved`);
    });

    r.post('/admin/w/:id/extend', async (req, reply) => {
      const w = await load(req);
      if (!w) return reply.code(404).send('Not found');
      // Extend from the later of today and the current paid date.
      req.log.info({ event: 'admin_payment_extended', admin: req.user!.id, workspace: w.id }, 'audit');
      await q(`UPDATE workspaces SET paid_until = greatest(coalesce(paid_until, current_date), current_date) + 30 WHERE id = $1`, [w.id]);
      return reply.redirect(`/admin/w/${w.id}?m=saved`);
    });

    r.post('/admin/w/:id/link', async (req, reply) => {
      const w = await load(req);
      const u = w && (await one(`SELECT u.id, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.role = 'owner' LIMIT 1`, [w.id]));
      if (!u) return reply.code(404).send('Not found');
      req.log.info({ event: 'admin_password_link', admin: req.user!.id, user: u.id }, 'audit');
      return view(req, reply, 'Şifrə linki', html`${pageHead('Yeni şifrə linki', w.name)}${linkBox(await passwordLink(u.id, '72 hours'), u.email)}<p><a href="/admin/w/${w.id}" class="more">${icon('back', 'i xs')} ${w.name}</a></p>`);
    });

    r.post('/admin/w/:id/delete', async (req, reply) => {
      const w = await load(req);
      if (!w || w.id === req.user!.workspaceId) return reply.redirect('/admin?m=invalid');
      for (const ch of await q<ChannelRow>('SELECT * FROM channels WHERE workspace_id = $1', [w.id])) await removeChannel(ch);
      await tx(async (c) => {
        const users = (await c.query('SELECT user_id FROM memberships WHERE workspace_id = $1', [w.id])).rows.map((x) => x.user_id);
        await c.query('DELETE FROM workspaces WHERE id = $1', [w.id]);
        await c.query('DELETE FROM users WHERE id = ANY($1) AND NOT is_admin AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id)', [users]);
      });
      req.log.info({ event: 'admin_customer_deleted', admin: req.user!.id, workspace: w.id }, 'audit');
      return reply.redirect('/admin?m=customer_deleted');
    });
  });
}
