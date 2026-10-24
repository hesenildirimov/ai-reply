import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { generateReply } from '../ai.js';
import { removeChannel } from '../channels/index.js';
import { exchangeInstagramCode, instagramAuthorizeUrl, subscribeInstagram } from '../channels/instagram.js';
import type { ChannelRow } from '../channels/types.js';
import { completeEmbeddedSignup } from '../channels/whatsapp.js';
import { config } from '../config.js';
import { encrypt, randomToken, sha256 } from '../crypto.js';
import { one, q, tx } from '../db.js';
import { reserveReply, sendManualReply, WINDOW_MS } from '../pipeline.js';
import { destroySession, requireOwner, requireUser } from './auth.js';
import { csrfField, html, pageHead, raw, type Safe } from './html.js';
import { channelIcon, icon, type IconName } from './icons.js';
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

/** A platform account can belong to one workspace only; moving it drops the old workspace's data. */
async function claimExternalAccount(type: 'whatsapp' | 'instagram', externalId: string, workspaceId: string) {
  const others = await q<ChannelRow>('SELECT * FROM channels WHERE type = $1 AND external_id = $2 AND workspace_id <> $3', [type, externalId, workspaceId]);
  for (const ch of others) await q('DELETE FROM channels WHERE id = $1', [ch.id]);
}

const CONV_LIST_SQL = `SELECT c.id, c.display_name, c.external_user_id, c.needs_human, coalesce(c.ai_paused_until > now(), false) AS paused, c.last_message_at, ch.type,
    (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last,
    (SELECT sender FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_sender
  FROM conversations c JOIN channels ch ON ch.id = c.channel_id WHERE c.workspace_id = $1`;

