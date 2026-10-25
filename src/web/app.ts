import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { generateReply } from '../ai.js';
import { removeChannel } from '../channels/index.js';
import { exchangeInstagramCode, instagramAuthorizeUrl, subscribeInstagram } from '../channels/instagram.js';
import type { ChannelRow } from '../channels/types.js';
import { completeEmbeddedSignup } from '../channels/whatsapp.js';
import { config } from '../config.js';
import { decrypt, encrypt, randomToken, sha256 } from '../crypto.js';
import { one, q, tx } from '../db.js';
import { reserveReply } from '../pipeline.js';
import { queue, redis } from '../queue.js';
import { telegramEnabled } from '../telegram.js';
import { newTotpSecret, otpauthUrl, verifyTotp } from '../totp.js';
import { subscriptionSchema } from '../webpush.js';
import QRCode from 'qrcode';
import { destroySession, requireOwner, requireUser } from './auth.js';
import { csrfField, html, pageHead, raw, type Safe } from './html.js';
import { channelIcon, icon, type IconName } from './icons.js';
import { convRow, CONV_LIST_SQL } from './inbox.js';
import { ARGON, MESSAGES, passwordSchema, view } from './public.js';

Object.assign(MESSAGES, {
  saved: { type: 'ok', text: 'Yadda saxlanıldı.' },
  ig_connected: { type: 'ok', text: 'Instagram hesabı bağlandı.' },
  wa_connected: { type: 'ok', text: 'WhatsApp nömrəsi bağlandı.' },
  disconnected: { type: 'ok', text: 'Kanal ayrıldı və onun bütün məlumatları silindi.' },
  connect_failed: { type: 'error', text: 'Bağlantı alınmadı. Yenidən cəhd edin.' },
  window_closed: { type: 'error', text: 'Müştərinin son mesajından 24 saat keçib. Meta qaydalarına görə indi cavab göndərmək olmur.' },
  sent: { type: 'ok', text: 'Göndərildi. AI bu söhbətdə 12 saat dayandırıldı.' },
  send_failed: { type: 'error', text: 'Göndərmək alınmadı. Bir az sonra yenidən cəhd edin.' },
  limit: { type: 'error', text: 'Aylıq AI cavab limitiniz bitib.' },
  expired: { type: 'error', text: 'Abunəliyin müddəti bitib, AI cavablar dayandırılıb. Administratorla əlaqə saxlayın.' },
  bad_password: { type: 'error', text: 'Şifrə yanlışdır.' },
  learning: { type: 'ok', text: 'Yazışmalarınız oxunur. Üslub 1-2 dəqiqəyə hazır olacaq, sonra səhifəni yeniləyin.' },
  tg_removed: { type: 'ok', text: 'Bildiriş kanalı ayrıldı.' },
  mfa_required: { type: 'error', text: 'Admin paneli üçün iki faktorlu girişi qurmalısınız.' },
  mfa_on: { type: 'ok', text: 'İki faktorlu giriş aktivdir.' },
  mfa_off: { type: 'ok', text: 'İki faktorlu giriş söndürüldü.' },
  bad_code: { type: 'error', text: 'Kod yanlışdır. Telefonunuzdakı vaxtın düzgün olduğunu yoxlayın.' },
  push_on: { type: 'ok', text: 'Bu brauzerdə bildirişlər aktivdir.' },
});

const uuid = z.uuid();
const idParam = (req: FastifyRequest) => uuid.safeParse((req.params as any).id).data;
const BAKU = { timeZone: 'Asia/Baku' } as const;
const fmt = (d: Date | string | null) => (d ? new Date(d).toLocaleString('az-AZ', { ...BAKU, dateStyle: 'short', timeStyle: 'short' }) : '—');
/** Short relative time for lists: "14:05" today, otherwise "24.10". */
const when = (d: Date | string) => {
  const t = new Date(d);
  const sameDay = t.toLocaleDateString('az-AZ', BAKU) === new Date().toLocaleDateString('az-AZ', BAKU);
  return sameDay ? t.toLocaleTimeString('az-AZ', { ...BAKU, hour: '2-digit', minute: '2-digit' }) : t.toLocaleDateString('az-AZ', { ...BAKU, day: '2-digit', month: '2-digit' });
};
const typeLabel = (t: string) => (t === 'whatsapp' ? 'WhatsApp' : 'Instagram');
const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const initials = (name: string) => (name.replace(/^@/, '').trim().slice(0, 1) || '?').toUpperCase();
const avatar = (name: string, type: string) => html`<span class="avatar ${type === 'whatsapp' ? 'wa' : 'ig'}">${initials(name)}<span class="badge">${channelIcon(type)}</span></span>`;
const chip = (cls: 'ok' | 'warn' | 'danger' | 'neutral', text: string) => html`<span class="chip ${cls}">${text}</span>`;
const stat = (ic: IconName, label: string, value: unknown, meta: unknown = '', tone = '') =>
  html`<div class="stat ${tone}"><span class="stat-ic">${icon(ic)}</span><div><p class="stat-label">${label}</p><p class="stat-value">${value}</p>${meta ? html`<p class="stat-meta">${meta}</p>` : ''}</div></div>`;
