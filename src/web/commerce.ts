import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createProduct, listProducts, priceLabel } from '../commerce/catalog.js';
import { seedDemoData } from '../commerce/fixtures.js';
import { detectNewPosts, listPosts, PostProductError, pendingPostCount, setPostProducts, skipPost } from '../commerce/posts.js';
import * as sim from '../commerce/simulator.js';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { audit } from '../events.js';
import { listIntegrationEvents } from '../integrations/events.js';
import { type EventStatus, integrationReadiness } from '../integrations/index.js';
import { requirePerm, requireUser } from './auth.js';
import { csrfField, html, pageHead } from './html.js';
import { icon } from './icons.js';
import { MESSAGES, view } from './public.js';
import { type ChipTone, chip, empty, fmt, idParam, postForm } from './ui.js';

Object.assign(MESSAGES, {
  catalog_saved: { type: 'ok', text: 'Məhsul yadda saxlanıldı.' },
  post_saved: { type: 'ok', text: 'Postun məhsulları yadda saxlanıldı.' },
  post_skipped: { type: 'ok', text: 'Post "məhsulsuz" kimi işarələndi.' },
  post_none: { type: 'error', text: 'Ən azı bir məhsul seçin (məhsul yoxdursa "Məhsul yoxdur" basın).' },
  post_max: { type: 'error', text: 'Bir postda ən çox 10 məhsul ola bilər (Instagram karuseli 10 kartla məhdudlaşır).' },
  detect_done: { type: 'ok', text: 'Postlar yoxlanıldı.' },
  detect_off: { type: 'error', text: 'Post aşkarlama istehsal rejimində yalnız META_COMMERCE_VERIFIED=on olduqda işləyir.' },
  no_instagram: { type: 'error', text: 'Əvvəlcə Instagram hesabı bağlayın (test rejimində "Simulyator" → demo məlumatlar).' },
  sim_queued: { type: 'ok', text: 'Simulyasiya hadisəsi göndərildi. Worker prosesi işləyirsə nəticə bir neçə saniyəyə "Hadisələr"də görünəcək.' },
  sim_done: { type: 'ok', text: 'Simulyasiya edildi.' },
  sim_seeded: { type: 'ok', text: 'Demo məlumatlar yükləndi.' },
});

const STATUS_TONE: Record<EventStatus, ChipTone> = { SIMULATED: 'warn', PENDING: 'info', DELIVERED: 'ok', FAILED: 'danger', RECEIVED: 'neutral' };
const STATUS_HELP: [EventStatus, string][] = [
  ['SIMULATED', 'Test rejimi: heç nə Instagram-a və ya Telegram-a göndərilməyib.'],
  ['PENDING', 'Qəbul edilib, nəticə hələ bilinmir.'],
  ['DELIVERED', 'Yalnız real provayder (Meta / Telegram) təsdiq edəndə.'],
  ['FAILED', 'Göndərmə uğursuz oldu.'],
  ['RECEIVED', 'Real Instagram / Telegram-dan gələn hadisə.'],
];

const eventStatusChip = (s: EventStatus) => chip(STATUS_TONE[s], s);

/** "DEVELOPMENT MODE — MOCK INTEGRATIONS" (mock) or the readiness of production mode. */
async function modePanel(workspaceId: string) {
  if (config.mockMode) {
    return html`<section class="card dev-note"><h2>DEVELOPMENT MODE — MOCK INTEGRATIONS</h2>
      <p>Instagram və Telegram <b>simulyasiya</b> olunur. Heç bir real mesaj göndərilmir; bütün hadisələr <b>SIMULATED</b> kimi qeyd olunur. Biznes məntiqi (şərh emalı, kartlar, qiymət cavabı, bildirişlər) isə real olanla eynidir.</p></section>`;
  }
  const r = await integrationReadiness(workspaceId);
  return html`<section class="card ${r.ready ? '' : 'dev-note'}"><h2>${r.ready ? 'PRODUCTION MODE' : 'PRODUCTION MODE — hazır deyil'}</h2>
    <p>${r.ready ? 'Bütün məlumatlar mövcuddur.' : 'Aşağıdakı tələblər tamamlanana qədər kataloq axınları (post aşkarlama, məhsul kartları, Telegram seçimi) işləmir.'}</p>
    <ul class="ready">${r.items.map((i) => html`<li>${chip(i.ok ? 'ok' : 'danger', i.ok ? 'Var' : 'Yoxdur')} ${i.label} <small class="muted">(${i.source})</small></li>`)}
      <li>${chip(r.commerceVerified ? 'ok' : 'danger', r.commerceVerified ? 'Təsdiqlənib' : 'Təsdiqlənməyib')} Kataloq axınları canlı API ilə yoxlanılıb <small class="muted">(META_COMMERCE_VERIFIED=on)</small></li></ul></section>`;
}

