import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { decrypt, randomToken, sha256 } from '../crypto.js';
import { one, q } from '../db.js';
import { sendMail } from '../mailer.js';
import { redis } from '../queue.js';
import { verifyTotp } from '../totp.js';
import { createSession, destroySession } from './auth.js';
import { csrfField, html, logo, type PageOpts, page } from './html.js';
import { icon } from './icons.js';

export const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 }; // OWASP argon2id baseline
const DUMMY_HASH = await hash('timing-equalizer-not-a-password', ARGON);
const AUTH_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export const MESSAGES: Record<string, PageOpts['flash']> = {
  check_email: { type: 'ok', text: 'Əgər bu e-poçt qeydiyyatdadırsa, ona link göndərildi.' },
  bad_token: { type: 'error', text: 'Link etibarsızdır və ya vaxtı keçib. Administratordan yeni link istəyin.' },
  bad_login: { type: 'error', text: 'E-poçt və ya şifrə yanlışdır.' },
  locked: { type: 'error', text: 'Çox sayda uğursuz cəhd. 15 dəqiqə sonra yenidən yoxlayın.' },
  password_set: { type: 'ok', text: 'Şifrə təyin edildi. İndi daxil olun.' },
  invalid: { type: 'error', text: 'Məlumatlar düzgün deyil. Yenidən yoxlayın.' },
  bad_code: { type: 'error', text: 'Kod yanlışdır. Telefonunuzdakı vaxtın düzgün olduğunu yoxlayın.' },
  saved: { type: 'ok', text: 'Yadda saxlanıldı.' },
  account_deleted: { type: 'ok', text: 'Hesabınız və bütün məlumatlarınız silindi.' },
};

export const flash = (req: FastifyRequest) => MESSAGES[(req.query as any)?.m ?? ''] ?? null;
export const view = (req: FastifyRequest, reply: FastifyReply, title: string, body: ReturnType<typeof html>, head?: ReturnType<typeof html>, wide = false) =>
  reply
    .type('text/html; charset=utf-8')
    .send(page(title, body, { csrf: req.csrfToken, user: req.user, flash: flash(req), head, wide, path: req.url.split('?')[0] }));

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const passwordSchema = z.string().min(10, 'min 10').max(200);

/** One-time password-setting link (used for invites and resets). Only its hash is stored. */
export async function passwordLink(userId: string, ttl: '1 hour' | '72 hours'): Promise<string> {
  const token = randomToken();
  await q(`INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, 'reset_password', now() + $3::interval)`, [
    sha256(token),
    userId,
    ttl,
  ]);
  return `${config.APP_URL}/set-password?token=${token}`;
}

const contact = () => html`<a href="mailto:${config.SUPPORT_EMAIL}">${config.SUPPORT_EMAIL}</a>${config.CONTACT_PHONE ? html` · ${config.CONTACT_PHONE}` : ''}`;
// Password failures: per e-mail + IP (stops one attacker) and per e-mail overall with a higher bar (stops a botnet),
// so nobody can lock a person out of their account from a single address (audit A-1).
const lockKey = (e: string, ip?: string) => `loginfail:${sha256(ip ? `${e}|${ip}` : e).toString('hex')}`;
const LOCK_PER_IP = 10;
const LOCK_PER_ACCOUNT = 100;
const LOCK_TTL = 900; // 15 min
// 2FA failures are counted per user, not per login: a new password login must not reset them (audit O-1).
const MFA_FAIL_MAX = 10;
const MFA_FAIL_TTL = 900;
const mfaFailKey = (userId: string) => `mfafail:${userId}`;
const RESET_MAILS_PER_HOUR = 3;

/** Reset mail for an existing account. Runs in the background: the response time must not reveal whether it exists (A-2). */
async function sendResetLink(email: string): Promise<void> {
  const u = await one<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  if (!u) return;
  await sendMail(
    email,
    'Şifrənin bərpası',
    `Yeni şifrə təyin etmək üçün (1 saat etibarlıdır):\n${await passwordLink(u.id, '1 hour')}\n\nBunu siz istəməmisinizsə, məktuba məhəl qoymayın.`,
  );
}

