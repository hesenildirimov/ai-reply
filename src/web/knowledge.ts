import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, q, tx } from '../db.js';
import { audit } from '../events.js';
import { can, requirePerm, requireUser } from './auth.js';
import { csrfField, html, pageHead, raw } from './html.js';
import { icon } from './icons.js';
import { view } from './public.js';
import { chip, empty, fmt, idParam, postForm } from './ui.js';

export const KINDS = {
  product: 'Məhsul / xidmət',
  price: 'Qiymət',
  delivery: 'Çatdırılma',
  faq: 'Tez-tez verilən sual',
  policy: 'Qayda (qaytarma, ödəniş…)',
  forbidden: 'AI-nin cavab verməyəcəyi mövzu',
  handoff: 'Operatora ötürmə qaydası',
  info: 'Digər məlumat',
} as const;
type Kind = keyof typeof KINDS;

const itemSchema = z.object({
  kind: z.enum(Object.keys(KINDS) as [Kind, ...Kind[]]),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(4000),
  keywords: z.string().max(500).default(''),
});
const kw = (s: string) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))].slice(0, 20);

const form = (req: FastifyRequest, action: string, it?: any) => html`<form method="post" action="${action}" class="kb-form">${csrfField(req.csrfToken)}
  <div class="two"><label>Növ<select name="kind">${Object.entries(KINDS).map(([k, l]) => html`<option value="${k}" ${it?.kind === k ? raw('selected') : ''}>${l}</option>`)}</select></label>
  <label>Başlıq<input name="title" value="${it?.title ?? ''}" maxlength="120" required placeholder="Yay donu"></label></div>
  <label>Mətn<textarea name="body" rows="4" maxlength="4000" required placeholder="Qiymət 45-65 AZN, ölçülər S-XL, rənglər: qırmızı, ağ">${it?.body ?? ''}</textarea></label>
  <label>Açar sözlər (vergüllə)<input name="keywords" value="${(it?.keywords ?? []).join(', ')}" maxlength="500" placeholder="don, yay donu, платье"><small class="help">Müştəri bu sözləri yazanda maddə AI-yə mütləq göndərilir.</small></label>
  <button class="btn">${it ? 'Yadda saxla (yeni versiya)' : html`${icon('plus')}Əlavə et`}</button></form>`;

