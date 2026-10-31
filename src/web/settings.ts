import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { subscriptionOf } from '../billing.js';
import { removeChannel } from '../channels/index.js';
import type { ChannelRow } from '../channels/types.js';
import { config } from '../config.js';
import { decrypt, encryptSecret, randomToken, sha256 } from '../crypto.js';
import { one, q, tx } from '../db.js';
import { audit } from '../events.js';
import { openRows } from '../messages.js';
import { LIMIT_KEYS, LIMIT_LABELS, limitsOf, usageOf } from '../plans.js';
import { redis } from '../queue.js';
import { telegramEnabled } from '../telegram.js';
import { createTelegramLinkCode } from '../telegram-updates.js';
import { newTotpSecret, otpauthUrl, verifyTotp } from '../totp.js';
import { subscriptionSchema } from '../webpush.js';
import { can, destroySession, endOtherSessions, requireOwner, requirePerm, requireUser } from './auth.js';
import { csrfField, html, pageHead, raw, type Safe } from './html.js';
import { type IconName, icon } from './icons.js';
import { ARGON, MESSAGES, passwordSchema, view } from './public.js';
import { chip, day, postForm } from './ui.js';

Object.assign(MESSAGES, {
  bad_password: { type: 'error', text: 'Şifrə yanlışdır.' },
  tg_removed: { type: 'ok', text: 'Bildiriş kanalı ayrıldı.' },
  mfa_required: { type: 'error', text: 'Admin paneli üçün iki faktorlu girişi qurmalısınız.' },
  mfa_on: { type: 'ok', text: 'İki faktorlu giriş aktivdir.' },
  mfa_off: { type: 'ok', text: 'İki faktorlu giriş söndürüldü.' },
  push_on: { type: 'ok', text: 'Bu brauzerdə bildirişlər aktivdir.' },
});

const notifyRow = (csrf: string, ic: IconName, title: string, sub: string, enabled: boolean, n: number, action: string, label: string) =>
  html`<div class="notify-row"><span class="nt-ic">${icon(ic)}</span><div><b>${title}</b><small>${sub}</small></div>
    ${enabled ? html`${n ? chip('ok', 'qoşulub') : ''}<form method="post" action="${action}" class="inline">${csrfField(csrf)}<button class="btn sm ${n ? 'secondary' : ''}">${n ? 'Daha birini qoş' : label}</button></form>` : html`<span class="chip neutral">qurulmayıb</span>`}</div>`;

/** Every conversation with its messages, decrypted (the owner's own data export). */
async function exportConversations(workspaceId: string) {
  const convs = await q(`SELECT id, display_name, external_user_id FROM conversations WHERE workspace_id = $1 ORDER BY id`, [workspaceId]);
  const msgs = openRows(
    await q(`SELECT conversation_id, sender, body, enc, created_at FROM messages WHERE workspace_id = $1 ORDER BY created_at`, [workspaceId]),
  );
  const byConv = new Map<string, { sender: string; body: string; at: Date }[]>();
  for (const m of msgs) {
    const list = byConv.get(m.conversation_id) ?? [];
    list.push({ sender: m.sender, body: m.body, at: m.created_at });
    byConv.set(m.conversation_id, list);
  }
  return convs.map((c) => ({ ...c, messages: byConv.get(c.id) ?? [] }));
}

const REAUTH_FAIL_MAX = 5;

/**
 * Re-authentication for security-sensitive settings (2FA on/off, password change, account deletion): a stolen session
 * cookie alone must not be enough (A-3). Wrong passwords are counted per user; after REAUTH_FAIL_MAX in 15 minutes all of
 * the user's sessions end, so a cookie thief can't keep guessing. On failure the redirect is already sent.
 */
