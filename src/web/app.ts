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
import { csrfField, html, raw } from './html.js';
import { ARGON, MESSAGES, passwordSchema, view } from './public.js';

Object.assign(MESSAGES, {
  saved: { type: 'ok', text: 'Yadda saxlanıldı.' },
  ig_connected: { type: 'ok', text: 'Instagram hesabı bağlandı.' },
  wa_connected: { type: 'ok', text: 'WhatsApp nömrəsi bağlandı.' },
  disconnected: { type: 'ok', text: 'Kanal ayrıldı və onun bütün məlumatları silindi.' },
  connect_failed: { type: 'error', text: 'Bağlantı alınmadı. Yenidən cəhd edin.' },
  window_closed: { type: 'error', text: 'Müştərinin son mesajından 24 saat keçib — Meta qaydalarına görə indi cavab göndərmək olmur.' },
  sent: { type: 'ok', text: 'Göndərildi. AI bu söhbətdə 12 saat dayandırıldı.' },
  send_failed: { type: 'error', text: 'Göndərmək alınmadı.' },
  limit: { type: 'error', text: 'Aylıq AI cavab limitiniz bitib.' },
  expired: { type: 'error', text: 'Abunəliyin müddəti bitib. AI cavablar dayandırılıb — administratorla əlaqə saxlayın.' },
  pw_changed: { type: 'ok', text: 'Şifrə dəyişdirildi.' },
  bad_password: { type: 'error', text: 'Şifrə yanlışdır.' },
});

const uuid = z.uuid();
const idParam = (req: FastifyRequest) => uuid.safeParse((req.params as any).id).data;
const fmt = (d: Date | string | null) => (d ? new Date(d).toLocaleString('az-AZ', { timeZone: 'Asia/Baku' }) : '—');
const typeLabel = (t: string) => (t === 'whatsapp' ? 'WhatsApp' : 'Instagram');

/** A platform account can belong to one workspace only; moving it drops the old workspace's data. */
async function claimExternalAccount(type: 'whatsapp' | 'instagram', externalId: string, workspaceId: string) {
  const others = await q<ChannelRow>('SELECT * FROM channels WHERE type = $1 AND external_id = $2 AND workspace_id <> $3', [type, externalId, workspaceId]);
  for (const ch of others) await q('DELETE FROM channels WHERE id = $1', [ch.id]);
}