const convRow = (c: any, activeId?: string) => html`<a class="conv ${c.id === activeId ? 'on' : ''} ${c.needs_human ? 'attn' : ''}" href="/app/inbox/${c.id}">
  ${avatar(c.display_name || c.external_user_id, c.type)}
  <span class="conv-main"><span class="conv-top"><b>${c.display_name || c.external_user_id}</b><time>${when(c.last_message_at)}</time></span>
  <span class="conv-last">${c.last_sender === 'ai' ? html`${icon('bot', 'i xs')} ` : c.last_sender === 'human' ? 'Siz: ' : ''}${String(c.last ?? '').slice(0, 90)}</span>
  ${c.needs_human ? chip('warn', 'Operator gözləyir') : c.paused ? chip('neutral', 'AI dayandırılıb') : ''}</span></a>`;

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
        q(`${CONV_LIST_SQL} ORDER BY c.needs_human DESC, c.last_message_at DESC LIMIT 5`, [w]),
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
                <li>${icon('headset')}<span><b>Bilmədiyini sizə ötürür</b><small>Endirim, şikayət, sifariş təsdiqi və ya "operator" yazanda söhbət "Operator gözləyir" olur.</small></span></li>
                <li>${icon('chat')}<span><b>Siz "Söhbətlər"dən cavab verirsiniz</b><small>Bütün yazışmalar orada görünür. Əl ilə yazdıqda AI həmin söhbətdə dayanır.</small></span></li>
              </ol></section>
          </div>
        </div>`);
    });

    // ---------- Inbox (two-pane) ----------
    const inbox = async (req: FastifyRequest, activeId?: string) => {
      const w = req.user!.workspaceId;
      const onlyHuman = (req.query as any)?.f === 'human';
      const convs = await q(`${CONV_LIST_SQL} ${onlyHuman ? 'AND c.needs_human' : ''} ORDER BY c.last_message_at DESC LIMIT 200`, [w]);
      const waiting = (await one(`SELECT count(*)::int AS n FROM conversations WHERE workspace_id = $1 AND needs_human`, [w])).n;
      let pane: Safe;
      const c = activeId
        ? await one(
            `SELECT c.*, coalesce(c.ai_paused_until > now(), false) AS paused, ch.type FROM conversations c JOIN channels ch ON ch.id = c.channel_id WHERE c.id = $1 AND c.workspace_id = $2`,
            [activeId, w],
          )
        : undefined;
      if (activeId && !c) return null;
      if (!c) {
        pane = html`<div class="empty pane-empty">${icon('chat', 'i lg')}<h2>Söhbət seçin</h2><p>Soldakı siyahıdan bir söhbət seçin. Müştərinin yazdıqlarını, AI-nin cavablarını görəcək və özünüz cavab yaza biləcəksiniz.</p></div>`;
      } else {
        const msgs = await q(`SELECT * FROM (SELECT sender, body, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 200) t ORDER BY created_at`, [c.id]);
        const open = !!c.last_inbound_at && Date.now() - new Date(c.last_inbound_at).getTime() < WINDOW_MS;
        const name = c.display_name || c.external_user_id;
        const aiOn = !c.needs_human && !c.paused;
        const toggle = (label: string, ic: IconName) => confirmForm(`/app/inbox/${c.id}/ai`, req.csrfToken, html`${icon(ic)}${label}`, 'btn sm secondary', undefined, html`<input type="hidden" name="action" value="${aiOn ? 'pause' : 'resume'}">`);
        const banner = c.needs_human
          ? html`<div class="banner warn">${icon('headset')}<span><b>Müştəri operator gözləyir.</b> AI bu söhbətdə dayanıb, cavabı siz yazın.</span>${toggle('AI-ni bərpa et', 'play')}</div>`
          : c.paused
            ? html`<div class="banner neutral">${icon('pause')}<span>AI bu söhbətdə dayandırılıb (${fmt(c.ai_paused_until)} tarixinə qədər).</span>${toggle('AI-ni bərpa et', 'play')}</div>`
            : html`<div class="banner ok">${icon('bot')}<span>AI bu söhbətə avtomatik cavab verir.</span>${toggle('Dayandır', 'pause')}</div>`;
        pane = html`<div class="thread-head"><a class="icon-btn back" href="/app/inbox" aria-label="Geri">${icon('back')}</a>${avatar(name, c.type)}
            <div><b>${name}</b><small>${typeLabel(c.type)}</small></div>
            ${confirmForm(`/app/inbox/${c.id}/delete`, req.csrfToken, icon('trash'), 'icon-btn', 'Söhbət həmişəlik silinsin?')}</div>
          ${banner}
          <div class="thread" id="thread">${msgs.map((m) => html`<div class="msg ${m.sender}"><div class="bubble">${m.body}</div>
            <small>${m.sender === 'ai' ? html`${icon('bot', 'i xs')} AI · ` : m.sender === 'human' ? 'Siz · ' : ''}${fmt(m.created_at)}</small></div>`)}</div>
          ${open
            ? html`<form class="composer" method="post" action="/app/inbox/${c.id}/reply">${csrfField(req.csrfToken)}
                <textarea name="text" rows="2" maxlength="${c.type === 'whatsapp' ? 4096 : 1000}" required placeholder="Cavab yazın… (göndərəndə AI bu söhbətdə 12 saat dayanır)"></textarea>
                <button class="btn" aria-label="Göndər">${icon('send')}</button></form>`
            : html`<div class="composer closed">${icon('lock')}<span>24 saatlıq cavab müddəti bitib (Meta qaydası). Müştəri yenidən yazanda cavab verə biləcəksiniz.</span></div>`}
          ${c.type === 'instagram' ? html`<p class="hint">Instagram tətbiqindən də cavab verə bilərsiniz, onda da AI avtomatik dayanır.</p>` : ''}`;
      }
      return html`<div class="inbox ${c ? 'has-active' : ''}" data-autorefresh="30">
        <aside class="inbox-list">
          <div class="inbox-head"><h1>Söhbətlər</h1>
            <div class="seg"><a href="/app/inbox" class="${onlyHuman ? '' : 'on'}">Hamısı</a><a href="/app/inbox?f=human" class="${onlyHuman ? 'on' : ''}">Operator gözləyir${waiting ? html` <span class="count">${waiting}</span>` : ''}</a></div></div>
          ${convs.length ? html`<div class="conv-list">${convs.map((x) => convRow(x, c?.id))}</div>` : html`<div class="empty">${icon('inbox', 'i lg')}<p>${onlyHuman ? 'Operator gözləyən söhbət yoxdur.' : 'Hələ söhbət yoxdur.'}</p></div>`}
        </aside>
        <section class="pane">${pane}</section></div>`;
    };

    r.get('/app/inbox', async (req, reply) => view(req, reply, 'Söhbətlər', (await inbox(req))!, undefined, true));
    r.get('/app/inbox/:id', async (req, reply) => {
      const id = idParam(req);
      const body = id ? await inbox(req, id) : null;
      if (!body) return reply.code(404).send('Not found');
      return view(req, reply, 'Söhbət', body, undefined, true);
    });

    r.post('/app/inbox/:id/reply', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
      const id = idParam(req);
      const text = z.string().trim().min(1).max(4096).safeParse((req.body as any)?.text).data;
      if (!id || !text) return reply.redirect(`/app/inbox?m=invalid`);
      try {
        const res = await sendManualReply(req.user!.workspaceId, id, text);
        if (res === 'not_found') return reply.code(404).send('Not found');
        if (res === 'sent') await q('UPDATE conversations SET needs_human = false WHERE id = $1', [id]);
        return reply.redirect(`/app/inbox/${id}?m=${res === 'sent' ? 'sent' : 'window_closed'}`);
      } catch (e) {
        req.log.warn({ err: e }, 'manual send failed');
        return reply.redirect(`/app/inbox/${id}?m=send_failed`);
      }
    });

    r.post('/app/inbox/:id/ai', async (req, reply) => {
      const id = idParam(req);
      if (!id) return reply.code(404).send('Not found');
      const resume = (req.body as any)?.action === 'resume';
      await q(
        resume
          ? 'UPDATE conversations SET needs_human = false, ai_paused_until = NULL WHERE id = $1 AND workspace_id = $2'
          : `UPDATE conversations SET ai_paused_until = now() + interval '30 days' WHERE id = $1 AND workspace_id = $2`,
        [id, req.user!.workspaceId],
      );
      return reply.redirect(`/app/inbox/${id}?m=saved`);
    });

    r.post('/app/inbox/:id/delete', async (req, reply) => {
      const id = idParam(req);
      if (id) await q('DELETE FROM conversations WHERE id = $1 AND workspace_id = $2', [id, req.user!.workspaceId]);
      return reply.redirect('/app/inbox?m=saved');
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
          <section class="card"><div class="card-head"><h2>${icon('sparkle')}Danışıq tərzi</h2></div>
            <label>Ton<input name="tone" value="${a.tone}" maxlength="300"></label>
            <label class="switch-row"><span><b>AI olduğunu bildir</b><small>İlk cavabda qısaca qeyd edir (tövsiyə olunur).</small></span>
              <input type="checkbox" class="switch" name="ai_disclosure" value="1" ${a.ai_disclosure ? raw('checked') : ''}></label></section>
          <section class="card"><div class="card-head"><h2>${icon('headset')}Operatora ötürmə</h2></div>
            <label>Müştəriyə göndəriləcək mesaj<input name="handoff_message" value="${a.handoff_message}" maxlength="500"></label>
            <small class="help">AI cavab verə bilməyəndə və ya müştəri "operator" yazanda göndərilir.</small></section>
          <div class="span form-actions"><a class="btn secondary" href="/app/test">${icon('flask')}Test et</a><button class="btn">Yadda saxla</button></div>
        </form>`);
    });

    r.post('/app/assistant', async (req, reply) => {
      const p = z
        .object({
          business_name: z.string().trim().min(1).max(120),
          knowledge: z.string().max(30000),
          tone: z.string().trim().max(300),
          handoff_message: z.string().trim().max(500),
          enabled: z.literal('1').optional(),
          ai_disclosure: z.literal('1').optional(),
        })
        .safeParse(req.body);
      if (!p.success) return reply.redirect('/app/assistant?m=invalid');
      const d = p.data;
      await q(
        `UPDATE assistants SET business_name = $2, knowledge = $3, tone = $4, handoff_message = $5, enabled = $6, ai_disclosure = $7, updated_at = now() WHERE workspace_id = $1`,
        [req.user!.workspaceId, d.business_name, d.knowledge, d.tone, d.handoff_message, !!d.enabled, !!d.ai_disclosure],
      );
      return reply.redirect('/app/assistant?m=saved');
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
      const res = await generateReply(a, [{ role: 'user', text: msg }], a.ai_disclosure);
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
          `INSERT INTO channels (workspace_id, type, external_id, display_name, access_token_enc, token_expires_at) VALUES ($1, 'instagram', $2, $3, $4, $5)
           ON CONFLICT (type, external_id) DO UPDATE SET display_name = EXCLUDED.display_name, access_token_enc = EXCLUDED.access_token_enc,
             token_expires_at = EXCLUDED.token_expires_at, status = 'active'`,
          [req.user!.workspaceId, ig.igId, `@${ig.username}`, encrypt(ig.token), ig.expiresAt],
        );
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
             access_token_enc = EXCLUDED.access_token_enc, extra_enc = coalesce(EXCLUDED.extra_enc, channels.extra_enc), status = 'active'`,
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
    r.get('/app/settings', (req, reply) =>
      view(req, reply, 'Ayarlar', html`${pageHead('Ayarlar', html`Hesab: <b>${req.user!.email}</b>`)}
        <div class="form-grid">
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
          </section></div>`),
    );

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
        assistant: await one('SELECT business_name, knowledge, tone, handoff_message, enabled, ai_disclosure FROM assistants WHERE workspace_id = $1', [w]),
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