const confirmForm = (action: string, csrf: string, label: Safe, cls: string, confirm?: string, extra?: Safe) =>
  html`<form method="post" action="${action}" class="inline" ${confirm ? html`data-confirm="${confirm}"` : ''}>${csrfField(csrf)}${extra}<button class="${cls}">${label}</button></form>`;

const notifyRow = (csrf: string, ic: IconName, title: string, sub: string, enabled: boolean, n: number, action: string, label: string) =>
  html`<div class="notify-row"><span class="nt-ic">${icon(ic)}</span><div><b>${title}</b><small>${sub}</small></div>
    ${enabled ? html`${n ? chip('ok', 'qoşulub') : ''}<form method="post" action="${action}" class="inline">${csrfField(csrf)}<button class="btn sm ${n ? 'secondary' : ''}">${n ? 'Daha birini qoş' : label}</button></form>` : html`<span class="chip neutral">qurulmayıb</span>`}</div>`;

/** A platform account can belong to one workspace only; moving it drops the old workspace's data. */
async function claimExternalAccount(type: 'whatsapp' | 'instagram', externalId: string, workspaceId: string) {
  const others = await q<ChannelRow>('SELECT * FROM channels WHERE type = $1 AND external_id = $2 AND workspace_id <> $3', [type, externalId, workspaceId]);
  for (const ch of others) await q('DELETE FROM channels WHERE id = $1', [ch.id]);
}