export function appRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    r.get('/app', async (req, reply) => {
      const w = req.user!.workspaceId;
      const [ws, a, chans, usage] = await Promise.all([
        one('SELECT name, monthly_reply_limit, paid_until, coalesce(paid_until < current_date, false) AS expired FROM workspaces WHERE id = $1', [w]),
        one('SELECT enabled, knowledge FROM assistants WHERE workspace_id = $1', [w]),
        q<ChannelRow>('SELECT type, display_name, status FROM channels WHERE workspace_id = $1', [w]),
        one(`SELECT ai_replies FROM usage_counters WHERE workspace_id = $1 AND period = to_char(now(), 'YYYY-MM')`, [w]),
      ]);
      const step = (done: boolean, text: string, href: string) => html`<li class="${done ? 'done' : ''}"><a href="${href}">${text}</a></li>`;
      return view(req, reply, 'Panel', html`${ws.expired ? html`<p class="flash error">${MESSAGES.expired!.text}</p>` : ''}<section class="card"><h1>${ws.name}</h1>
        <ol class="steps">${step(a.knowledge.length > 50, 'Biznes məlumatlarını doldurun', '/app/assistant')}
          ${step(chans.length > 0, 'Instagram və ya WhatsApp bağlayın', '/app/channels')}
          ${step(a.enabled, 'AI cavabları aktiv edin', '/app/assistant')}</ol>
        <p>AI: <b>${a.enabled ? 'Aktiv' : 'Deaktiv'}</b> · Bu ay AI cavabları: <b>${usage?.ai_replies ?? 0} / ${ws.monthly_reply_limit}</b>${ws.paid_until ? html` · Ödənilib: <b>${new Date(ws.paid_until).toISOString().slice(0, 10)}</b> tarixinə qədər` : ''}</p>
        <p>Kanallar: ${chans.length ? chans.map((c) => html`<span class="tag ${c.status}">${typeLabel(c.type)}: ${c.display_name}</span> `) : 'yoxdur'}</p></section>`);
    });

    // ---------- Assistant ----------
    r.get('/app/assistant', async (req, reply) => {
      const a = await one('SELECT * FROM assistants WHERE workspace_id = $1', [req.user!.workspaceId]);
      return view(req, reply, 'AI köməkçi', html`<section class="card"><h1>AI köməkçi</h1>
        <form method="post" action="/app/assistant">${csrfField(req.csrfToken)}
          <label class="row"><input type="checkbox" name="enabled" value="1" ${a.enabled ? raw('checked') : ''}> <b>AI avtomatik cavabları aktivdir</b></label>
          <label>Biznesin adı<input name="business_name" value="${a.business_name}" maxlength="120" required></label>
          <label>Biznes haqqında məlumat (AI yalnız bunu istifadə edir)
            <textarea name="knowledge" rows="16" maxlength="30000" placeholder="Nə satırsınız, qiymətlər, iş saatları, ünvan, çatdırılma, ödəniş üsulları, qaytarma qaydaları, tez-tez verilən suallar...">${a.knowledge}</textarea></label>
          <label>Danışıq tonu<input name="tone" value="${a.tone}" maxlength="300"></label>
          <label>Operatora ötürmə mesajı<input name="handoff_message" value="${a.handoff_message}" maxlength="500"></label>
          <label class="row"><input type="checkbox" name="ai_disclosure" value="1" ${a.ai_disclosure ? raw('checked') : ''}> İlk cavabda AI köməkçi olduğunu bildir (tövsiyə olunur)</label>
          <button>Yadda saxla</button></form></section>`);
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
    const testPage = (req: FastifyRequest, msg = '', answer: ReturnType<typeof html> | '' = '') => html`<section class="card"><h1>AI-ni yoxla</h1>
      <p>Müştəri kimi yazın və AI-nin necə cavab verdiyinə baxın. Kanal bağlamaq lazım deyil.</p>
      <form method="post" action="/app/test">${csrfField(req.csrfToken)}<label>Müştərinin mesajı<textarea name="message" rows="3" maxlength="1000" required>${msg}</textarea></label><button>Göndər</button></form>
      ${answer}</section>`;
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
          ? html`<div class="bubble ai">${res.text}</div>`
          : html`<div class="bubble ai">${a.handoff_message}</div><p class="muted">→ Operatora ötürüldü (səbəb: ${res.reason})</p>`;
      return view(req, reply, 'Test', testPage(req, msg, answer));
    });

    // ---------- Channels ----------
    r.get('/app/channels', async (req, reply) => {
      const chans = await q<ChannelRow>('SELECT * FROM channels WHERE workspace_id = $1 ORDER BY created_at', [req.user!.workspaceId]);
      const owner = req.user!.role === 'owner';
      const head = config.whatsappEnabled
        ? html`<script src="/public/wa-signup.js" defer></script><script async defer crossorigin="anonymous" src="https://connect.facebook.net/en_US/sdk.js"></script>`
        : undefined;
      return view(req, reply, 'Kanallar', html`<section class="card"><h1>Kanallar</h1>
        <table><tr><th>Kanal</th><th>Hesab</th><th>Status</th><th></th></tr>
        ${chans.map((c) => html`<tr><td>${typeLabel(c.type)}</td><td>${c.display_name}</td>
          <td><span class="tag ${c.status}">${c.status === 'active' ? 'Aktiv' : 'Xəta — yenidən bağlayın'}</span></td>
          <td>${owner ? html`<form method="post" action="/app/channels/${c.id}/disconnect" class="inline" data-confirm="Kanal ayrılsın və bütün söhbətləri silinsin?">${csrfField(req.csrfToken)}<button class="danger">Ayır</button></form>` : ''}</td></tr>`)}
        </table>
        ${owner ? html`<div class="connect">
          ${config.instagramEnabled ? html`<a class="btn" href="/app/channels/instagram/connect">Instagram bağla</a>` : html`<span class="muted">Instagram: IG_APP_ID / IG_APP_SECRET təyin edilməyib</span>`}
          ${config.whatsappEnabled
            ? html`<button id="wa-connect" data-app-id="${config.META_APP_ID}" data-config-id="${config.WA_EMBEDDED_SIGNUP_CONFIG_ID}" data-version="${config.META_GRAPH_VERSION}" data-csrf="${req.csrfToken}">WhatsApp bağla</button>`
            : html`<span class="muted">WhatsApp: META_APP_ID / META_APP_SECRET / WA_EMBEDDED_SIGNUP_CONFIG_ID təyin edilməyib</span>`}
          </div><p class="muted">Instagram hesabı Business və ya Creator olmalıdır. Biz yalnız mesajları oxumaq və cavab göndərmək icazəsi istəyirik.</p>` : ''}
        <p class="muted" id="wa-status"></p></section>`, head);
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

    // ---------- Inbox ----------
    r.get('/app/inbox', async (req, reply) => {
      const convs = await q(
        `SELECT c.id, c.display_name, c.external_user_id, c.needs_human, c.ai_paused_until > now() AS paused, c.last_message_at, ch.type,
           (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last
         FROM conversations c JOIN channels ch ON ch.id = c.channel_id WHERE c.workspace_id = $1 ORDER BY c.last_message_at DESC LIMIT 100`,
        [req.user!.workspaceId],
      );
      return view(req, reply, 'Söhbətlər', html`<section class="card"><h1>Söhbətlər</h1>
        ${convs.length ? html`<table>${convs.map((c) => html`<tr class="${c.needs_human ? 'attention' : ''}"><td>${typeLabel(c.type)}</td>
          <td><a href="/app/inbox/${c.id}">${c.display_name || c.external_user_id}</a>${c.needs_human ? html` <span class="tag error">Operator lazımdır</span>` : ''}${c.paused ? html` <span class="tag">AI dayandırılıb</span>` : ''}</td>
          <td class="muted">${String(c.last ?? '').slice(0, 80)}</td><td class="muted">${fmt(c.last_message_at)}</td></tr>`)}</table>` : html`<p class="muted">Hələ söhbət yoxdur.</p>`}</section>`);
    });

    r.get('/app/inbox/:id', async (req, reply) => {
      const id = idParam(req);
      const c = id && (await one(
        `SELECT c.*, c.ai_paused_until > now() AS paused, ch.type FROM conversations c JOIN channels ch ON ch.id = c.channel_id WHERE c.id = $1 AND c.workspace_id = $2`,
        [id, req.user!.workspaceId],
      ));
      if (!c) return reply.code(404).send('Not found');
      const msgs = await q(`SELECT * FROM (SELECT sender, body, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 200) t ORDER BY created_at`, [c.id]);
      const open = !!c.last_inbound_at && Date.now() - new Date(c.last_inbound_at).getTime() < WINDOW_MS;
      const aiOn = !c.needs_human && !c.paused;
      return view(req, reply, 'Söhbət', html`<section class="card"><h1>${c.display_name || c.external_user_id} <small class="muted">${typeLabel(c.type)}</small></h1>
        <div class="thread">${msgs.map((m) => html`<div class="bubble ${m.sender}"><small>${m.sender === 'customer' ? 'Müştəri' : m.sender === 'ai' ? 'AI' : 'Əməkdaş'} · ${fmt(m.created_at)}</small>${m.body}</div>`)}</div>
        ${open
          ? html`<form method="post" action="/app/inbox/${c.id}/reply">${csrfField(req.csrfToken)}<textarea name="text" rows="3" maxlength="${c.type === 'whatsapp' ? 4096 : 1000}" required></textarea><button>Əməkdaş kimi göndər</button></form>`
          : html`<p class="muted">24 saatlıq cavab pəncərəsi bağlıdır. Müştəri yenidən yazanda cavab verə bilərsiniz.</p>`}
        <div class="actions">
          <form method="post" action="/app/inbox/${c.id}/ai" class="inline">${csrfField(req.csrfToken)}<input type="hidden" name="action" value="${aiOn ? 'pause' : 'resume'}"><button>${aiOn ? 'AI-ni bu söhbətdə dayandır' : 'AI-ni bu söhbətdə bərpa et'}</button></form>
          <form method="post" action="/app/inbox/${c.id}/delete" class="inline" data-confirm="Söhbət həmişəlik silinsin?">${csrfField(req.csrfToken)}<button class="danger">Söhbəti sil</button></form>
        </div></section>`);
    });

    r.post('/app/inbox/:id/reply', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
      const id = idParam(req);
      const text = z.string().trim().min(1).max(4096).safeParse((req.body as any)?.text).data;
      if (!id || !text) return reply.redirect(`/app/inbox?m=invalid`);
      try {
        const res = await sendManualReply(req.user!.workspaceId, id, text);
        if (res === 'not_found') return reply.code(404).send('Not found');
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

    // ---------- Settings ----------
    r.get('/app/settings', (req, reply) =>
      view(req, reply, 'Ayarlar', html`<section class="card"><h1>Ayarlar</h1><p>Hesab: <b>${req.user!.email}</b></p>
        <h2>Şifrəni dəyiş</h2>
        <form method="post" action="/app/settings/password">${csrfField(req.csrfToken)}
          <label>Hazırkı şifrə<input name="current" type="password" required autocomplete="current-password"></label>
          <label>Yeni şifrə (min. 10)<input name="password" type="password" required minlength="10" maxlength="200" autocomplete="new-password"></label><button>Dəyiş</button></form>
        <h2>Məlumatlarım</h2><p><a href="/app/settings/export">Bütün məlumatları yüklə (JSON)</a></p>
        ${req.user!.role === 'owner' ? html`<h2>Hesabı sil</h2><p class="muted">Bütün kanallar, söhbətlər və hesab həmişəlik silinəcək.</p>
        <form method="post" action="/app/settings/delete" data-confirm="Hesab və bütün məlumatlar həmişəlik silinsin?">${csrfField(req.csrfToken)}
          <label>Şifrə<input name="password" type="password" required autocomplete="current-password"></label><button class="danger">Hesabı sil</button></form>` : ''}
        </section>`),
    );

    r.post('/app/settings/password', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
      const p = z.object({ current: z.string().max(200), password: passwordSchema }).safeParse(req.body);
      if (!p.success) return reply.redirect('/app/settings?m=invalid');
      const u = await one('SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
      if (!(await verify(u.password_hash, p.data.current))) return reply.redirect('/app/settings?m=bad_password');
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
      if (!(await verify(u.password_hash, pw))) return reply.redirect('/app/settings?m=bad_password');
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