const productsForm = z.object({ products: z.union([z.string(), z.array(z.string())]).optional() });
const catalogForm = z.object({
  sku: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(''),
  price: z.coerce.number().min(0).max(1_000_000),
  image_url: z.string().trim().max(500).default(''),
});

export function commerceRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);
    const manage = requirePerm('integrations.manage');
    const mockOnly = async (_req: FastifyRequest, reply: FastifyReply) => {
      if (!config.mockMode) return reply.code(404).type('text/plain').send('Not found');
    };
    const igChannel = (workspaceId: string) =>
      one<any>(`SELECT * FROM channels WHERE workspace_id = $1 AND type = 'instagram' ORDER BY created_at LIMIT 1`, [workspaceId]);

    // ---------- Events ----------
    r.get('/app/activity', { preHandler: requirePerm('inbox.view') }, async (req, reply) => {
      const w = req.user!.workspaceId;
      const events = await listIntegrationEvents(w, { limit: 100 });
      return view(
        req,
        reply,
        'Hadisələr',
        html`${pageHead('İnteqrasiya hadisələri', 'Instagram və Telegram ilə bütün gedən-gələn hadisələr, statusu ilə.')}
        ${await modePanel(w)}
        <section class="card"><div class="legend">${STATUS_HELP.map(([s, t]) => html`<span>${eventStatusChip(s)} <small class="muted">${t}</small></span>`)}</div></section>
        <section class="card flush">${
          events.length
            ? html`<div class="table-wrap"><table><thead><tr><th>Vaxt</th><th>Provayder</th><th>İstiqamət</th><th>Növ</th><th>Status</th><th>Təsvir</th></tr></thead><tbody>
          ${events.map(
            (
              e,
            ) => html`<tr><td class="muted nowrap">${fmt(e.createdAt)}</td><td>${e.provider === 'instagram' ? 'Instagram' : 'Telegram'}${e.mode === 'mock' ? html` <small class="muted">(mock)</small>` : ''}</td>
            <td>${e.direction === 'in' ? 'gələn' : 'gedən'}</td><td><code>${e.kind}</code></td><td>${eventStatusChip(e.status)}${e.error ? html`<small class="muted block">${e.error}</small>` : ''}</td>
            <td>${e.summary.slice(0, 200)}</td></tr>`,
          )}</tbody></table></div>`
            : empty('zap', 'Hələ hadisə yoxdur.')
        }</section>`,
      );
    });

    // ---------- Catalog ----------
    r.get('/app/catalog', { preHandler: manage }, async (req, reply) => {
      const products = await listProducts(req.user!.workspaceId);
      return view(
        req,
        reply,
        'Kataloq',
        html`${pageHead('Məhsul kataloqu', 'Postlara bağlanan məhsullar. Qiymətlər müştəriyə həmişə buradan (bazadan) yazılır.')}
        <section class="card"><h2>Məhsul əlavə et</h2>
          <form method="post" action="/app/catalog" class="form-grid">${csrfField(req.csrfToken)}
            <label>Kod (SKU)<input name="sku" required maxlength="60"></label>
            <label>Ad<input name="name" required maxlength="80"></label>
            <label>Qiymət (AZN)<input name="price" type="number" min="0" step="0.01" required></label>
            <label>Təsvir<input name="description" maxlength="300"></label>
            <label>Şəkil (https://…)<input name="image_url" type="url" maxlength="500"></label>
            <button class="btn">${icon('plus')}Yadda saxla</button></form></section>
        <section class="card flush">${
          products.length
            ? html`<div class="table-wrap"><table><thead><tr><th>Kod</th><th>Ad</th><th>Qiymət</th><th>Vəziyyət</th><th></th></tr></thead><tbody>
          ${products.map(
            (
              p,
            ) => html`<tr><td><code>${p.sku}</code></td><td><b>${p.name}</b><small class="muted block">${p.description}</small></td><td class="nowrap">${priceLabel(p)}</td>
            <td>${p.active ? chip('ok', 'Aktiv') : chip('neutral', 'Deaktiv')}</td>
            <td class="right">${postForm(`/app/catalog/${p.id}/toggle`, req.csrfToken, p.active ? 'Deaktiv et' : 'Aktiv et', 'btn sm secondary')}</td></tr>`,
          )}</tbody></table></div>`
            : empty('list', 'Kataloq boşdur.')
        }</section>`,
      );
    });

    r.post('/app/catalog', { preHandler: manage }, async (req, reply) => {
      const p = catalogForm.safeParse(req.body);
      if (!p.success || (p.data.image_url && !p.data.image_url.startsWith('https://'))) return reply.redirect('/app/catalog?m=invalid');
      const w = req.user!.workspaceId;
      const row = await createProduct(w, {
        sku: p.data.sku,
        name: p.data.name,
        description: p.data.description,
        price: p.data.price,
        imageUrl: p.data.image_url,
      });
      await audit(w, req.user!.id, 'product.save', 'product', row.id, { sku: row.sku, price: row.price });
      return reply.redirect('/app/catalog?m=catalog_saved');
    });

    r.post('/app/catalog/:id/toggle', { preHandler: manage }, async (req, reply) => {
      const id = idParam(req);
      if (id) await q(`UPDATE products SET active = NOT active, updated_at = now() WHERE id = $1 AND workspace_id = $2`, [id, req.user!.workspaceId]);
      return reply.redirect('/app/catalog');
    });

    // ---------- Posts ----------
    r.get('/app/posts', { preHandler: manage }, async (req, reply) => {
      const w = req.user!.workspaceId;
      const [posts, products, ch] = await Promise.all([listPosts(w), listProducts(w, { activeOnly: true }), igChannel(w)]);
      const STATE: Record<string, [ChipTone, string]> = {
        pending: ['warn', 'Məhsul gözləyir'],
        assigned: ['ok', 'Məhsullar seçilib'],
        skipped: ['neutral', 'Məhsulsuz'],
      };
      return view(
        req,
        reply,
        'Postlar',
        html`${pageHead(
          'Instagram postları',
          'Hər postun məhsullarını seçin: altında "Qiymət?" yazanlara kataloqdan avtomatik cavab gedəcək.',
          ch ? postForm('/app/posts/detect', req.csrfToken, html`${icon('instagram')}Yeni postları yoxla`, 'btn') : undefined,
        )}
        ${!config.commerceEnabled ? html`<p class="flash error">${icon('alert')}<span>${MESSAGES.detect_off!.text}</span></p>` : ''}
        ${
          posts.length
            ? posts.map(
                (p) => html`<section class="card post"><div class="card-head"><h2>${p.caption.slice(0, 120) || p.media_id}</h2>
              <span>${chip(...(STATE[p.product_state] ?? STATE.pending!))} ${p.source === 'mock' ? chip('warn', 'mock') : ''}</span></div>
              <small class="muted">${fmt(p.detected_at)} · <code>${p.media_id}</code></small>
              <form method="post" action="/app/posts/${p.id}/products">${csrfField(req.csrfToken)}
                <div class="checks">${
                  products.length
                    ? products.map(
                        (pr) =>
                          html`<label class="check"><input type="checkbox" name="products" value="${pr.id}" ${p.products.some((x) => x.id === pr.id) ? 'checked' : ''}> ${pr.name} <small class="muted">${priceLabel(pr)}</small></label>`,
                      )
                    : html`<p class="muted">Kataloqda məhsul yoxdur. <a href="/app/catalog">Məhsul əlavə edin</a>.</p>`
                }</div>
                <div class="actions"><button class="btn sm">Yadda saxla</button>
                  <button class="btn sm secondary" formaction="/app/posts/${p.id}/skip">Məhsul yoxdur</button></div></form></section>`,
              )
            : empty('instagram', 'Hələ post yoxdur. "Yeni postları yoxla" basın.')
        }`,
      );
    });

    r.post('/app/posts/detect', { preHandler: manage }, async (req, reply) => {
      if (!config.commerceEnabled) return reply.redirect('/app/posts?m=detect_off');
      const ch = await igChannel(req.user!.workspaceId);
      if (!ch) return reply.redirect('/app/posts?m=no_instagram');
      await detectNewPosts(ch);
      return reply.redirect('/app/posts?m=detect_done');
    });

    r.post('/app/posts/:id/products', { preHandler: manage }, async (req, reply) => {
      const id = idParam(req);
      const p = productsForm.safeParse(req.body);
      if (!id || !p.success) return reply.redirect('/app/posts?m=invalid');
      const w = req.user!.workspaceId;
      const ids = [p.data.products ?? []].flat().filter((x) => z.uuid().safeParse(x).success);
      try {
        await setPostProducts(w, id, ids);
      } catch (e) {
        if (e instanceof PostProductError)
          return reply.redirect(`/app/posts?m=${e.message === 'empty' ? 'post_none' : e.message === 'too_many' ? 'post_max' : 'invalid'}`);
        throw e;
      }
      await audit(w, req.user!.id, 'post.products', 'ig_post', id, { count: ids.length });
      return reply.redirect('/app/posts?m=post_saved');
    });

    r.post('/app/posts/:id/skip', { preHandler: manage }, async (req, reply) => {
      const id = idParam(req);
      if (!id || !(await skipPost(req.user!.workspaceId, id))) return reply.redirect('/app/posts?m=invalid');
      return reply.redirect('/app/posts?m=post_skipped');
    });

    // ---------- Simulator (INTEGRATION_MODE=mock only) ----------
    r.get('/app/dev', { preHandler: [manage, mockOnly] }, async (req, reply) => {
      const w = req.user!.workspaceId;
      const [posts, ch, pending, cards, tgMessages, targets] = await Promise.all([
        listPosts(w, 20),
        igChannel(w),
        pendingPostCount(w),
        listIntegrationEvents(w, { kind: 'cards', limit: 3 }),
        listIntegrationEvents(w, { provider: 'telegram', limit: 40 }),
        q<{ chat_id: string; label: string }>(`SELECT chat_id, label FROM notify_targets WHERE workspace_id = $1 AND kind = 'telegram'`, [w]),
      ]);
      const buttons = tgMessages.filter((e) => e.direction === 'out' && e.externalId && (e.payload as any)?.keyboard?.length).slice(0, 3);
      const f = (action: string, inner: unknown, label: string) =>
        html`<form method="post" action="/app/dev/${action}" class="inline-form">${csrfField(req.csrfToken)}${inner}<button class="btn sm">${label}</button></form>`;
      return view(
        req,
        reply,
        'Simulyator',
        html`${pageHead('Simulyator', 'Instagram və Telegram hadisələrini özünüz yaradın. Hadisələr real webhook-larla eyni yoldan keçir; heç nə kənara göndərilmir.')}
        ${await modePanel(w)}
        <p class="flash ok">${icon('alert')}<span>Hadisələri <code>worker</code> prosesi emal edir: <code>npm run dev:worker</code> işləməlidir.</span></p>
        <section class="card"><h2>1. Demo məlumatlar</h2><p>Bir demo Instagram hesabı, 12 məhsul, FAQ və 4 nümunə post.</p>${f('seed', '', 'Demo məlumatları yüklə')}</section>
        <section class="card"><h2>2. Telegram</h2>
          <p>${targets.length ? html`Qoşulu: ${targets.map((t) => html`<code>${t.chat_id}</code> ${t.label} `)}` : 'Hələ qoşulmayıb.'}</p>
          ${f('telegram-connect', '', 'Telegram hesabını qoş (simulyasiya)')}
          ${buttons.map(
            (e) =>
              html`<div class="tg"><b>${(e.payload as any).text}</b><div class="actions">${(
                (e.payload as any).keyboard as { text: string; callbackData: string }[][]
              )
                .flat()
                .map((b) =>
                  f(
                    'telegram-press',
                    html`<input type="hidden" name="chat" value="${(e.payload as any).chatId}"><input type="hidden" name="message" value="${e.externalId}"><input type="hidden" name="data" value="${b.callbackData}">`,
                    b.text,
                  ),
                )}</div></div>`,
          )}</section>
        <section class="card"><h2>3. Yeni post</h2><p>${pending} post məhsul gözləyir.</p>
          ${f('publish', html`<input name="caption" value="Yeni məhsul gəldi! Qiymət üçün şərh yazın 🛍" maxlength="500" required>`, 'Instagram-da post dərc et (simulyasiya)')}
          ${postForm('/app/posts/detect', req.csrfToken, 'Yeni postları aşkar et', 'btn sm secondary')}</section>
        <section class="card"><h2>4. Müştəri şərhi</h2>
          ${
            posts.length && ch
              ? f(
                  'comment',
                  html`<select name="media">${posts.map((p) => html`<option value="${p.media_id}">${p.caption.slice(0, 50) || p.media_id}</option>`)}</select>
                  <input name="text" value="Qiymət?" maxlength="300" required><input name="user" value="aysel" maxlength="40" required>`,
                  'Şərh yaz',
                )
              : html`<p class="muted">Əvvəlcə demo məlumatları yükləyin.</p>`
          }</section>
        <section class="card"><h2>5. Məhsul seçimi (kart düyməsi)</h2>${
          cards.length
            ? cards
                .slice(0, 1)
                .map(
                  (e) =>
                    html`<p class="muted">Müştəri <code>${(e.payload as any).to}</code> üçün göndərilən kartlar:</p><div class="actions">${(
                      (e.payload as any).cards as { title: string; buttons: { payload: string; title: string }[] }[]
                    ).map((c) =>
                      f(
                        'tap',
                        html`<input type="hidden" name="user" value="${(e.payload as any).to}"><input type="hidden" name="payload" value="${c.buttons[0]!.payload}">`,
                        `${c.title}: ${c.buttons[0]!.title}`,
                      ),
                    )}</div>`,
                )
            : html`<p class="muted">Hələ kart göndərilməyib: çox məhsullu postun altında "Qiymət?" yazın.</p>`
        }</section>`,
      );
    });

    const back = (reply: FastifyReply, m: string, to = '/app/dev') => reply.redirect(`${to}?m=${m}`);

    r.post('/app/dev/seed', { preHandler: [manage, mockOnly] }, async (req, reply) => {
      await seedDemoData(req.user!.workspaceId);
      return back(reply, 'sim_seeded');
    });
    r.post('/app/dev/telegram-connect', { preHandler: [manage, mockOnly] }, async (req, reply) => {
      await sim.simulateTelegramConnect(req.user!.workspaceId, req.user!.id);
      return back(reply, 'sim_done');
    });
    r.post('/app/dev/telegram-press', { preHandler: [manage, mockOnly] }, async (req, reply) => {
      const b = z.object({ chat: z.string().regex(/^\d{1,20}$/), message: z.string().regex(/^\d{1,20}$/), data: z.string().max(64) }).safeParse(req.body);
      if (!b.success) return back(reply, 'invalid');
      // Only a chat linked to this business can "press": the handler checks the same for the real bot.
      await sim.simulateTelegramCallback(b.data.chat, b.data.message, b.data.data);
      return back(reply, 'sim_done');
    });
    r.post('/app/dev/publish', { preHandler: [manage, mockOnly] }, async (req, reply) => {
      const b = z.object({ caption: z.string().trim().min(1).max(500) }).safeParse(req.body);
      if (!b.success || !(await igChannel(req.user!.workspaceId))) return back(reply, b.success ? 'no_instagram' : 'invalid');
      await sim.simulatePublishPost(req.user!.workspaceId, b.data.caption);
      return back(reply, 'sim_done');
    });
    r.post('/app/dev/comment', { preHandler: [manage, mockOnly] }, async (req, reply) => {
      const b = z.object({ media: z.string().max(100), text: z.string().trim().min(1).max(300), user: z.string().trim().min(1).max(40) }).safeParse(req.body);
      if (!b.success || !(await igChannel(req.user!.workspaceId))) return back(reply, b.success ? 'no_instagram' : 'invalid');
      await sim.simulateComment(req.user!.workspaceId, b.data.media, b.data.text, { id: `mock_user_${b.data.user}`, username: b.data.user });
      return back(reply, 'sim_queued');
    });
    r.post('/app/dev/tap', { preHandler: [manage, mockOnly] }, async (req, reply) => {
      const b = z.object({ user: z.string().max(100), payload: z.string().max(100) }).safeParse(req.body);
      if (!b.success || !(await igChannel(req.user!.workspaceId))) return back(reply, b.success ? 'no_instagram' : 'invalid');
      await sim.simulatePostback(req.user!.workspaceId, b.data.user, b.data.payload);
      return back(reply, 'sim_queued');
    });
  });
}
