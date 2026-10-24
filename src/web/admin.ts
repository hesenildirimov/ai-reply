import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { removeChannel } from '../channels/index.js';
import type { ChannelRow } from '../channels/types.js';
import { config } from '../config.js';
import { one, q, tx } from '../db.js';
import { sendMail } from '../mailer.js';
import { requireAdmin } from './auth.js';
import { csrfField, html } from './html.js';
import { emailSchema, MESSAGES, passwordLink, view } from './public.js';

Object.assign(MESSAGES, {
  customer_exists: { type: 'error', text: 'Bu e-poçt ilə istifadəçi artıq var.' },
  customer_deleted: { type: 'ok', text: 'Müştəri və bütün məlumatları silindi.' },
});

const date = z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]);
const plusDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const idParam = (req: FastifyRequest) => z.uuid().safeParse((req.params as any).id).data;

const linkBox = (link: string, email: string) => html`<div class="card"><h2>Şifrə təyin etmə linki</h2>
  <p>Bu linki müştəriyə göndərin (WhatsApp və s.). Link <b>72 saat</b> etibarlıdır və yalnız bir dəfə işləyir. Müştəri şifrəsini təyin edib <b>${email}</b> ilə daxil olacaq.</p>
  <p><input readonly value="${link}" class="copy"></p>
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
      return view(req, reply, 'Admin', html`<section class="card"><h1>Yeni müştəri</h1>
        <form method="post" action="/admin/customers" class="grid">${csrfField(req.csrfToken)}
          <label>Biznesin adı<input name="name" required maxlength="120"></label>
          <label>E-poçt (giriş üçün)<input name="email" type="email" required></label>
          <label>Aylıq AI cavab limiti<input name="limit" type="number" min="0" max="1000000" value="${config.DEFAULT_REPLY_LIMIT}" required></label>
          <label>Ödənilib (bu tarixə qədər)<input name="paid_until" type="date" value="${plusDays(30)}"></label>
          <label>Qeyd (yalnız siz görürsünüz)<input name="note" maxlength="500" placeholder="Telefon, ödəniş üsulu..."></label>
          <button>Müştəri yarat</button></form></section>
        <section class="card"><h1>Müştərilər (${rows.length})</h1><table>
          <tr><th>Biznes</th><th>E-poçt</th><th>Ödənilib</th><th>Bu ay AI</th><th>Kanallar</th></tr>
          ${rows.map((w) => html`<tr class="${w.expired ? 'attention' : ''}"><td><a href="/admin/w/${w.id}">${w.name}</a>${w.note ? html`<br><small class="muted">${w.note}</small>` : ''}</td>
            <td>${w.emails}${w.activated ? '' : html` <span class="tag">link gözləyir</span>`}</td>
            <td>${w.paid_until ? day(w.paid_until) : 'limitsiz'}${w.expired ? html` <span class="tag error">bitib</span>` : ''}</td>
            <td>${w.used ?? 0} / ${w.monthly_reply_limit}</td><td>${w.channels ?? '—'}</td></tr>`)}
        </table></section>`);
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
      if (config.mailEnabled) await sendMail(d.email, 'AI Reply hesabınız', `Salam! ${d.name} üçün AI Reply hesabınız yaradıldı.\nŞifrənizi təyin edin (72 saat etibarlıdır):\n${link}`).catch(() => {});
      return view(req, reply, 'Müştəri yaradıldı', html`<p class="flash ok">${d.name} yaradıldı.</p>${linkBox(link, d.email)}<p><a href="/admin">← Admin</a></p>`);
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
      return view(req, reply, w.name, html`<section class="card"><h1>${w.name}</h1>
        <p>İstifadəçi: ${users.map((u) => html`<b>${u.email}</b> ${u.email_verified_at ? '' : html`<span class="tag">link gözləyir</span>`} `)}</p>
        <form method="post" action="/admin/w/${w.id}/update">${csrfField(req.csrfToken)}
          <label>Biznesin adı<input name="name" value="${w.name}" required maxlength="120"></label>
          <label>Aylıq AI cavab limiti<input name="limit" type="number" min="0" max="1000000" value="${w.monthly_reply_limit}" required></label>
          <label>Ödənilib (bu tarixə qədər; boş = limitsiz)<input name="paid_until" type="date" value="${day(w.paid_until)}"></label>
          <label>Qeyd<input name="note" value="${w.note}" maxlength="500"></label>
          <button>Yadda saxla</button></form>
        <div class="actions">${f('extend', '+30 gün ödəniş')}${f('link', 'Yeni şifrə linki')}${f('delete', 'Müştərini sil', 'danger', 'Müştəri, kanalları və bütün söhbətləri həmişəlik silinsin?')}</div>
        <p class="muted">Ödəniş tarixi keçəndə AI avtomatik dayanır, müştəri panelə girə bilir.</p></section><p><a href="/admin">← Admin</a></p>`);
    });

    r.post('/admin/w/:id/update', async (req, reply) => {
      const w = await load(req);
      const p = z.object({ name: z.string().trim().min(1).max(120), limit: z.coerce.number().int().min(0).max(1_000_000), paid_until: date, note: z.string().trim().max(500) }).safeParse(req.body);
      if (!w || !p.success) return reply.redirect('/admin?m=invalid');
      await q('UPDATE workspaces SET name = $2, monthly_reply_limit = $3, paid_until = $4, note = $5 WHERE id = $1', [w.id, p.data.name, p.data.limit, p.data.paid_until || null, p.data.note]);
      return reply.redirect(`/admin/w/${w.id}?m=saved`);
    });

    r.post('/admin/w/:id/extend', async (req, reply) => {
      const w = await load(req);
      if (!w) return reply.code(404).send('Not found');
      // Extend from the later of today and the current paid date.
      await q(`UPDATE workspaces SET paid_until = greatest(coalesce(paid_until, current_date), current_date) + 30 WHERE id = $1`, [w.id]);
      return reply.redirect(`/admin/w/${w.id}?m=saved`);
    });

    r.post('/admin/w/:id/link', async (req, reply) => {
      const w = await load(req);
      const u = w && (await one(`SELECT u.id, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND m.role = 'owner' LIMIT 1`, [w.id]));
      if (!u) return reply.code(404).send('Not found');
      return view(req, reply, 'Şifrə linki', html`${linkBox(await passwordLink(u.id, '72 hours'), u.email)}<p><a href="/admin/w/${w.id}">← ${w.name}</a></p>`);
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
      return reply.redirect('/admin?m=customer_deleted');
    });
  });
}