export function appRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    // ---------- Dashboard ----------
    r.get('/app', async (req, reply) => {
      const w = req.user!.workspaceId;
      const [ws, a, chans, usage, counts, recent] = await Promise.all([
        one('SELECT name, monthly_reply_limit, paid_until, coalesce(paid_until < current_date, false) AS expired FROM workspaces WHERE id = $1', [w]),
        one('SELECT enabled, knowledge FROM assistants WHERE workspace_id = $1', [w]),
        q<ChannelRow>('SELECT type, display_name, status FROM channels WHERE workspace_id = $1', [w]),
        one(`SELECT ai_replies FROM usage_counters WHERE workspace_id = $1 AND period = to_char(now(), 'YYYY-MM')`, [w]),
        one(
          `SELECT (SELECT count(*)::int FROM messages WHERE workspace_id = $1 AND direction = 'in' AND created_at >= (now() AT TIME ZONE 'Asia/Baku')::date AT TIME ZONE 'Asia/Baku') AS today,
                  (SELECT count(*)::int FROM conversations WHERE workspace_id = $1 AND needs_human) AS waiting`,
          [w],
        ),
        q(`${CONV_LIST_SQL} AND c.status = 'open' ORDER BY c.needs_human DESC, c.last_message_at DESC LIMIT 5`, [w]),
      ]);
      const used = usage?.ai_replies ?? 0;
      const pct = ws.monthly_reply_limit ? Math.min(100, Math.round((used / ws.monthly_reply_limit) * 100)) : 100;
      const steps = [
        [a.knowledge.length > 50, 'Biznes məlumatlarını yazın', 'Qiymətlər, iş saatları, çatdırılma, FAQ', '/app/assistant'],
        [chans.length > 0, 'Instagram və ya WhatsApp bağlayın', 'Bir kliklə, şifrə paylaşmadan', '/app/channels'],
        [a.enabled, 'AI cavabları aktiv edin', 'Əvvəlcə "Test et" bölməsində yoxlayın', '/app/assistant'],
      ] as const;
      const allDone = steps.every((s) => s[0]);
      return view(req, reply, 'Panel', html`${ws.expired ? html`<p class="flash error">${icon('alert')}<span>${MESSAGES.expired!.text}</span></p>` : ''}
        ${pageHead(ws.name, html`AI köməkçi: ${a.enabled ? chip('ok', 'Aktiv') : chip('neutral', 'Deaktiv')}${ws.paid_until ? html` · Abunəlik: <b>${day(ws.paid_until)}</b> tarixinə qədər` : ''}`,
          html`<a class="btn" href="/app/inbox">${icon('chat')}Söhbətlərə keç</a>`)}
        <div class="stats">
          ${stat('inbox', 'Bu gün gələn mesajlar', counts.today)}
          ${stat('bot', 'Bu ay AI cavabları', html`${used}<small> / ${ws.monthly_reply_limit}</small>`, html`<span class="bar"><span style="width:${pct}%"></span></span>`)}
          ${stat('headset', 'Operator gözləyir', counts.waiting, counts.waiting ? html`<a href="/app/inbox?f=human">Cavab verin →</a>` : 'Hamısı cavablanıb', counts.waiting ? 'warn' : '')}
          ${stat('plug', 'Bağlı kanallar', chans.length, chans.length ? chans.map((c) => html`${channelIcon(c.type)} `) : html`<a href="/app/channels">Bağlayın →</a>`)}
        </div>
        <div class="cols">
          <section class="card">
            <div class="card-head"><h2>Son söhbətlər</h2><a href="/app/inbox" class="more">Hamısı ${icon('arrow', 'i xs')}</a></div>
            ${recent.length ? html`<div class="conv-list">${recent.map((c) => convRow(c))}</div>`
              : html`<div class="empty">${icon('chat', 'i lg')}<p>Hələ mesaj yoxdur. Kanal bağlayandan sonra müştəri mesajları burada görünəcək.</p></div>`}
          </section>
          <div class="stack">
            ${allDone ? '' : html`<section class="card"><h2>Başlanğıc</h2><ol class="steps">${steps.map(([done, t, s, href]) =>
              html`<li class="${done ? 'done' : ''}"><a href="${href}">${icon(done ? 'check' : 'circle')}<span><b>${t}</b><small>${s}</small></span></a></li>`)}</ol></section>`}
            <section class="card how"><h2>Mesajlar necə idarə olunur?</h2>
              <ol>
                <li>${icon('bot')}<span><b>AI avtomatik cavab verir</b><small>Instagram və WhatsApp-a gələn hər mesaja, sizin yazdığınız məlumatlar əsasında.</small></span></li>
                <li>${icon('headset')}<span><b>Bilmədiyini sizə bildirir</b><small>Endirim, şikayət, sifariş təsdiqi kimi hallarda müştəriyə təbii şəkildə "bir dəqiqə" yazır, sizə isə Telegram və ya e-poçtla bildiriş gəlir.</small></span></li>
                <li>${icon('chat')}<span><b>Siz "Söhbətlər"dən cavab verirsiniz</b><small>Bütün yazışmalar orada görünür. Əl ilə yazdıqda AI həmin söhbətdə dayanır.</small></span></li>
              </ol></section>
          </div>
        </div>`);
    });

    // ---------- Assistant ----------
    r.get('/app/assistant', async (req, reply) => {
      const a = await one('SELECT * FROM assistants WHERE workspace_id = $1', [req.user!.workspaceId]);
      return view(req, reply, 'AI köməkçi', html`${pageHead('AI köməkçi', 'AI yalnız burada yazdığınız məlumatlara əsasən cavab verir. Bilmədiyi sualı sizə ötürür.')}
        <form method="post" action="/app/assistant" class="form-grid">${csrfField(req.csrfToken)}
          <section class="card span">
            <label class="switch-row"><span><b>Avtomatik cavablar</b><small>Söndürsəniz, AI heç bir mesaja cavab vermir.</small></span>
              <input type="checkbox" class="switch" name="enabled" value="1" ${a.enabled ? raw('checked') : ''}></label></section>
          <section class="card span"><div class="card-head"><h2>${icon('book')}Biznes məlumatları</h2></div>
            <label>Biznesin adı<input name="business_name" value="${a.business_name}" maxlength="120" required></label>
            <label>Məlumat bazası
              <textarea name="knowledge" rows="14" maxlength="30000" placeholder="Nə satırsınız, qiymətlər, iş saatları, ünvan, çatdırılma, ödəniş üsulları, qaytarma qaydaları, tez-tez verilən suallar...">${a.knowledge}</textarea>
              <small class="help">Nə qədər ətraflı yazsanız, AI bir o qədər dəqiq cavab verir. Qiymət dəyişəndə burada yeniləyin.</small></label></section>
          <section class="card span"><div class="card-head"><h2>${icon('sparkle')}Danışıq üslubu</h2>
              <button class="btn sm secondary" formaction="/app/assistant/learn" formnovalidate>${icon('book')}Yazışmalarımdan öyrən</button></div>
            <p class="muted">AI sizin kimi yazsın deyə köhnə yazışmalarınızı oxuyur: yazılış (məsələn "qiymet"), "sən/siz", emoji, mesaj uzunluğu.
              ${a.style_learned_at ? html`Son öyrənmə: <b>${fmt(a.style_learned_at)}</b>.` : html`Instagram tarixçəsi və paneldən yazdığınız cavablar istifadə olunur.`}</p>
            <label>Öyrənilmiş üslub (istəsəniz düzəldin)
              <textarea name="style_guide" rows="6" maxlength="1500" placeholder="Hələ öyrənilməyib. Yuxarıdakı düyməni basın və ya özünüz yazın: məsələn, 'ə' əvəzinə 'e' yazır, 'siz' deyir, hər mesajın sonunda 🙏 qoyur.">${a.style_guide}</textarea></label>
            <label>Ümumi ton
              <select name="style_preset">${[['auto', 'Avtomatik (müştəriyə uyğunlaşır)'], ['friendly', 'Səmimi, isti'], ['polite', 'Nəzakətli, "siz"'], ['short', 'Çox qısa, tez']].map(
                ([v, l]) => html`<option value="${v}" ${a.style_preset === v ? raw('selected') : ''}>${l}</option>`)}</select></label>
            <label class="switch-row"><span><b>AI olduğunu bildir</b><small>Söndürülüb: AI özünü təqdim etmir. Müştəri ciddi şəkildə "bot-san?" soruşarsa, yalan danışmır.</small></span>
              <input type="checkbox" class="switch" name="ai_disclosure" value="1" ${a.ai_disclosure ? raw('checked') : ''}></label></section>
          <section class="card span"><div class="card-head"><h2>${icon('headset')}Bilmədiyi suallar</h2></div>
            <p class="muted">AI cavabı bilməyəndə müştəriyə öz üslubunda qısa, təbii bir cavab yazır (operator və ya AI sözü işlətmədən) və sizə bildiriş göndərir.</p>
            <label>Ehtiyat gözləmə mesajı<input name="handoff_message" value="${a.handoff_message}" maxlength="500"></label>
            <small class="help">Müştəri "operator" və ya "insan" yazanda, ya da limit bitəndə göndərilir. Boş qoysanız, heç nə yazılmır.</small></section>
          <div class="span form-actions"><a class="btn secondary" href="/app/test">${icon('flask')}Test et</a><button class="btn">Yadda saxla</button></div>
        </form>`);
    });

    r.post('/app/assistant', async (req, reply) => {
      const p = z
        .object({
          business_name: z.string().trim().min(1).max(120),
          knowledge: z.string().max(30000),
          style_guide: z.string().trim().max(1500),
          style_preset: z.enum(['auto', 'friendly', 'polite', 'short']),
          handoff_message: z.string().trim().max(500),
          enabled: z.literal('1').optional(),
          ai_disclosure: z.literal('1').optional(),
        })
        .safeParse(req.body);
      if (!p.success) return reply.redirect('/app/assistant?m=invalid');
      const d = p.data;
      await q(
        `UPDATE assistants SET business_name = $2, knowledge = $3, style_guide = $4, style_preset = $5, handoff_message = $6, enabled = $7, ai_disclosure = $8, updated_at = now() WHERE workspace_id = $1`,
        [req.user!.workspaceId, d.business_name, d.knowledge, d.style_guide, d.style_preset, d.handoff_message, !!d.enabled, !!d.ai_disclosure],
      );
      return reply.redirect('/app/assistant?m=saved');
    });

    // One learning run per workspace at a time; each run is a single small AI call.
    r.post('/app/assistant/learn', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (req, reply) => {
      await queue.add('learn_style', { kind: 'learn_style', workspaceId: req.user!.workspaceId }, { jobId: `learn-${req.user!.workspaceId}-${Math.floor(Date.now() / 600_000)}` });
      return reply.redirect('/app/assistant?m=learning');
    });

    // ---------- Test chat (single turn, counts toward usage) ----------
    const testPage = (req: FastifyRequest, msg = '', answer: Safe | '' = '') => html`${pageHead('Test et', 'Müştəri kimi yazın və AI-nin necə cavab verəcəyini görün. Bu mesajlar müştərilərə getmir.')}
      <section class="card phone">
        <div class="thread">${msg ? html`<div class="msg customer"><div class="bubble">${msg}</div></div>${answer}` : html`<div class="empty">${icon('flask', 'i lg')}<p>Məsələn: "Çatdırılma neçəyədir?" və ya "Saat neçədə açıqsınız?"</p></div>`}</div>
        <form class="composer" method="post" action="/app/test">${csrfField(req.csrfToken)}
          <textarea name="message" rows="2" maxlength="1000" required placeholder="Müştərinin mesajını yazın…"></textarea><button class="btn" aria-label="Göndər">${icon('send')}</button></form>
      </section>`;
    r.get('/app/test', (req, reply) => view(req, reply, 'Test', testPage(req)));
    r.post('/app/test', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      const msg = z.string().trim().min(1).max(1000).safeParse((req.body as any)?.message).data;
      if (!msg) return reply.redirect('/app/test?m=invalid');
      const quota = await reserveReply(req.user!.workspaceId);
      if (quota !== 'ok') return reply.redirect(`/app/test?m=${quota}`);
      const a = await one('SELECT * FROM assistants WHERE workspace_id = $1', [req.user!.workspaceId]);
      const res = await generateReply(a, [{ role: 'user', text: msg }], a.ai_disclosure, { workspaceId: req.user!.workspaceId, purpose: 'test' });
      const answer =
        res.kind === 'reply'
          ? html`<div class="msg ai"><div class="bubble">${res.text}</div><small>${icon('bot', 'i xs')} AI</small></div>`
          : html`<div class="msg ai"><div class="bubble">${a.handoff_message}</div><small>${icon('headset', 'i xs')} Operatora ötürüldü · ${res.reason}</small></div>`;
      return view(req, reply, 'Test', testPage(req, msg, answer));
    });

    // ---------- Channels ----------
    r.get('/app/channels', async (req, reply) => {
      const chans = await q<ChannelRow>('SELECT * FROM channels WHERE workspace_id = $1 ORDER BY created_at', [req.user!.workspaceId]);
      const owner = req.user!.role === 'owner';
      const head = config.whatsappEnabled
        ? html`<script src="/public/wa-signup.js" defer></script><script async defer crossorigin="anonymous" src="https://connect.facebook.net/en_US/sdk.js"></script>`
        : undefined;
      const card = (type: 'instagram' | 'whatsapp', desc: string, connect: Safe) => {
        const list = chans.filter((c) => c.type === type);
        return html`<section class="card channel">
          <div class="channel-top"><span class="brand-tile ${type === 'whatsapp' ? 'wa' : 'ig'}">${channelIcon(type)}</span>
            <div><h2>${typeLabel(type)}</h2><p class="muted">${desc}</p></div></div>
          ${list.map((c) => html`<div class="acct"><span>${icon(c.status === 'active' ? 'check' : 'alert')}<b>${c.display_name}</b></span>
            ${c.status === 'active' ? chip('ok', 'Bağlıdır') : chip('danger', 'Xəta, yenidən bağlayın')}
            ${owner ? confirmForm(`/app/channels/${c.id}/disconnect`, req.csrfToken, html`Ayır`, 'btn sm danger-ghost', 'Kanal ayrılsın və bütün söhbətləri silinsin?') : ''}</div>`)}
          ${owner ? connect : ''}</section>`;
      };
      return view(req, reply, 'Kanallar', html`${pageHead('Kanallar', 'Hesabınızı bir kliklə bağlayın. Şifrənizi bizimlə paylaşmırsınız, giriş Meta-nın öz səhifəsində olur.')}
        <div class="channels">
          ${card('instagram', 'Direct mesajlara avtomatik cavab. Hesab Business və ya Creator olmalıdır.',
            config.instagramEnabled ? html`<a class="btn" href="/app/channels/instagram/connect">${icon('link')}Instagram bağla</a>` : html`<p class="hint">Meta tətbiqi hələ qurulmayıb (IG_APP_ID).</p>`)}
          ${card('whatsapp', 'WhatsApp Business nömrənizə gələn mesajlara avtomatik cavab.',
            config.whatsappEnabled
              ? html`<button class="btn" id="wa-connect" data-app-id="${config.META_APP_ID}" data-config-id="${config.WA_EMBEDDED_SIGNUP_CONFIG_ID}" data-version="${config.META_GRAPH_VERSION}" data-csrf="${req.csrfToken}">${icon('link')}WhatsApp bağla</button><p class="hint" id="wa-status"></p>`
              : html`<p class="hint">Meta tətbiqi hələ qurulmayıb (META_APP_ID).</p>`)}
        </div>
        <p class="hint">${icon('lock', 'i xs')} Yalnız mesajları oxumaq və cavab göndərmək icazəsi istəyirik. Kanalı ayıranda onun bütün yazışmaları silinir.</p>`, head);
    });

    r.get('/app/channels/instagram/connect', { preHandler: requireOwner }, async (req, reply) => {
      if (!config.instagramEnabled) return reply.redirect('/app/channels?m=connect_failed');
      const state = randomToken();
      await q(`INSERT INTO oauth_states (state_hash, workspace_id, provider, expires_at) VALUES ($1, $2, 'instagram', now() + interval '10 minutes')`, [
        sha256(state),
        req.user!.workspaceId,
      ]);
      return reply.redirect(instagramAuthorizeUrl(state));
    });

    r.get('/oauth/instagram/callback', { preHandler: requireOwner }, async (req, reply) => {
      const { code, state } = req.query as Record<string, string | undefined>;
      if (!code || !state || state.length > 100) return reply.redirect('/app/channels?m=connect_failed');
      const st = await one(`DELETE FROM oauth_states WHERE state_hash = $1 AND provider = 'instagram' AND expires_at > now() RETURNING workspace_id`, [sha256(state)]);
      if (!st || st.workspace_id !== req.user!.workspaceId) return reply.redirect('/app/channels?m=connect_failed');
      try {
        const ig = await exchangeInstagramCode(code.replace(/#_$/, ''));
        await subscribeInstagram(ig.token);
        await claimExternalAccount('instagram', ig.igId, req.user!.workspaceId);
        await q(
          `INSERT INTO channels (workspace_id, type, external_id, display_name, access_token_enc, token_expires_at, scopes, token_refreshed_at) VALUES ($1, 'instagram', $2, $3, $4, $5, $6, now())
           ON CONFLICT (type, external_id) DO UPDATE SET display_name = EXCLUDED.display_name, access_token_enc = EXCLUDED.access_token_enc,
             token_expires_at = EXCLUDED.token_expires_at, scopes = EXCLUDED.scopes, token_refreshed_at = now(), status = 'active', status_reason = ''`,
          [req.user!.workspaceId, ig.igId, `@${ig.username}`, encrypt(ig.token), ig.expiresAt, ig.scopes],
        );
        await queue.add('learn_style', { kind: 'learn_style', workspaceId: req.user!.workspaceId }, { delay: 5000 });
        return reply.redirect('/app/channels?m=ig_connected');
      } catch (e) {
        req.log.warn({ err: e }, 'instagram connect failed');
        return reply.redirect('/app/channels?m=connect_failed');
      }
    });

    r.post('/app/channels/whatsapp/complete', { preHandler: requireOwner, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
      const p = z
        .object({ code: z.string().min(10).max(2000), waba_id: z.string().regex(/^\d{5,25}$/), phone_number_id: z.string().regex(/^\d{5,25}$/) })
        .safeParse(req.body);
      if (!p.success || !config.whatsappEnabled) return reply.code(400).send({ ok: false });
      try {
        const wa = await completeEmbeddedSignup(p.data.code, p.data.waba_id, p.data.phone_number_id);
        await claimExternalAccount('whatsapp', p.data.phone_number_id, req.user!.workspaceId);
        await q(
          `INSERT INTO channels (workspace_id, type, external_id, waba_id, display_name, access_token_enc, extra_enc) VALUES ($1, 'whatsapp', $2, $3, $4, $5, $6)
           ON CONFLICT (type, external_id) DO UPDATE SET waba_id = EXCLUDED.waba_id, display_name = EXCLUDED.display_name,
             access_token_enc = EXCLUDED.access_token_enc, extra_enc = coalesce(EXCLUDED.extra_enc, channels.extra_enc), status = 'active', status_reason = '', scopes = '{whatsapp_business_messaging,whatsapp_business_management}'`,
          [req.user!.workspaceId, p.data.phone_number_id, p.data.waba_id, wa.displayName, encrypt(wa.token), wa.pin ? encrypt(JSON.stringify({ pin: wa.pin })) : null],
        );
        return reply.send({ ok: true });
      } catch (e) {
        req.log.warn({ err: e }, 'whatsapp connect failed');
        return reply.code(400).send({ ok: false });
      }
    });

    r.post('/app/channels/:id/disconnect', { preHandler: requireOwner }, async (req, reply) => {
      const id = idParam(req);
      const ch = id && (await one<ChannelRow>('SELECT * FROM channels WHERE id = $1 AND workspace_id = $2', [id, req.user!.workspaceId]));
      if (ch) await removeChannel(ch);
      return reply.redirect('/app/channels?m=disconnected');
    });

    // ---------- Settings ----------
    r.get('/app/settings', async (req, reply) => {
      const targets = await q<{ kind: string }>(`SELECT kind FROM notify_targets WHERE workspace_id = $1`, [req.user!.workspaceId]);
      const count = (k: string) => targets.filter((t) => t.kind === k).length;
      return view(req, reply, 'Ayarlar', html`${pageHead('Ayarlar', html`Hesab: <b>${req.user!.email}</b>`)}
        <div class="form-grid">
          <section class="card span"><div class="card-head"><h2>${icon('zap')}Bildirişlər</h2></div>
            <p class="muted">Müştəri sizin cavabınızı gözləyəndə (AI bilmədiyi sual, şikayət, sifariş təsdiqi) xəbər tutun. Bir neçə yolu birlikdə qoşa bilərsiniz.</p>
            <div class="notify-grid">
              ${notifyRow(req.csrfToken, 'whatsapp', 'WhatsApp', 'Şəxsi WhatsApp-ınıza mesaj', config.waAlertsEnabled, count('whatsapp'), '/app/notifications/whatsapp', 'WhatsApp-ı qoş')}
              ${notifyRow(req.csrfToken, 'send', 'Telegram', 'Telegram botundan mesaj', telegramEnabled(), count('telegram'), '/app/notifications/telegram', 'Telegram-ı qoş')}
              <div class="notify-row"><span class="nt-ic">${icon('globe')}</span><div><b>Chrome bildirişi</b><small>Kompüter və ya telefon brauzerində</small></div>
                ${config.pushEnabled
                  ? html`${count('webpush') ? chip('ok', `${count('webpush')} cihaz`) : ''}<button type="button" class="btn sm" id="push-enable" data-key="${config.VAPID_PUBLIC_KEY}" data-csrf="${req.csrfToken}">Bu cihazda aç</button>`
                  : html`<span class="chip neutral">qurulmayıb</span>`}</div>
            </div>
            <p class="hint" id="push-status"></p>
            ${targets.length ? confirmForm('/app/notifications/telegram/remove', req.csrfToken, html`Bütün bildiriş kanallarını ayır`, 'btn sm danger-ghost', 'Bütün bildiriş kanalları ayrılsın?') : ''}
            <p class="hint">${icon('inbox', 'i xs')} ${config.mailEnabled ? 'E-poçt bildirişləri də aktivdir.' : 'E-poçt bildirişi üçün SMTP qurulmalıdır.'}</p></section>
          <section class="card span"><div class="card-head"><h2>${icon('shield')}İki faktorlu giriş</h2>
              ${req.user!.mfa ? chip('ok', 'Aktiv') : chip('neutral', 'Söndürülüb')}</div>
            <p class="muted">Şifrədən əlavə telefonunuzdakı Google Authenticator (və ya Authy) kodu tələb olunur. ${req.user!.isAdmin ? 'Admin üçün məcburidir.' : 'Tövsiyə olunur.'}</p>
            ${req.user!.mfa
              ? req.user!.isAdmin ? '' : html`<form method="post" action="/app/2fa/disable" class="inline-form">${csrfField(req.csrfToken)}<input name="code" inputmode="numeric" maxlength="6" placeholder="6 rəqəmli kod" required><button class="btn sm danger-ghost">Söndür</button></form>`
              : html`<a class="btn" href="/app/2fa">${icon('shield')}Qur</a>`}</section>
          <section class="card"><div class="card-head"><h2>${icon('lock')}Şifrəni dəyiş</h2></div>
            <form method="post" action="/app/settings/password">${csrfField(req.csrfToken)}
              <label>Hazırkı şifrə<input name="current" type="password" required autocomplete="current-password"></label>
              <label>Yeni şifrə (min. 10 simvol)<input name="password" type="password" required minlength="10" maxlength="200" autocomplete="new-password"></label>
              <button class="btn">Dəyiş</button></form></section>
          <section class="card"><div class="card-head"><h2>${icon('download')}Məlumatlarım</h2></div>
            <p class="muted">Bütün ayarlarınızı və yazışmalarınızı JSON faylı kimi yükləyin.</p><a class="btn secondary" href="/app/settings/export">${icon('download')}Yüklə</a>
            ${req.user!.role === 'owner' ? html`<div class="danger-zone"><h3>Hesabı sil</h3><p class="muted">Bütün kanallar, söhbətlər və hesab həmişəlik silinəcək.</p>
              <form method="post" action="/app/settings/delete" data-confirm="Hesab və bütün məlumatlar həmişəlik silinsin?">${csrfField(req.csrfToken)}
                <label>Təsdiq üçün şifrə<input name="password" type="password" required autocomplete="current-password"></label><button class="btn danger">${icon('trash')}Hesabı sil</button></form></div>` : ''}
          </section></div>`, config.pushEnabled ? html`<script src="/public/push.js" defer></script>` : undefined);
    });

    // ---------- Two-factor login ----------
    r.get('/app/2fa', async (req, reply) => {
      if (req.user!.mfa) return reply.redirect('/app/settings?m=mfa_on');
      const secret = newTotpSecret();
      await redis.set(`mfa-setup:${req.user!.id}`, encrypt(secret), 'EX', 600);
      const qr = await QRCode.toString(otpauthUrl(req.user!.email, secret), { type: 'svg', margin: 1, width: 200 });
      return view(req, reply, 'İki faktorlu giriş', html`${pageHead('İki faktorlu girişi qurun', 'Telefonunuzda Google Authenticator, Authy və ya 1Password açın.')}
        <section class="card mfa">
          <ol class="mfa-steps"><li>Tətbiqdə <b>+</b> basın və bu QR kodu skan edin:</li></ol>
          <div class="qr">${raw(qr)}</div>
          <p class="muted">Skan edə bilmirsinizsə, bu açarı əl ilə daxil edin: <code>${secret.replace(/(.{4})/g, '$1 ').trim()}</code></p>
          <ol class="mfa-steps" start="2"><li>Tətbiqin göstərdiyi 6 rəqəmli kodu yazın:</li></ol>
          <form method="post" action="/app/2fa" class="inline-form">${csrfField(req.csrfToken)}
            <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="123456"><button class="btn">Təsdiqlə və aktiv et</button></form>
        </section>`);
    });

    r.post('/app/2fa', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
      const pending = await redis.get(`mfa-setup:${req.user!.id}`);
      if (!pending) return reply.redirect('/app/2fa');
      const secret = decrypt(pending);
      const step = verifyTotp(secret, String((req.body as any)?.code ?? ''), 0);
      if (step === null) {
        await redis.expire(`mfa-setup:${req.user!.id}`, 600);
        return reply.redirect('/app/settings?m=bad_code');
      }
      await q('UPDATE users SET totp_secret_enc = $2, totp_enabled_at = now(), totp_last_step = $3 WHERE id = $1', [req.user!.id, encrypt(secret), step]);
      await redis.del(`mfa-setup:${req.user!.id}`);
      req.log.info({ event: 'mfa_enabled', user: req.user!.id }, 'security');
      return reply.redirect('/app/settings?m=mfa_on');
    });

    r.post('/app/2fa/disable', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
      if (req.user!.isAdmin) return reply.redirect('/app/settings?m=mfa_required');
      const u = await one('SELECT totp_secret_enc, totp_last_step FROM users WHERE id = $1', [req.user!.id]);
      const step = u?.totp_secret_enc ? verifyTotp(decrypt(u.totp_secret_enc), String((req.body as any)?.code ?? ''), Number(u.totp_last_step)) : null;
      if (step === null) return reply.redirect('/app/settings?m=bad_code');
      await q('UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL WHERE id = $1', [req.user!.id]);
      req.log.info({ event: 'mfa_disabled', user: req.user!.id }, 'security');
      return reply.redirect('/app/settings?m=mfa_off');
    });

    // ---------- Alert channels ----------
    // WhatsApp: the owner sends a one-time code to the platform number (proves ownership, opens the chat).
    r.post('/app/notifications/whatsapp', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
      if (!config.waAlertsEnabled) return reply.redirect('/app/settings');
      const code = randomToken(6).replace(/[^A-Za-z0-9]/g, 'X').toUpperCase().slice(0, 8);
      await redis.set(`walink:${code}`, JSON.stringify({ workspaceId: req.user!.workspaceId, userId: req.user!.id }), 'EX', 900);
      return reply.redirect(`https://wa.me/${config.PLATFORM_WA_NUMBER}?text=${encodeURIComponent(`AIREPLY ${code}`)}`);
    });

    r.post('/app/notifications/push', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
      const p = subscriptionSchema.safeParse(req.body);
      if (!config.pushEnabled || !p.success) return reply.code(400).send({ ok: false });
      const ua = String(req.headers['user-agent'] ?? '');
      const label = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Brauzer';
      await q(
        `INSERT INTO notify_targets (workspace_id, user_id, kind, chat_id, label, data_enc) VALUES ($1, $2, 'webpush', $3, $4, $5)
         ON CONFLICT (workspace_id, kind, chat_id) DO UPDATE SET data_enc = EXCLUDED.data_enc`,
        [req.user!.workspaceId, req.user!.id, sha256(p.data.endpoint).toString('hex'), label, encrypt(JSON.stringify(p.data))],
      );
      return reply.send({ ok: true });
    });

    // Telegram linking: one-time code (hash in Redis, 15 min) passed via the bot's /start deep link.
    r.post('/app/notifications/telegram', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
      if (!telegramEnabled()) return reply.redirect('/app/settings');
      const code = randomToken(18);
      await redis.set(`tglink:${sha256(code).toString('hex')}`, JSON.stringify({ workspaceId: req.user!.workspaceId, userId: req.user!.id }), 'EX', 900);
      return reply.redirect(`https://t.me/${config.TELEGRAM_BOT_USERNAME}?start=${code}`);
    });
    r.post('/app/notifications/telegram/remove', async (req, reply) => {
      await q(`DELETE FROM notify_targets WHERE workspace_id = $1`, [req.user!.workspaceId]);
      return reply.redirect('/app/settings?m=tg_removed');
    });

    r.post('/app/settings/password', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
      const p = z.object({ current: z.string().max(200), password: passwordSchema }).safeParse(req.body);
      if (!p.success) return reply.redirect('/app/settings?m=invalid');
      const u = await one('SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
      if (!(await verify(u.password_hash, p.data.current).catch(() => false))) return reply.redirect('/app/settings?m=bad_password');
      await q('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user!.id, await hash(p.data.password, ARGON)]);
      await q('DELETE FROM sessions WHERE user_id = $1', [req.user!.id]);
      return reply.redirect('/login?m=password_set');
    });

    r.get('/app/settings/export', async (req, reply) => {
      const w = req.user!.workspaceId;
      const data = {
        exported_at: new Date().toISOString(),
        user: { email: req.user!.email },
        workspace: await one('SELECT name, monthly_reply_limit, paid_until, created_at FROM workspaces WHERE id = $1', [w]),
        assistant: await one('SELECT business_name, knowledge, style_preset, style_guide, handoff_message, enabled, ai_disclosure FROM assistants WHERE workspace_id = $1', [w]),
        channels: await q('SELECT type, external_id, display_name, status, created_at FROM channels WHERE workspace_id = $1', [w]),
        conversations: await q(
          `SELECT c.id, c.display_name, c.external_user_id, coalesce(json_agg(json_build_object('sender', m.sender, 'body', m.body, 'at', m.created_at) ORDER BY m.created_at) FILTER (WHERE m.id IS NOT NULL), '[]') AS messages
           FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id WHERE c.workspace_id = $1 GROUP BY c.id`,
          [w],
        ),
      };
      return reply.header('Content-Disposition', 'attachment; filename="ai-reply-export.json"').type('application/json').send(JSON.stringify(data, null, 2));
    });

    r.post('/app/settings/delete', { preHandler: requireOwner, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
      const pw = String((req.body as any)?.password ?? '').slice(0, 200);
      const u = await one('SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
      if (!(await verify(u.password_hash, pw).catch(() => false))) return reply.redirect('/app/settings?m=bad_password');
      for (const ch of await q<ChannelRow>('SELECT * FROM channels WHERE workspace_id = $1', [req.user!.workspaceId])) await removeChannel(ch);
      await destroySession(req, reply);
      await tx(async (c) => {
        await c.query('DELETE FROM workspaces WHERE id = $1', [req.user!.workspaceId]);
        await c.query('DELETE FROM users WHERE id = $1', [req.user!.id]);
      });
      return reply.redirect('/login?m=account_deleted');
    });
  });
}
