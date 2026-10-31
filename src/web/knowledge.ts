import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, q, tx } from '../db.js';
import { audit } from '../events.js';
import { queue } from '../queue.js';
import { MAX_UPLOAD_BYTES, type SourceRow, sourceUsage } from '../sources.js';
import { can, requirePerm, requireUser } from './auth.js';
import { csrfField, html, pageHead, raw } from './html.js';
import { icon } from './icons.js';
import { MESSAGES, view } from './public.js';
import { type ChipTone, chip, empty, fmt, idParam, postForm } from './ui.js';

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
const kw = (s: string) =>
  [
    ...new Set(
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);

Object.assign(MESSAGES, {
  source_added: { type: 'ok', text: 'Mənbə əlavə edildi. Emal bir neçə dəqiqə çəkə bilər, səhifəni yeniləyin.' },
  source_limit: { type: 'error', text: 'Tarifin bilik bazası limiti dolub. Köhnə mənbəni silin və ya tarifi artırın.' },
  source_bad_url: { type: 'error', text: 'Link düzgün deyil (http:// və ya https:// ilə başlamalıdır).' },
  source_deleted: { type: 'ok', text: 'Mənbə və ondan yaranan məlumatlar silindi.' },
});

const SOURCE_KINDS: Record<SourceRow['kind'], string> = { file: 'Fayl', url: 'Səhifə', site: 'Sayt', table: 'Cədvəl' };
const SOURCE_STATUS: Record<SourceRow['status'], [ChipTone, string]> = {
  queued: ['info', 'Növbədə'],
  processing: ['info', 'İşlənir…'],
  ready: ['ok', 'Hazır'],
  failed: ['danger', 'Alınmadı'],
};
const mb = (bytes: number) => (bytes < 102_400 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

/** Sources: upload a file, add a page or a whole site, a question with its answer; usage against the plan. */
async function sourcesCard(req: FastifyRequest, w: boolean): Promise<ReturnType<typeof html>> {
  const ws = req.user!.workspaceId;
  const [sources, usage] = await Promise.all([
    q<SourceRow>(`SELECT * FROM knowledge_sources WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200`, [ws]),
    sourceUsage(ws),
  ]);
  const pct = usage.limit ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
  return html`<section class="card"><div class="card-head"><h2>${icon('upload')}Mənbələr</h2>
      <span class="muted">${mb(usage.used)} / ${usage.limit === null ? 'limitsiz' : mb(usage.limit)}</span></div>
    ${usage.limit !== null ? html`<span class="bar"><span style="width:${pct}%"></span></span>` : ''}
    <p class="muted">Kataloq, qiymət siyahısı, qaydalar faylı və ya saytınız: AI hər sualda yalnız uyğun hissəni oxuyur.</p>
    ${
      w
        ? html`<div class="source-forms">
      <div class="source-form"><h3>${icon('upload', 'i xs')} Fayl</h3>
        <p class="help">PDF, Word (.docx), TXT, CSV və ya Excel (.xlsx), ən çox ${MAX_UPLOAD_BYTES / 1048576} MB. Cədvəldə hər sətir ayrıca məhsul olur.</p>
        <div class="copy-row"><input type="file" id="source-file" accept=".pdf,.docx,.txt,.md,.csv,.xlsx"><button type="button" class="btn" id="source-upload" data-csrf="${req.csrfToken}">Yüklə</button></div>
        <p class="help" id="source-result" role="status"></p></div>
      <form class="source-form" method="post" action="/app/knowledge/sources/url">${csrfField(req.csrfToken)}<h3>${icon('globe', 'i xs')} Sayt</h3>
        <input name="url" type="url" required placeholder="https://saytiniz.az/katalog" maxlength="500">
        <label class="radio"><input type="radio" name="mode" value="url" checked> Yalnız bu səhifə</label>
        <label class="radio"><input type="radio" name="mode" value="site"> Bütün sayt (sitemap və ya səhifədəki linklər, ən çox 30 səhifə)</label>
        <button class="btn secondary">Əlavə et</button></form>
      <form class="source-form" method="post" action="/app/knowledge/qa">${csrfField(req.csrfToken)}<h3>${icon('chat', 'i xs')} Sual-cavab</h3>
        <input name="question" required maxlength="120" placeholder="Sual: Çatdırılma var?">
        <textarea name="answer" rows="2" required maxlength="4000" placeholder="Cavab: Bakı daxili 1 gün, 5 AZN"></textarea>
        <button class="btn secondary">Əlavə et</button></form></div>`
        : ''
    }
    ${
      sources.length
        ? html`<div class="table-wrap"><table><thead><tr><th>Mənbə</th><th>Növ</th><th>Ölçü</th><th>Vəziyyət</th><th></th></tr></thead><tbody>${sources.map(
            (s) => {
              const [tone, label] = SOURCE_STATUS[s.status];
              return html`<tr><td><b>${s.name}</b>${s.url ? html`<small class="muted block">${s.url}</small>` : ''}<small class="muted block">${fmt(s.created_at)}</small></td>
              <td>${SOURCE_KINDS[s.kind]}</td><td class="num">${s.status === 'ready' ? html`${mb(s.bytes)}<small class="muted block">${s.items} hissə</small>` : '—'}</td>
              <td>${chip(tone, label)}${s.error ? html`<small class="muted block">${s.error}</small>` : ''}</td>
              <td>${w ? postForm(`/app/knowledge/sources/${s.id}/delete`, req.csrfToken, icon('trash'), 'btn sm danger-ghost', { confirm: 'Mənbə və ondan yaranan məlumatlar silinsin?' }) : ''}</td></tr>`;
            },
          )}</tbody></table></div>`
        : ''
    }</section>`;
}

const form = (req: FastifyRequest, action: string, it?: any) => html`<form method="post" action="${action}" class="kb-form">${csrfField(req.csrfToken)}
  <div class="two"><label>Növ<select name="kind">${Object.entries(KINDS).map(([k, l]) => html`<option value="${k}" ${it?.kind === k ? raw('selected') : ''}>${l}</option>`)}</select></label>
  <label>Başlıq<input name="title" value="${it?.title ?? ''}" maxlength="120" required placeholder="Yay donu"></label></div>
  <label>Mətn<textarea name="body" rows="4" maxlength="4000" required placeholder="Qiymət 45-65 AZN, ölçülər S-XL, rənglər: qırmızı, ağ">${it?.body ?? ''}</textarea></label>
  <label>Açar sözlər (vergüllə)<input name="keywords" value="${(it?.keywords ?? []).join(', ')}" maxlength="500" placeholder="don, yay donu, платье"><small class="help">Müştəri bu sözləri yazanda maddə AI-yə mütləq göndərilir.</small></label>
  <button class="btn">${it ? 'Yadda saxla (yeni versiya)' : html`${icon('plus')}Əlavə et`}</button></form>`;

export function knowledgeRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);
    r.addHook('preHandler', requirePerm('knowledge.view'));
    const write = { preHandler: requirePerm('assistant.write') };

    r.get('/app/knowledge', async (req, reply) => {
      const rows = await q(`SELECT * FROM knowledge_items WHERE workspace_id = $1 AND source_id IS NULL ORDER BY kind, title`, [req.user!.workspaceId]);
      const w = can(req.user, 'assistant.write');
      return view(
        req,
        reply,
        'Bilik bazası',
        html`${pageHead('Bilik bazası', 'Məhsullar, qiymətlər, qaydalar. AI qiymət və faktları yalnız buradan və "AI köməkçi" səhifəsindən götürür.')}
        <p class="hint">${icon('book', 'i xs')} Baza kiçikdirsə (≈4000 token), bütün maddələr hər mesajla göndərilir və cache-lənir (ən ucuz yol). Böyüdükdə hər mesaja yalnız mövzuya uyğun maddələr seçilir; "Qayda", "AI-nin cavab verməyəcəyi mövzu" və "Operatora ötürmə" maddələri həmişə daxil edilir.</p>
        ${await sourcesCard(req, w)}
        ${w ? html`<section class="card"><h2>${icon('plus')}Yeni maddə</h2>${form(req, '/app/knowledge')}</section>` : ''}
        <section class="card flush">${
          rows.length
            ? html`<div class="table-wrap"><table><thead><tr><th>Növ</th><th>Başlıq</th><th>Mətn</th><th>Açar sözlər</th><th>Status</th><th></th></tr></thead><tbody>
          ${rows.map(
            (
              k,
            ) => html`<tr><td>${KINDS[k.kind as Kind]}</td><td><a class="strong" href="/app/knowledge/${k.id}">${k.title}</a><small class="muted block">v${k.version} · ${fmt(k.updated_at)}</small></td>
            <td class="muted">${k.body.slice(0, 120)}</td><td class="muted">${k.keywords.join(', ')}</td><td>${k.active ? chip('ok', 'Aktiv') : chip('neutral', 'Söndürülüb')}</td>
            <td>${w ? postForm(`/app/knowledge/${k.id}/toggle`, req.csrfToken, k.active ? 'Söndür' : 'Aktiv et', 'btn sm secondary') : ''}</td></tr>`,
          )}</tbody></table></div>`
            : empty('book', 'Hələ maddə yoxdur. Qiymətləri ayrı-ayrı maddələr kimi yazsanız, AI onları daha dəqiq tapar.')
        }</section>`,
        html`<script src="/public/knowledge.js" defer></script>`,
      );
    });

    // ---------- sources ----------
    // Raw file body for the upload endpoint only (sent by knowledge.js with the CSRF header and the file name).
    r.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));
    const full = async (req: FastifyRequest) => {
      const u = await sourceUsage(req.user!.workspaceId);
      return u.limit !== null && u.used >= u.limit;
    };
    const queueSource = async (req: FastifyRequest, s: { kind: string; name: string; url?: string }) => {
      const row = (await one<{ id: string }>(
        `INSERT INTO knowledge_sources (workspace_id, kind, name, url, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [req.user!.workspaceId, s.kind, s.name.slice(0, 200), s.url ?? '', req.user!.id],
      ))!;
      await audit(req.user!.workspaceId, req.user!.id, 'knowledge.source_add', 'knowledge_source', row.id, { kind: s.kind });
      return row.id;
    };

    r.post('/app/knowledge/sources/file', { ...write, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
      const data = req.body;
      const name = z
        .string()
        .trim()
        .min(1)
        .max(200)
        .catch('fayl')
        .parse((req.query as Record<string, unknown>)?.name);
      if (!Buffer.isBuffer(data) || !data.length) return reply.code(400).send({ ok: false, error: 'Fayl boşdur.' });
      if (await full(req)) return reply.code(400).send({ ok: false, error: MESSAGES.source_limit!.text });
      const kind = /\.(csv|xlsx)$/i.test(name) ? 'table' : 'file';
      const id = await queueSource(req, { kind, name });
      await q(`INSERT INTO knowledge_uploads (source_id, filename, data) VALUES ($1, $2, $3)`, [id, name, data]);
      await queue.add('knowledge_source', { kind: 'knowledge_source', sourceId: id }, { jobId: `source-${id}` });
      return reply.send({ ok: true });
    });

    r.post('/app/knowledge/sources/url', { ...write, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const url = URL.parse(String(b.url ?? '').trim());
      if (!url || !['http:', 'https:'].includes(url.protocol)) return reply.redirect('/app/knowledge?m=source_bad_url');
      if (await full(req)) return reply.redirect('/app/knowledge?m=source_limit');
      const kind = b.mode === 'site' ? 'site' : 'url';
      const id = await queueSource(req, { kind, name: url.hostname + (kind === 'url' ? url.pathname : ''), url: url.toString() });
      await queue.add('knowledge_source', { kind: 'knowledge_source', sourceId: id }, { jobId: `source-${id}` });
      return reply.redirect('/app/knowledge?m=source_added');
    });

    // A question with its answer is a hand-written FAQ item (always available to the AI when the base is small).
    r.post('/app/knowledge/qa', write, async (req, reply) => {
      const p = z.object({ question: z.string().trim().min(1).max(120), answer: z.string().trim().min(1).max(4000) }).safeParse(req.body);
      if (!p.success) return reply.redirect('/app/knowledge?m=invalid');
      const it = await one<{ id: string; title: string; body: string }>(
        `INSERT INTO knowledge_items (workspace_id, kind, title, body, updated_by) VALUES ($1, 'faq', $2, $3, $4) RETURNING id, title, body`,
        [req.user!.workspaceId, p.data.question, p.data.answer, req.user!.id],
      );
      await q(`INSERT INTO knowledge_history (item_id, version, title, body, keywords, updated_by) VALUES ($1, 1, $2, $3, '{}', $4)`, [
        it!.id,
        it!.title,
        it!.body,
        req.user!.id,
      ]);
      await audit(req.user!.workspaceId, req.user!.id, 'knowledge.create', 'knowledge', it!.id);
      return reply.redirect('/app/knowledge?m=saved');
    });

    r.post('/app/knowledge/sources/:id/delete', write, async (req, reply) => {
      const id = idParam(req);
      if (id && (await one(`DELETE FROM knowledge_sources WHERE id = $1 AND workspace_id = $2 RETURNING id`, [id, req.user!.workspaceId])))
        await audit(req.user!.workspaceId, req.user!.id, 'knowledge.source_delete', 'knowledge_source', id);
      return reply.redirect('/app/knowledge?m=source_deleted');
    });

    r.post('/app/knowledge', write, async (req, reply) => {
      const p = itemSchema.safeParse(req.body);
      if (!p.success) return reply.redirect('/app/knowledge?m=invalid');
      const it = await tx(async (c) => {
        const row = (
          await c.query(`INSERT INTO knowledge_items (workspace_id, kind, title, body, keywords, updated_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [
            req.user!.workspaceId,
            p.data.kind,
            p.data.title,
            p.data.body,
            kw(p.data.keywords),
            req.user!.id,
          ])
        ).rows[0];
        await c.query(`INSERT INTO knowledge_history (item_id, version, title, body, keywords, updated_by) VALUES ($1, 1, $2, $3, $4, $5)`, [
          row.id,
          row.title,
          row.body,
          row.keywords,
          req.user!.id,
        ]);
        return row;
      });
      await audit(req.user!.workspaceId, req.user!.id, 'knowledge.create', 'knowledge', it.id);
      return reply.redirect('/app/knowledge?m=saved');
    });

    r.get('/app/knowledge/:id', async (req, reply) => {
      const id = idParam(req);
      const it = id && (await one(`SELECT * FROM knowledge_items WHERE id = $1 AND workspace_id = $2 AND source_id IS NULL`, [id, req.user!.workspaceId]));
      if (!it) return reply.code(404).send('Not found');
      const hist = await q(
        `SELECT h.*, u.email FROM knowledge_history h LEFT JOIN users u ON u.id = h.updated_by WHERE item_id = $1 ORDER BY version DESC LIMIT 20`,
        [it.id],
      );
      const w = can(req.user, 'assistant.write');
      return view(
        req,
        reply,
        it.title,
        html`<p><a href="/app/knowledge" class="more">${icon('back', 'i xs')} Bilik bazası</a></p>${pageHead(
          it.title,
          `${KINDS[it.kind as Kind]} · v${it.version}`,
          w ? postForm(`/app/knowledge/${it.id}/delete`, req.csrfToken, icon('trash'), 'btn danger-ghost', { confirm: 'Maddə silinsin?' }) : undefined,
        )}
        ${w ? html`<section class="card">${form(req, `/app/knowledge/${it.id}`, it)}</section>` : html`<section class="card"><p>${it.body}</p></section>`}
        <section class="card flush"><div class="card-head pad"><h2>Versiyalar</h2></div><div class="table-wrap"><table><thead><tr><th>Versiya</th><th>Kim</th><th>Nə vaxt</th><th>Mətn</th></tr></thead><tbody>
          ${hist.map((h) => html`<tr><td>v${h.version}</td><td>${h.email ?? '—'}</td><td>${fmt(h.updated_at)}</td><td class="muted">${h.title}: ${h.body.slice(0, 160)}</td></tr>`)}</tbody></table></div></section>`,
      );
    });

    r.post('/app/knowledge/:id', write, async (req, reply) => {
      const id = idParam(req);
      const p = itemSchema.safeParse(req.body);
      if (!id || !p.success) return reply.redirect(`/app/knowledge?m=invalid`);
      const ok = await tx(async (c) => {
        const row = (
          await c.query(
            `UPDATE knowledge_items SET kind = $3, title = $4, body = $5, keywords = $6, version = version + 1, updated_by = $7, updated_at = now() WHERE id = $1 AND workspace_id = $2 RETURNING *`,
            [id, req.user!.workspaceId, p.data.kind, p.data.title, p.data.body, kw(p.data.keywords), req.user!.id],
          )
        ).rows[0];
        if (row)
          await c.query(`INSERT INTO knowledge_history (item_id, version, title, body, keywords, updated_by) VALUES ($1, $2, $3, $4, $5, $6)`, [
            row.id,
            row.version,
            row.title,
            row.body,
            row.keywords,
            req.user!.id,
          ]);
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
