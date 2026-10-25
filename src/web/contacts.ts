import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { addTags, FIELD_KEY, mergeContacts } from '../contacts.js';
import { csvLine, parseCsv } from '../csv.js';
import { one, q } from '../db.js';
import { audit } from '../events.js';
import { can, requirePerm, requireUser } from './auth.js';
import { csrfField, html, pageHead, raw } from './html.js';
import { icon } from './icons.js';
import { MESSAGES, view } from './public.js';
import { avatar, chip, empty, fmt, idParam, postForm, typeLabel, when } from './ui.js';

Object.assign(MESSAGES, {
  merged: { type: 'ok', text: 'Kontaktlar birləşdirildi.' },
  merge_failed: { type: 'error', text: 'Birləşdirmə mümkün olmadı (artıq birləşdirilib və ya başqa hesaba aiddir).' },
});

const PAGE = 50;
const filterSchema = z.object({
  q: z.string().trim().max(100).catch(''),
  tag: z.uuid().or(z.literal('')).catch(''),
  ch: z.enum(['', 'instagram', 'whatsapp']).catch(''),
  status: z.enum(['', 'opted_out', 'blocked']).catch(''),
  before: z.string().regex(/^\d{13}_[0-9a-f-]{36}$/).or(z.literal('')).catch(''),
});
type Filters = z.infer<typeof filterSchema>;

/** Keyset-paginated, tenant-scoped contact list. Merged aliases are hidden (their data lives on the survivor). */
async function listContacts(workspaceId: string, f: Filters, limit = PAGE) {
  const params: unknown[] = [workspaceId];
  const p = (v: unknown) => `$${params.push(v)}`;
  const where = ['ct.workspace_id = $1', 'ct.merged_into IS NULL'];
  if (f.q) where.push(`(ct.display_name || ' ' || ct.username) ILIKE ${p(`%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`)}`);
  if (f.tag) where.push(`EXISTS (SELECT 1 FROM contact_tags x WHERE x.contact_id = ct.id AND x.tag_id = ${p(f.tag)})`);
  if (f.ch) where.push(`ch.type = ${p(f.ch)}`);
  if (f.status) where.push(`ct.${f.status}`);
  if (f.before) {
    const [ms, id] = f.before.split('_');
    where.push(`(ct.last_seen_at, ct.id) < (${p(new Date(Number(ms)))}, ${p(id)})`);
  }
  return q(
    `SELECT ct.*, ch.type AS channel_type,
       (SELECT coalesce(array_agg(t.name ORDER BY t.name), '{}') FROM contact_tags x JOIN tags t ON t.id = x.tag_id WHERE x.contact_id = ct.id) AS tags
     FROM contacts ct JOIN channels ch ON ch.id = ct.channel_id WHERE ${where.join(' AND ')}
     ORDER BY ct.last_seen_at DESC, ct.id DESC LIMIT ${limit + 1}`,
    params,
  );
}
const cursor = (r: any) => `${new Date(r.last_seen_at).getTime()}_${r.id}`;
const nameOf = (c: any) => (c.username ? `@${c.username}` : c.display_name || c.external_id);
const qs = (f: Filters, over: Partial<Filters> = {}) => `?${new URLSearchParams(Object.entries({ ...f, ...over }).filter(([, v]) => v) as [string, string][])}`;