export function knowledgeRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);
    const write = { preHandler: requirePerm('assistant.write') };

    r.get('/app/knowledge', async (req, reply) => {
      const rows = await q(`SELECT * FROM knowledge_items WHERE workspace_id = $1 ORDER BY kind, title`, [req.user!.workspaceId]);
      const w = can(req.user, 'assistant.write');
      return view(req, reply, 'Bilik bazası', html`${pageHead('Bilik bazası', 'Məhsullar, qiymətlər, qaydalar. AI qiymət və faktları yalnız buradan və "AI köməkçi" səhifəsindən götürür.')}
        <p class="hint">${icon('book', 'i xs')} Baza kiçikdirsə (≈4000 token), bütün maddələr hər mesajla göndərilir və cache-lənir (ən ucuz yol). Böyüdükdə hər mesaja yalnız mövzuya uyğun maddələr seçilir; "Qayda", "AI-nin cavab verməyəcəyi mövzu" və "Operatora ötürmə" maddələri həmişə daxil edilir.</p>
        ${w ? html`<section class="card"><h2>${icon('plus')}Yeni maddə</h2>${form(req, '/app/knowledge')}</section>` : ''}
        <section class="card flush">${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Növ</th><th>Başlıq</th><th>Mətn</th><th>Açar sözlər</th><th>Status</th><th></th></tr></thead><tbody>
          ${rows.map((k) => html`<tr><td>${KINDS[k.kind as Kind]}</td><td><a class="strong" href="/app/knowledge/${k.id}">${k.title}</a><small class="muted block">v${k.version} · ${fmt(k.updated_at)}</small></td>
            <td class="muted">${k.body.slice(0, 120)}</td><td class="muted">${k.keywords.join(', ')}</td><td>${k.active ? chip('ok', 'Aktiv') : chip('neutral', 'Söndürülüb')}</td>
            <td>${w ? postForm(`/app/knowledge/${k.id}/toggle`, req.csrfToken, k.active ? 'Söndür' : 'Aktiv et', 'btn sm secondary') : ''}</td></tr>`)}</tbody></table></div>`
          : empty('book', 'Hələ maddə yoxdur. Qiymətləri ayrı-ayrı maddələr kimi yazsanız, AI onları daha dəqiq tapar.')}</section>`);
    });

    r.post('/app/knowledge', write, async (req, reply) => {
      const p = itemSchema.safeParse(req.body);
      if (!p.success) return reply.redirect('/app/knowledge?m=invalid');
      const it = await tx(async (c) => {
        const row = (await c.query(`INSERT INTO knowledge_items (workspace_id, kind, title, body, keywords, updated_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [req.user!.workspaceId, p.data.kind, p.data.title, p.data.body, kw(p.data.keywords), req.user!.id])).rows[0];
        await c.query(`INSERT INTO knowledge_history (item_id, version, title, body, keywords, updated_by) VALUES ($1, 1, $2, $3, $4, $5)`, [row.id, row.title, row.body, row.keywords, req.user!.id]);
        return row;
      });
      await audit(req.user!.workspaceId, req.user!.id, 'knowledge.create', 'knowledge', it.id);
      return reply.redirect('/app/knowledge?m=saved');
    });

    r.get('/app/knowledge/:id', async (req, reply) => {
      const id = idParam(req);
      const it = id && (await one(`SELECT * FROM knowledge_items WHERE id = $1 AND workspace_id = $2`, [id, req.user!.workspaceId]));
      if (!it) return reply.code(404).send('Not found');
      const hist = await q(`SELECT h.*, u.email FROM knowledge_history h LEFT JOIN users u ON u.id = h.updated_by WHERE item_id = $1 ORDER BY version DESC LIMIT 20`, [it.id]);
      const w = can(req.user, 'assistant.write');
      return view(req, reply, it.title, html`<p><a href="/app/knowledge" class="more">${icon('back', 'i xs')} Bilik bazası</a></p>${pageHead(it.title, `${KINDS[it.kind as Kind]} · v${it.version}`,
        w ? postForm(`/app/knowledge/${it.id}/delete`, req.csrfToken, icon('trash'), 'btn danger-ghost', { confirm: 'Maddə silinsin?' }) : undefined)}
        ${w ? html`<section class="card">${form(req, `/app/knowledge/${it.id}`, it)}</section>` : html`<section class="card"><p>${it.body}</p></section>`}
        <section class="card flush"><div class="card-head pad"><h2>Versiyalar</h2></div><div class="table-wrap"><table><thead><tr><th>Versiya</th><th>Kim</th><th>Nə vaxt</th><th>Mətn</th></tr></thead><tbody>
          ${hist.map((h) => html`<tr><td>v${h.version}</td><td>${h.email ?? '—'}</td><td>${fmt(h.updated_at)}</td><td class="muted">${h.title}: ${h.body.slice(0, 160)}</td></tr>`)}</tbody></table></div></section>`);
    });

    r.post('/app/knowledge/:id', write, async (req, reply) => {
      const id = idParam(req);
      const p = itemSchema.safeParse(req.body);
      if (!id || !p.success) return reply.redirect(`/app/knowledge?m=invalid`);
      const ok = await tx(async (c) => {
        const row = (await c.query(`UPDATE knowledge_items SET kind = $3, title = $4, body = $5, keywords = $6, version = version + 1, updated_by = $7, updated_at = now() WHERE id = $1 AND workspace_id = $2 RETURNING *`,
          [id, req.user!.workspaceId, p.data.kind, p.data.title, p.data.body, kw(p.data.keywords), req.user!.id])).rows[0];
        if (row) await c.query(`INSERT INTO knowledge_history (item_id, version, title, body, keywords, updated_by) VALUES ($1, $2, $3, $4, $5, $6)`, [row.id, row.version, row.title, row.body, row.keywords, req.user!.id]);
        return !!row;
      });
      if (ok) await audit(req.user!.workspaceId, req.user!.id, 'knowledge.update', 'knowledge', id);
      return reply.redirect(ok ? `/app/knowledge/${id}?m=saved` : '/app/knowledge');
    });

    r.post('/app/knowledge/:id/toggle', write, async (req, reply) => {
      const id = idParam(req);
      if (id) await q(`UPDATE knowledge_items SET active = NOT active WHERE id = $1 AND workspace_id = $2`, [id, req.user!.workspaceId]);
      return reply.redirect('/app/knowledge?m=saved');
    });
    r.post('/app/knowledge/:id/delete', write, async (req, reply) => {
      const id = idParam(req);
      if (id && (await one(`DELETE FROM knowledge_items WHERE id = $1 AND workspace_id = $2 RETURNING id`, [id, req.user!.workspaceId]))) {
        await audit(req.user!.workspaceId, req.user!.id, 'knowledge.delete', 'knowledge', id);
      }
      return reply.redirect('/app/knowledge?m=saved');
    });
  });
}