export function publicRoutes(app: FastifyInstance) {
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }));

  app.get('/', (req, reply) =>
    view(
      req,
      reply,
      'Ana səhifə',
      html`<section class="hero"><h1>Instagram və WhatsApp mesajlarınıza AI cavab versin</h1>
      <p class="lead">Müştəriləriniz 7/24 dəqiq cavab alır: qiymət, ünvan, iş saatları, çatdırılma. AI bilmədiyini sizə ötürür, siz isə bütün yazışmaları bir yerdən idarə edirsiniz.</p>
      <div class="hero-actions"><a class="btn lg" href="${req.user ? '/app' : '/login'}">Daxil ol</a><span class="muted">Qoşulmaq üçün: ${contact()}</span></div></section>
      <section class="features">
        <div class="card">${icon('bot', 'i feat')}<h2>Avtomatik cavab</h2><p class="muted">Biznesinizin məlumatlarına əsasən, müştərinin dilində, saniyələr içində.</p></div>
        <div class="card">${icon('headset', 'i feat')}<h2>Operatora ötürmə</h2><p class="muted">Endirim, şikayət, sifariş təsdiqi kimi hallarda söhbət sizə keçir.</p></div>
        <div class="card">${icon('chat', 'i feat')}<h2>Vahid inbox</h2><p class="muted">Instagram və WhatsApp yazışmaları bir paneldə, istənilən vaxt özünüz cavab verin.</p></div>
      </section>`,
    ),
  );

  app.get('/login', (req, reply) =>
    view(
      req,
      reply,
      'Daxil ol',
      html`<section class="auth card"><div class="auth-brand">${logo}<h1>Daxil olun</h1><p class="muted">AI Reply panelinə xoş gəlmisiniz</p></div>
      <form method="post" action="/login">${csrfField(req.csrfToken)}
        <label>E-poçt<input name="email" type="email" required autocomplete="email" placeholder="ad@biznes.az"></label>
        <label>Şifrə<input name="password" type="password" required autocomplete="current-password"></label>
        <button class="btn block">Daxil ol</button></form>
      <p class="muted center">${config.mailEnabled ? html`<a href="/forgot">Şifrəni unutmusunuz?</a>` : html`Şifrəni unutmusunuzsa: ${contact()}`}</p></section>`,
    ),
  );

  app.post('/login', { config: AUTH_LIMIT }, async (req, reply) => {
    const p = z.object({ email: emailSchema, password: z.string().max(200) }).safeParse(req.body);
    if (!p.success) return reply.redirect('/login?m=bad_login');
    const key = lockKey(p.data.email, req.ip);
    const accKey = lockKey(p.data.email);
    const [ipFails = 0, accFails = 0] = (await redis.mget(key, accKey)).map(Number);
    if (ipFails >= LOCK_PER_IP || accFails >= LOCK_PER_ACCOUNT) {
      req.log.warn({ event: 'login_locked', account: sha256(p.data.email).toString('hex').slice(0, 16) }, 'security');
      return reply.redirect('/login?m=locked');
    }
    const u = await one<{ id: string; password_hash: string; email_verified_at: Date | null; totp_enabled_at: Date | null }>(
      'SELECT id, password_hash, email_verified_at, totp_enabled_at FROM users WHERE email = $1',
      [p.data.email],
    );
    const ok = await verify(u?.password_hash ?? DUMMY_HASH, p.data.password).catch(() => false);
    // email_verified_at is set when the user sets a password from their invite link.
    if (!u || !ok || !u.email_verified_at) {
      await redis.multi().incr(key).expire(key, LOCK_TTL).incr(accKey).expire(accKey, LOCK_TTL).exec();
      req.log.warn({ event: 'login_failed', account: sha256(p.data.email).toString('hex').slice(0, 16), known: !!u }, 'security');
      return reply.redirect('/login?m=bad_login');
    }
    await redis.del(key); // this address only; the account-wide counter expires on its own
    if (u.totp_enabled_at && Number(await redis.get(mfaFailKey(u.id))) >= MFA_FAIL_MAX) {
      req.log.warn({ event: 'mfa_locked', user: u.id }, 'security');
      return reply.redirect('/login?m=locked');
    }
    if (u.totp_enabled_at) {
      // Password OK; the session is only created after the 6-digit code (5 min, 5 attempts).
      const t = randomToken();
      await redis.set(`mfa:${sha256(t).toString('hex')}`, u.id, 'EX', 300);
      reply.setCookie('mfa', t, { httpOnly: true, secure: config.isProd, sameSite: 'strict', path: '/login', maxAge: 300 });
      return reply.redirect('/login/2fa');
    }
    await createSession(reply, u.id);
    req.log.info({ event: 'login_ok', user: u.id }, 'security');
    return reply.redirect('/app');
  });

  app.get('/login/2fa', (req, reply) =>
    view(
      req,
      reply,
      'Təsdiq kodu',
      html`<section class="auth card"><div class="auth-brand">${logo}<h1>Təsdiq kodu</h1><p class="muted">Authenticator tətbiqindəki 6 rəqəmli kodu yazın</p></div>
      <form method="post" action="/login/2fa">${csrfField(req.csrfToken)}
        <label>Kod<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label>
        <button class="btn block">Təsdiqlə</button></form></section>`,
    ),
  );

  app.post('/login/2fa', { config: AUTH_LIMIT }, async (req, reply) => {
    const t = req.cookies.mfa;
    const key = t ? `mfa:${sha256(t).toString('hex')}` : '';
    const userId = key ? await redis.get(key) : null;
    if (!userId) return reply.redirect('/login?m=bad_login');
    const failKey = mfaFailKey(userId);
    if (Number(await redis.get(failKey)) >= MFA_FAIL_MAX) {
      await redis.del(key, `${key}:n`);
      return reply.redirect('/login?m=locked');
    }
    const tries = await redis.incr(`${key}:n`);
    await redis.expire(`${key}:n`, 300);
    const u = await one('SELECT email, totp_secret_enc, totp_last_step FROM users WHERE id = $1', [userId]);
    const step = u?.totp_secret_enc ? verifyTotp(decrypt(u.totp_secret_enc), String((req.body as any)?.code ?? ''), Number(u.totp_last_step)) : null;
    // Atomic: the same code (time step) can never be used twice.
    const ok =
      step !== null && tries <= 5 && (await one('UPDATE users SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2 RETURNING id', [userId, step]));
    if (!ok) {
      const [[, fails]] = (await redis.multi().incr(failKey).expire(failKey, MFA_FAIL_TTL).exec()) as [[null, number]];
      req.log.warn({ event: 'mfa_failed', user: userId, tries, fails }, 'security');
      // The owner learns that someone who knows the password is guessing codes.
      if (fails === MFA_FAIL_MAX && u?.email && config.mailEnabled) {
        void sendMail(
          u.email,
          'AI Reply: giriş bloklandı',
          'Hesabınıza 2FA kodu ilə daxil olmaq üçün çox sayda səhv cəhd edildi və giriş 15 dəqiqəlik bloklandı. Bu siz deyilsinizsə, şifrənizi dərhal dəyişin.',
        ).catch(() => {});
      }
      const locked = tries >= 5 || fails >= MFA_FAIL_MAX;
      if (locked) await redis.del(key);
      return reply.redirect(locked ? '/login?m=locked' : '/login/2fa?m=bad_code');
    }
    await redis.del(key, `${key}:n`, failKey);
    reply.clearCookie('mfa', { path: '/login' });
    await createSession(reply, userId);
    req.log.info({ event: 'login_ok', user: userId, mfa: true }, 'security');
    return reply.redirect('/app');
  });

  app.post('/logout', async (req, reply) => {
    await destroySession(req, reply);
    return reply.redirect('/login');
  });

  if (config.mailEnabled) {
    app.get('/forgot', (req, reply) =>
      view(
        req,
        reply,
        'Şifrəni bərpa et',
        html`<section class="auth card"><h1>Şifrəni bərpa et</h1>
        <form method="post" action="/forgot">${csrfField(req.csrfToken)}<label>E-poçt<input name="email" type="email" required></label><button class="btn block">Göndər</button></form></section>`,
      ),
    );
    app.post('/forgot', { config: AUTH_LIMIT }, async (req, reply) => {
      const p = emailSchema.safeParse((req.body as any)?.email);
      if (p.success) {
        // At most a few mails per address per hour: the form must not be a way to flood someone's inbox.
        const k = `forgot:${sha256(p.data).toString('hex')}`;
        const [[, n]] = (await redis.multi().incr(k).expire(k, 3600, 'NX').exec()) as [[null, number]];
        if (n <= RESET_MAILS_PER_HOUR) void sendResetLink(p.data).catch((e) => req.log.error({ err: e }, 'reset mail failed'));
      }
      return reply.redirect('/login?m=check_email'); // same response, same speed either way (no account enumeration)
    });
  }

  app.get('/set-password', (req, reply) => {
    const token = String((req.query as any).token ?? '').slice(0, 100);
    return view(
      req,
      reply,
      'Şifrə təyin et',
      html`<section class="auth card"><div class="auth-brand">${logo}<h1>Şifrə təyin edin</h1><p class="muted">Bu şifrə ilə panelə daxil olacaqsınız</p></div>
      <form method="post" action="/set-password">${csrfField(req.csrfToken)}<input type="hidden" name="token" value="${token}">
      <label>Yeni şifrə (min. 10 simvol)<input name="password" type="password" required minlength="10" maxlength="200" autocomplete="new-password"></label><button class="btn block">Yadda saxla</button></form></section>`,
    );
  });

  app.post('/set-password', { config: AUTH_LIMIT }, async (req, reply) => {
    const p = z.object({ token: z.string().max(100), password: passwordSchema }).safeParse(req.body);
    if (!p.success) return reply.redirect('/login?m=invalid');
    const row = await one<{ user_id: string }>(
      `UPDATE auth_tokens SET used_at = now() WHERE token_hash = $1 AND purpose = 'reset_password' AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
      [sha256(p.data.token)],
    );
    if (!row) return reply.redirect('/login?m=bad_token');
    await q('UPDATE users SET password_hash = $2, email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1', [
      row.user_id,
      await hash(p.data.password, ARGON),
    ]);
    await q('DELETE FROM sessions WHERE user_id = $1', [row.user_id]);
    await q(`DELETE FROM auth_tokens WHERE user_id = $1 AND used_at IS NULL`, [row.user_id]); // invalidate other open links
    req.log.info({ event: 'password_set', user: row.user_id }, 'security');
    return reply.redirect('/login?m=password_set');
  });
}