export function contactRoutes(app: FastifyInstance) {
  // Raw CSV body for the import endpoint only (sent by contacts.js with the CSRF header).
  app.addContentTypeParser('text/csv', { parseAs: 'string', bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.register(async (r) => {
    r.addHook('preHandler', requireUser);
    r.addHook('preHandler', requirePerm('contacts.write'));

    r.get('/app/contacts', async (req, reply) => {
      const w0 = req.user!.workspaceId;
      const f = filterSchema.parse(req.query ?? {});
      const [rows, tags, total] = await Promise.all([
        listContacts(w0, f),
        q(`SELECT id, name FROM tags WHERE workspace_id = $1 ORDER BY name LIMIT 200`, [w0]),
        one<{ n: number }>(`SELECT count(*)::int AS n FROM contacts WHERE workspace_id = $1 AND merged_into IS NULL`, [w0]),
      ]);
      const more = rows.length > PAGE;
      const page = rows.slice(0, PAGE);
      const exp = can(req.user, 'contacts.export');
      return view(req, reply, 'Kontaktlar', html`${pageHead('Kontaktlar', `${total!.n} kontakt. Instagram və WhatsApp-da sizə yazan və ya şərh yazan insanlar.`)}
        <form class="filters" method="get" action="/app/contacts">
          <input type="search" name="q" value="${f.q}" placeholder="Ad və ya istifadəçi adı" aria-label="Axtar">
          <select name="ch" data-autosubmit aria-label="Kanal"><option value="">Bütün kanallar</option>${['instagram', 'whatsapp'].map((c) => html`<option value="${c}" ${f.ch === c ? raw('selected') : ''}>${typeLabel(c)}</option>`)}</select>
          <select name="tag" data-autosubmit aria-label="Tag"><option value="">Bütün tag-lər</option>${tags.map((t) => html`<option value="${t.id}" ${t.id === f.tag ? raw('selected') : ''}>${t.name}</option>`)}</select>
          <select name="status" data-autosubmit aria-label="Status"><option value="">Hamısı</option><option value="opted_out" ${f.status === 'opted_out' ? raw('selected') : ''}>Avtomatik mesajdan imtina edənlər</option><option value="blocked" ${f.status === 'blocked' ? raw('selected') : ''}>Bloklananlar</option></select>
          <button class="btn sm secondary">Axtar</button>
          ${exp ? html`<a class="btn sm secondary" href="/app/contacts/export.csv${qs({ ...f, before: '' })}">${icon('download')}CSV</a>` : ''}
          <button type="button" class="btn sm secondary" data-open="import-box">${icon('upload')}İmport</button>
        </form>
        <section class="card" id="import-box" hidden><h2>${icon('upload')}CSV import (tag və sahələr)</h2>
          <p class="hint">Mövcud kontaktları yeniləyir: <b>id</b> (eksportdan) və ya <b>username</b> sütunu ilə tapılır. <b>tags</b> sütunu (";" ilə ayrılmış) tag əlavə edir,
          <b>opted_out</b> (1/0) imtinanı yazır, digər sütunlar (kiçik hərf, rəqəm, _) sahə kimi yazılır. Yeni kontakt yaradılmır: Instagram və WhatsApp-da insana ilk siz yaza bilməzsiniz. Maks. 5000 sətir, 1 MB.</p>
          <div class="copy-row"><input type="file" accept=".csv,text/csv" id="import-file"><button type="button" class="btn" id="import-go" data-csrf="${req.csrfToken}">İmport et</button></div>
          <p class="muted" id="import-result" role="status"></p></section>
        <section class="card flush">${page.length ? html`<div class="table-wrap"><table class="contacts"><thead><tr><th>Kontakt</th><th>Tag-lər</th><th>Son aktivlik</th><th>Status</th></tr></thead><tbody>
          ${page.map((c) => html`<tr><td><a class="who" href="/app/contacts/${c.id}">${avatar(nameOf(c), c.channel_type)}<span><b>${nameOf(c)}</b><small class="muted block">${c.username && c.display_name ? c.display_name : typeLabel(c.channel_type)}</small></span></a></td>
            <td>${c.tags.length ? c.tags.slice(0, 4).map((t: string) => html`<span class="tag">${t}</span> `) : html`<span class="muted">—</span>`}${c.tags.length > 4 ? html`<span class="muted">+${c.tags.length - 4}</span>` : ''}</td>
            <td class="muted">${when(c.last_seen_at)}</td>
            <td>${c.blocked ? chip('danger', 'Bloklanıb') : c.opted_out ? chip('warn', 'İmtina edib') : chip('ok', 'Aktiv')}</td></tr>`)}
          </tbody></table></div>${more ? html`<div class="pad"><a class="btn sm secondary" href="/app/contacts${qs(f, { before: cursor(page.at(-1)) })}">Daha çox</a></div>` : ''}`
          : empty('contact', f.q || f.tag || f.ch || f.status ? 'Filtrə uyğun kontakt yoxdur.' : 'Hələ kontakt yoxdur. Kanal bağlandıqdan sonra yazan hər kəs burada görünəcək.')}</section>`,
        html`<script src="/public/contacts.js" defer></script>`);
    });

    r.get('/app/contacts/export.csv', { preHandler: requirePerm('contacts.export') }, async (req, reply) => {
      const w0 = req.user!.workspaceId;
      const f = filterSchema.parse({ ...(req.query as object), before: '' });
      await audit(w0, req.user!.id, 'contact.export', 'workspace', w0, { filters: { ...f } });
      const keys = (await q<{ k: string }>(`SELECT DISTINCT jsonb_object_keys(fields) AS k FROM contacts WHERE workspace_id = $1 AND merged_into IS NULL ORDER BY 1 LIMIT 50`, [w0])).map((x) => x.k);
      reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="contacts.csv"');
      const out: string[] = ['﻿' + csvLine(['id', 'channel', 'username', 'display_name', 'tags', 'opted_out', 'blocked', 'first_seen_at', 'last_seen_at', ...keys])];
      // Keyset batches keep memory flat for large lists.
      for (let cur = f, n = 0; n < 200; n++) {
        const rows = await listContacts(w0, cur, 1000);
        const batch = rows.slice(0, 1000);
        for (const c of batch) out.push(csvLine([c.id, c.channel_type, c.username, c.display_name, c.tags.join(';'), c.opted_out ? 1 : 0, c.blocked ? 1 : 0, c.first_seen_at, c.last_seen_at, ...keys.map((k) => c.fields[k] ?? '')]));
        if (rows.length <= 1000) break;
        cur = { ...cur, before: cursor(batch.at(-1)) };
      }
      return reply.send(out.join(''));
    });

    r.post('/app/contacts/import', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
      const w0 = req.user!.workspaceId;
      if (typeof req.body !== 'string') return reply.code(415).send({ ok: false, error: 'CSV faylı göndərin.' });
      let rows: string[][];
      try {
        rows = parseCsv(req.body);
      } catch (e) {
        return reply.code(400).send({ ok: false, error: (e as Error).message });
      }
      const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
      const col = (n: string) => head.indexOf(n);
      if (col('id') < 0 && col('username') < 0) return reply.code(400).send({ ok: false, error: '"id" və ya "username" sütunu lazımdır.' });
      const IGNORED = new Set(['id', 'username', 'channel', 'display_name', 'tags', 'opted_out', 'blocked', 'first_seen_at', 'last_seen_at']);
      const fieldCols = head.map((h, i) => [h, i] as const).filter(([h]) => !IGNORED.has(h) && FIELD_KEY.test(h));
      let updated = 0;
      let notFound = 0;
      for (const row of rows) {
        const id = col('id') >= 0 ? z.uuid().safeParse(row[col('id')]?.trim()).data : undefined;
        const username = col('username') >= 0 ? row[col('username')]?.trim().replace(/^@/, '') : '';
        const ct = id
          ? await one(`SELECT id, workspace_id FROM contacts WHERE id = $1 AND workspace_id = $2 AND merged_into IS NULL`, [id, w0])
          : username
            ? await one(`SELECT id, workspace_id FROM contacts WHERE workspace_id = $1 AND lower(username) = lower($2) AND merged_into IS NULL ORDER BY last_seen_at DESC LIMIT 1`, [w0, username])
            : undefined;
        if (!ct) {
          notFound++;
          continue;
        }
        const tags = col('tags') >= 0 ? (row[col('tags')] ?? '').split(/[;|]/).map((t) => t.trim()).filter((t) => t && t.length <= 40).slice(0, 20) : [];
        if (tags.length) await addTags(ct, tags);
        const fields = Object.fromEntries(fieldCols.map(([k, i]) => [k, (row[i] ?? '').slice(0, 500)]).filter(([, v]) => v !== ''));
        if (Object.keys(fields).length) {
          await q(`UPDATE contacts SET fields = fields || $2::jsonb WHERE id = $1 AND (SELECT count(*) FROM jsonb_object_keys(fields || $2::jsonb)) <= 50`, [ct.id, JSON.stringify(fields)]);
        }
        const opt = col('opted_out') >= 0 ? row[col('opted_out')]?.trim().toLowerCase() : '';
        if (opt && ['1', '0', 'true', 'false', 'yes', 'no'].includes(opt)) await q(`UPDATE contacts SET opted_out = $2 WHERE id = $1`, [ct.id, ['1', 'true', 'yes'].includes(opt)]);
        updated++;
      }
      await audit(w0, req.user!.id, 'contact.import', 'workspace', w0, { rows: rows.length, updated, not_found: notFound });
      return reply.send({ ok: true, rows: rows.length, updated, not_found: notFound });
    });

    r.get('/app/contacts/:id', async (req, reply) => {
      const id = idParam(req);
      const w0 = req.user!.workspaceId;
      const c = id && (await one(`SELECT ct.*, ch.type AS channel_type FROM contacts ct JOIN channels ch ON ch.id = ct.channel_id WHERE ct.id = $1 AND ct.workspace_id = $2`, [id, w0]));
      if (!c) return reply.code(404).send('Not found');
      if (c.merged_into) return reply.redirect(`/app/contacts/${c.merged_into}`);
      const dq = z.string().trim().max(100).catch('').parse((req.query as any)?.dup_q);
      const [tags, allTags, convs, runs, aliases, dups] = await Promise.all([
        q(`SELECT t.name FROM contact_tags x JOIN tags t ON t.id = x.tag_id WHERE x.contact_id = $1 ORDER BY t.name`, [c.id]),
        q(`SELECT name FROM tags WHERE workspace_id = $1 ORDER BY name LIMIT 200`, [w0]),
        q(`SELECT c.id, c.status, c.last_message_at, ch.type FROM conversations c JOIN channels ch ON ch.id = c.channel_id WHERE c.contact_id = $1 ORDER BY c.last_message_at DESC LIMIT 20`, [c.id]),
        q(`SELECT a.name, a.id, r.status, r.matched_at FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE r.contact_id = $1 ORDER BY r.matched_at DESC LIMIT 10`, [c.id]),
        q(`SELECT ct.username, ct.display_name, ct.external_id, ch.type FROM contacts ct JOIN channels ch ON ch.id = ct.channel_id WHERE ct.merged_into = $1`, [c.id]),
        // Merge candidates: same username / name in this workspace, or a manual search.
        q(
          `SELECT ct.id, ct.username, ct.display_name, ct.external_id, ct.last_seen_at, ch.type FROM contacts ct JOIN channels ch ON ch.id = ct.channel_id
           WHERE ct.workspace_id = $1 AND ct.id <> $2 AND ct.merged_into IS NULL
             AND (${dq ? `(ct.display_name || ' ' || ct.username) ILIKE $5` : `(($3 <> '' AND lower(ct.username) = lower($3)) OR ($4 <> '' AND lower(ct.display_name) = lower($4)))`})
           ORDER BY ct.last_seen_at DESC LIMIT 10`,
          dq ? [w0, c.id, c.username, c.display_name, `%${dq.replace(/[\\%_]/g, (m) => `\\${m}`)}%`] : [w0, c.id, c.username, c.display_name],
        ),
      ]);
      const back = html`<input type="hidden" name="back" value="contact">`;
      const f = (action: string, inner: unknown, cls = 'inline') => html`<form method="post" action="/app/contacts/${c.id}/${action}" class="${cls}">${csrfField(req.csrfToken)}${back}${inner}</form>`;
      const fields = Object.entries(c.fields as Record<string, string>);
      return view(req, reply, nameOf(c), html`<p><a href="/app/contacts" class="more">${icon('back', 'i xs')} Kontaktlar</a></p>
        ${pageHead(nameOf(c), html`${typeLabel(c.channel_type)} · ilk: ${fmt(c.first_seen_at)} · son: ${fmt(c.last_seen_at)}`)}
        <div class="cols2">
          <section class="card"><h2>Tag-lər</h2>
            <div class="tag-list">${tags.length ? tags.map((t) => html`<span class="chip-x">${t.name}${f('tags', html`<input type="hidden" name="remove" value="${t.name}"><button aria-label="Sil">×</button>`)}</span>`) : html`<span class="muted">Yoxdur</span>`}</div>
            ${f('tags', html`<input name="add" list="tag-options" maxlength="40" placeholder="Tag əlavə et" required><button class="btn sm secondary">Əlavə</button><datalist id="tag-options">${allTags.map((t) => html`<option value="${t.name}">`)}</datalist>`, 'copy-row')}
            <h2 class="mt">Sahələr</h2>
            ${fields.length ? html`<dl class="kv">${fields.map(([k, v]) => html`<dt>${k}</dt><dd>${v}${f('fields', html`<input type="hidden" name="key" value="${k}"><input type="hidden" name="delete" value="1"><button class="icon-btn" aria-label="Sil">×</button>`)}</dd>`)}</dl>` : html`<p class="muted">Yoxdur</p>`}
            ${f('fields', html`<input name="key" pattern="[a-z][a-z0-9_]*" maxlength="40" placeholder="açar (məs: olcu)" required><input name="value" maxlength="500" placeholder="dəyər" required><button class="btn sm secondary">Yaz</button>`, 'copy-row mt')}
            <h2 class="mt">Status</h2><div class="actions">
              ${f('flags', html`<input type="hidden" name="opted_out" value="${c.opted_out ? '0' : '1'}"><button class="btn sm secondary">${c.opted_out ? 'Avtomatik mesajlara icazə ver' : 'Avtomatik mesajları dayandır'}</button>`)}
              ${f('flags', html`<input type="hidden" name="blocked" value="${c.blocked ? '0' : '1'}"><button class="btn sm ${c.blocked ? 'secondary' : 'danger-ghost'}">${c.blocked ? 'Blokdan çıxar' : 'Blokla'}</button>`)}</div>
            <p class="hint">"STOP" yazan müştəri avtomatik imtina edir, "START" ilə geri qayıdır. Bloklanan kontaktın mesajları qeydə alınmır.</p>
          </section>
          <section class="card"><h2>Söhbətlər</h2>
            ${convs.length ? html`<ul class="list-plain">${convs.map((v) => html`<li><a href="/app/inbox/${v.id}">${typeLabel(v.type)} söhbəti</a> <span class="muted">· ${fmt(v.last_message_at)}</span> ${v.status === 'closed' ? chip('neutral', 'bağlı') : ''}</li>`)}</ul>` : html`<p class="muted">Yoxdur</p>`}
            <h2 class="mt">Avtomatlaşdırmalar</h2>
            ${runs.length ? html`<ul class="list-plain">${runs.map((x) => html`<li><a href="/app/automations/${x.id}">${x.name}</a> <span class="muted">· ${x.status} · ${fmt(x.matched_at)}</span></li>`)}</ul>` : html`<p class="muted">Yoxdur</p>`}
            ${aliases.length ? html`<h2 class="mt">Birləşdirilmiş hesablar</h2><ul class="list-plain">${aliases.map((a) => html`<li>${typeLabel(a.type)}: ${a.username ? `@${a.username}` : a.display_name || a.external_id}</li>`)}</ul>` : ''}
          </section>
        </div>
        <section class="card"><h2>${icon('merge')}Dublikatları birləşdir</h2>
          <p class="hint">Eyni insan həm Instagram, həm WhatsApp-dan yazıbsa, onu bu kontakta birləşdirin: söhbətlər, tag-lər və sahələr buraya keçir (ziddiyyətdə bu kontaktın dəyəri qalır). Geri qaytarılmır.</p>
          <form method="get" action="/app/contacts/${c.id}" class="copy-row mt"><input type="search" name="dup_q" value="${dq}" placeholder="Ad və ya istifadəçi adı ilə axtar"><button class="btn sm secondary">Axtar</button></form>
          ${dups.length ? html`<div class="table-wrap"><table><tbody>${dups.map((d) => html`<tr><td>${avatar(nameOf(d), d.type)} <b>${nameOf(d)}</b> <span class="muted">${typeLabel(d.type)} · ${when(d.last_seen_at)}</span></td>
            <td class="right">${postForm(`/app/contacts/${c.id}/merge`, req.csrfToken, html`${icon('merge')}Buna birləşdir`, 'btn sm secondary', { confirm: `${nameOf(d)} bu kontakta birləşdirilsin? Geri qaytarılmır.`, extra: html`<input type="hidden" name="source" value="${d.id}">` })}</td></tr>`)}</tbody></table></div>`
            : html`<p class="muted">${dq ? 'Uyğun kontakt tapılmadı.' : 'Eyni adlı başqa kontakt yoxdur. Yuxarıdan axtarın.'}</p>`}
        </section>`);
    });

    r.post('/app/contacts/:id/merge', async (req, reply) => {
      const id = idParam(req);
      const source = z.uuid().safeParse((req.body as any)?.source).data;
      const ok = !!id && !!source && (await mergeContacts(req.user!.workspaceId, source, id));
      if (ok) await audit(req.user!.workspaceId, req.user!.id, 'contact.merge', 'contact', id!, { source });
      return reply.redirect(`/app/contacts/${id ?? ''}?m=${ok ? 'merged' : 'merge_failed'}`);
    });
  });
}