async function reauth(req: FastifyRequest, reply: FastifyReply, pw: unknown): Promise<boolean> {
  const userId = req.user!.id;
  const u = await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (u && (await verify(u.password_hash, String(pw ?? '').slice(0, 200)).catch(() => false))) {
    await redis.del(`reauthfail:${userId}`);
    return true;
  }
  const [[, fails]] = (await redis.multi().incr(`reauthfail:${userId}`).expire(`reauthfail:${userId}`, 900).exec()) as [[null, number]];
  req.log.warn({ event: 'reauth_failed', user: userId, fails }, 'security');
  if (fails >= REAUTH_FAIL_MAX) {
    await q('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await redis.del(`reauthfail:${userId}`);
    reply.redirect('/login?m=locked');
  } else reply.redirect('/app/settings?m=bad_password');
  return false;
}

/** Account settings: plan and limits, alert channels, two-factor login, password, data export, account deletion. */
export function settingsRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    // ---------- Settings ----------
    r.get('/app/settings', async (req, reply) => {
      const w0 = req.user!.workspaceId;
      const targets = await q<{ kind: string }>(`SELECT kind FROM notify_targets WHERE workspace_id = $1`, [w0]);
      const count = (k: string) => targets.filter((t) => t.kind === k).length;
      let planCard: Safe | '' = '';
      if (can(req.user, 'billing.view')) {
        const [sub, limits, usage] = await Promise.all([subscriptionOf(w0), limitsOf(w0), Promise.all(LIMIT_KEYS.map((k) => usageOf(w0, k)))]);
        const fmtN = (k: string, n: number) => (k.startsWith('ai_budget') ? `$${n.toFixed(2)}` : String(Math.round(n)));
        planCard = html`<section class="card span"><div class="card-head"><h2>${icon('chart')}Tarif və limitlər</h2>${chip('ok', sub?.planName ?? 'Fərdi')}</div>
          <p class="muted">${sub?.priceNote ?? ''}${sub?.paidUntil ? html` · ödənilib: <b>${day(sub.paidUntil)}</b>` : ''}. Limitlər serverdə yoxlanılır: dolanda avtomatik cavablar dayanır, siz isə əl ilə yazmağa davam edə bilirsiniz.</p>
          <div class="table-wrap"><table><tbody>${LIMIT_KEYS.map((k, i) => {
            const lim = limits[k];
            const used = usage[i]!;
            const pc = lim ? Math.min(100, Math.round((used / lim) * 100)) : 0;
            return html`<tr><td>${LIMIT_LABELS[k]}</td><td class="num right">${k === 'history_days' ? `${lim ?? '∞'} gün` : html`${fmtN(k, used)} / ${lim === null ? '∞' : fmtN(k, lim)}`}
              ${lim && k !== 'history_days' ? html`<div class="meter ${pc >= 100 ? 'danger' : pc >= 80 ? 'warn' : ''}"><i style="width:${pc}%"></i></div>` : ''}</td></tr>`;
          })}</tbody></table></div></section>`;
      }
      return view(
        req,
        reply,
        'Ayarlar',
        html`${pageHead('Ayarlar', html`Hesab: <b>${req.user!.email}</b>`)}
        <div class="form-grid">${planCard}
          <section class="card span"><div class="card-head"><h2>${icon('zap')}Bildirişlər</h2></div>
            <p class="muted">Müştəri sizin cavabınızı gözləyəndə (AI bilmədiyi sual, şikayət, sifariş təsdiqi) xəbər tutun. Bir neçə yolu birlikdə qoşa bilərsiniz.</p>
            <div class="notify-grid">
              ${notifyRow(req.csrfToken, 'whatsapp', 'WhatsApp', 'Şəxsi WhatsApp-ınıza mesaj', config.waAlertsEnabled, count('whatsapp'), '/app/notifications/whatsapp', 'WhatsApp-ı qoş')}
              ${notifyRow(req.csrfToken, 'send', 'Telegram', 'Telegram botundan mesaj', telegramEnabled(), count('telegram'), '/app/notifications/telegram', 'Telegram-ı qoş')}
              <div class="notify-row"><span class="nt-ic">${icon('globe')}</span><div><b>Chrome bildirişi</b><small>Kompüter və ya telefon brauzerində</small></div>
                ${
                  config.pushEnabled
                    ? html`${count('webpush') ? chip('ok', `${count('webpush')} cihaz`) : ''}<button type="button" class="btn sm" id="push-enable" data-key="${config.VAPID_PUBLIC_KEY}" data-csrf="${req.csrfToken}">Bu cihazda aç</button>`
                    : html`<span class="chip neutral">qurulmayıb</span>`
                }</div>
            </div>
            <p class="hint" id="push-status"></p>
            ${targets.length ? postForm('/app/notifications/telegram/remove', req.csrfToken, html`Bildiriş kanallarımı ayır`, 'btn sm danger-ghost', { confirm: 'Bütün bildiriş kanalları ayrılsın?' }) : ''}
            <p class="hint">${icon('inbox', 'i xs')} ${config.mailEnabled ? 'E-poçt bildirişləri də aktivdir.' : 'E-poçt bildirişi üçün SMTP qurulmalıdır.'}</p></section>
          <section class="card span"><div class="card-head"><h2>${icon('shield')}İki faktorlu giriş</h2>
              ${req.user!.mfa ? chip('ok', 'Aktiv') : chip('neutral', 'Söndürülüb')}</div>
            <p class="muted">Şifrədən əlavə telefonunuzdakı Google Authenticator (və ya Authy) kodu tələb olunur. ${req.user!.isAdmin ? 'Admin üçün məcburidir.' : 'Tövsiyə olunur.'}</p>
            ${
              req.user!.mfa
                ? req.user!.isAdmin
                  ? ''
                  : html`<form method="post" action="/app/2fa/disable" class="inline-form">${csrfField(req.csrfToken)}<input name="password" type="password" required autocomplete="current-password" placeholder="Cari şifrə"><input name="code" inputmode="numeric" maxlength="6" placeholder="6 rəqəmli kod" required><button class="btn sm danger-ghost">Söndür</button></form>`
                : html`<a class="btn" href="/app/2fa">${icon('shield')}Qur</a>`
            }</section>
          <section class="card"><div class="card-head"><h2>${icon('lock')}Şifrəni dəyiş</h2></div>
            <form method="post" action="/app/settings/password">${csrfField(req.csrfToken)}
              <label>Hazırkı şifrə<input name="current" type="password" required autocomplete="current-password"></label>
              <label>Yeni şifrə (min. 10 simvol)<input name="password" type="password" required minlength="10" maxlength="200" autocomplete="new-password"></label>
              <button class="btn">Dəyiş</button></form></section>
          <section class="card"><div class="card-head"><h2>${icon('download')}Məlumatlarım</h2></div>
            <p class="muted">Bütün ayarlarınızı və yazışmalarınızı JSON faylı kimi yükləyin.</p>${can(req.user, 'data.export') ? html`<a class="btn secondary" href="/app/settings/export">${icon('download')}Yüklə</a>` : html`<span class="muted">Yalnız hesab sahibi.</span>`}
            ${
              req.user!.role === 'owner'
                ? html`<div class="danger-zone"><h3>Hesabı sil</h3><p class="muted">Bütün kanallar, söhbətlər və hesab həmişəlik silinəcək.</p>
              <form method="post" action="/app/settings/delete" data-confirm="Hesab və bütün məlumatlar həmişəlik silinsin?">${csrfField(req.csrfToken)}
                <label>Təsdiq üçün şifrə<input name="password" type="password" required autocomplete="current-password"></label><button class="btn danger">${icon('trash')}Hesabı sil</button></form></div>`
                : ''
            }
          </section></div>`,
        config.pushEnabled ? html`<script src="/public/push.js" defer></script>` : undefined,
      );
    });

    // ---------- Two-factor login ----------
    r.get('/app/2fa', async (req, reply) => {
      if (req.user!.mfa) return reply.redirect('/app/settings?m=mfa_on');
      const secret = newTotpSecret();
      await redis.set(`mfa-setup:${req.user!.id}`, encryptSecret(secret), 'EX', 600);
      const qr = await QRCode.toString(otpauthUrl(req.user!.email, secret), { type: 'svg', margin: 1, width: 200 });
      return view(
        req,
        reply,
        'İki faktorlu giriş',
        html`${pageHead('İki faktorlu girişi qurun', 'Telefonunuzda Google Authenticator, Authy və ya 1Password açın.')}
        <section class="card mfa">
          <ol class="mfa-steps"><li>Tətbiqdə <b>+</b> basın və bu QR kodu skan edin:</li></ol>
          <div class="qr">${raw(qr)}</div>
          <p class="muted">Skan edə bilmirsinizsə, bu açarı əl ilə daxil edin: <code>${secret.replace(/(.{4})/g, '$1 ').trim()}</code></p>
          <ol class="mfa-steps" start="2"><li>Tətbiqin göstərdiyi 6 rəqəmli kodu yazın:</li></ol>
          <form method="post" action="/app/2fa" class="inline-form">${csrfField(req.csrfToken)}
            <input name="password" type="password" required autocomplete="current-password" placeholder="Cari şifrə"><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="123456"><button class="btn">Təsdiqlə və aktiv et</button></form>
        </section>`,
      );
    });

    r.post('/app/2fa', { config: { rateLimit: { max: 10, timeWindow: '1 minute', skipOnError: false } } }, async (req, reply) => {
      // Re-authentication: a stolen session cookie alone must not be able to register the attacker's authenticator (A-3).
      if (!(await reauth(req, reply, (req.body as any)?.password))) return reply;
      const pending = await redis.get(`mfa-setup:${req.user!.id}`);
      if (!pending) return reply.redirect('/app/2fa');
      const secret = decrypt(pending);
      const step = verifyTotp(secret, String((req.body as any)?.code ?? ''), 0);
      if (step === null) {
        await redis.expire(`mfa-setup:${req.user!.id}`, 600);
        return reply.redirect('/app/settings?m=bad_code');
      }
      await q('UPDATE users SET totp_secret_enc = $2, totp_enabled_at = now(), totp_last_step = $3 WHERE id = $1', [req.user!.id, encryptSecret(secret), step]);
      await redis.del(`mfa-setup:${req.user!.id}`);
      await endOtherSessions(req, req.user!.id); // a parallel session of an intruder ends here
      req.log.info({ event: 'mfa_enabled', user: req.user!.id }, 'security');
      return reply.redirect('/app/settings?m=mfa_on');
    });

    r.post('/app/2fa/disable', { config: { rateLimit: { max: 5, timeWindow: '1 minute', skipOnError: false } } }, async (req, reply) => {
      if (req.user!.isAdmin) return reply.redirect('/app/settings?m=mfa_required');
      if (!(await reauth(req, reply, (req.body as any)?.password))) return reply;
      const u = await one('SELECT totp_secret_enc, totp_last_step FROM users WHERE id = $1', [req.user!.id]);
      const step = u?.totp_secret_enc ? verifyTotp(decrypt(u.totp_secret_enc), String((req.body as any)?.code ?? ''), Number(u.totp_last_step)) : null;
      if (step === null) return reply.redirect('/app/settings?m=bad_code');
      await q('UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL WHERE id = $1', [req.user!.id]);
      req.log.info({ event: 'mfa_disabled', user: req.user!.id }, 'security');
      return reply.redirect('/app/settings?m=mfa_off');
    });

    // ---------- Alert channels ----------
    // WhatsApp: the owner sends a one-time code to the platform number (proves ownership, opens the chat).
    r.post('/app/notifications/whatsapp', { config: { rateLimit: { max: 10, timeWindow: '1 minute', skipOnError: false } } }, async (req, reply) => {
      if (!config.waAlertsEnabled) return reply.redirect('/app/settings');
      const code = randomToken(6)
        .replace(/[^A-Za-z0-9]/g, 'X')
        .toUpperCase()
        .slice(0, 8);
      await redis.set(`walink:${code}`, JSON.stringify({ workspaceId: req.user!.workspaceId, userId: req.user!.id }), 'EX', 900);
      return reply.redirect(`https://wa.me/${config.PLATFORM_WA_NUMBER}?text=${encodeURIComponent(`AIREPLY ${code}`)}`);
    });

    r.post('/app/notifications/push', { config: { rateLimit: { max: 10, timeWindow: '1 minute', skipOnError: false } } }, async (req, reply) => {
      const p = subscriptionSchema.safeParse(req.body);
      if (!config.pushEnabled || !p.success) return reply.code(400).send({ ok: false });
      const ua = String(req.headers['user-agent'] ?? '');
      const label = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Brauzer';
      await q(
        `INSERT INTO notify_targets (workspace_id, user_id, kind, chat_id, label, data_enc) VALUES ($1, $2, 'webpush', $3, $4, $5)
         ON CONFLICT (workspace_id, kind, chat_id) DO UPDATE SET data_enc = EXCLUDED.data_enc`,
        [req.user!.workspaceId, req.user!.id, sha256(p.data.endpoint).toString('hex'), label, encryptSecret(JSON.stringify(p.data))],
      );
      return reply.send({ ok: true });
    });

    // Telegram linking: one-time code (hash in Redis, 15 min) passed via the bot's /start deep link.
    r.post('/app/notifications/telegram', { config: { rateLimit: { max: 10, timeWindow: '1 minute', skipOnError: false } } }, async (req, reply) => {
      if (!telegramEnabled()) return reply.redirect('/app/settings');
      // Mock mode has no Telegram to open: the dashboard simulator performs the same /start step (src/commerce/simulator.ts).
      if (config.mockMode) return reply.redirect('/app/dev');
      const code = await createTelegramLinkCode(req.user!.workspaceId, req.user!.id);
      return reply.redirect(`https://t.me/${config.TELEGRAM_BOT_USERNAME}?start=${code}`);
    });
    r.post('/app/notifications/telegram/remove', async (req, reply) => {
      // Only the caller's own alert channels: one member must not be able to silence everybody else's alerts.
      await q(`DELETE FROM notify_targets WHERE workspace_id = $1 AND user_id = $2`, [req.user!.workspaceId, req.user!.id]);
      return reply.redirect('/app/settings?m=tg_removed');
    });

    r.post('/app/settings/password', { config: { rateLimit: { max: 5, timeWindow: '1 minute', skipOnError: false } } }, async (req, reply) => {
      const p = z.object({ current: z.string().max(200), password: passwordSchema }).safeParse(req.body);
      if (!p.success) return reply.redirect('/app/settings?m=invalid');
      if (!(await reauth(req, reply, p.data.current))) return reply;
      await q('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user!.id, await hash(p.data.password, ARGON)]);
      await q('DELETE FROM sessions WHERE user_id = $1', [req.user!.id]);
      return reply.redirect('/login?m=password_set');
    });

    r.get(
      '/app/settings/export',
      { preHandler: requirePerm('data.export'), config: { rateLimit: { max: 3, timeWindow: '1 hour', skipOnError: false } } },
      async (req, reply) => {
        const w = req.user!.workspaceId;
        await audit(w, req.user!.id, 'workspace.export', 'workspace', w);
        const data = {
          exported_at: new Date().toISOString(),
          user: { email: req.user!.email },
          workspace: await subscriptionOf(w).then(
            (s) => s && { name: s.name, monthly_reply_limit: s.replyLimit, paid_until: s.paidUntil, created_at: s.createdAt },
          ),
          assistant: await one(
            'SELECT business_name, knowledge, style_preset, style_guide, handoff_message, enabled, ai_disclosure FROM assistants WHERE workspace_id = $1',
            [w],
          ),
          channels: await q('SELECT type, external_id, display_name, status, created_at FROM channels WHERE workspace_id = $1', [w]),
          conversations: await exportConversations(w),
        };
        return reply
          .header('Content-Disposition', 'attachment; filename="ai-reply-export.json"')
          .type('application/json')
          .send(JSON.stringify(data, null, 2));
      },
    );

    r.post(
      '/app/settings/delete',
      { preHandler: requireOwner, config: { rateLimit: { max: 5, timeWindow: '1 minute', skipOnError: false } } },
      async (req, reply) => {
        if (!(await reauth(req, reply, (req.body as any)?.password))) return reply;
        for (const ch of await q<ChannelRow>('SELECT * FROM channels WHERE workspace_id = $1', [req.user!.workspaceId])) await removeChannel(ch);
        await destroySession(req, reply);
        await tx(async (c) => {
          const members = (await c.query('SELECT user_id FROM memberships WHERE workspace_id = $1', [req.user!.workspaceId])).rows.map((x) => x.user_id);
          await c.query('DELETE FROM workspaces WHERE id = $1', [req.user!.workspaceId]);
          // Every member goes too (a user belongs to one business only): no orphaned e-mails, password hashes or 2FA secrets (A-5).
          // Platform admins are kept.
          await c.query('DELETE FROM users WHERE id = ANY($1) AND NOT is_admin AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id)', [
            members,
          ]);
        });
        return reply.redirect('/login?m=account_deleted');
      },
    );
  });
}
