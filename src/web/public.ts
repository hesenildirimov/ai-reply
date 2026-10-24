import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { randomToken, sha256 } from '../crypto.js';
import { one, q, tx } from '../db.js';
import { sendMail } from '../mailer.js';
import { redis } from '../queue.js';
import { createSession, destroySession } from './auth.js';
import { csrfField, html, page, type PageOpts } from './html.js';

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 }; // OWASP argon2id baseline
const DUMMY_HASH = await hash('timing-equalizer-not-a-password', ARGON);
const AUTH_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export const MESSAGES: Record<string, PageOpts['flash']> = {
  check_email: { type: 'ok', text: 'Əgər bu e-poçt düzgündürsə, ona link göndərildi. Poçt qutunuzu yoxlayın.' },
  verified: { type: 'ok', text: 'E-poçt təsdiqləndi. İndi daxil ola bilərsiniz.' },
  bad_token: { type: 'error', text: 'Link etibarsızdır və ya vaxtı keçib.' },
  bad_login: { type: 'error', text: 'E-poçt və ya şifrə yanlışdır, yaxud e-poçt hələ təsdiqlənməyib.' },
  locked: { type: 'error', text: 'Çox sayda uğursuz cəhd. 15 dəqiqə sonra yenidən yoxlayın.' },
  password_reset: { type: 'ok', text: 'Şifrə yeniləndi. Yenidən daxil olun.' },
  invalid: { type: 'error', text: 'Məlumatlar düzgün deyil. Yenidən yoxlayın.' },
  account_deleted: { type: 'ok', text: 'Hesabınız və bütün məlumatlarınız silindi.' },
};

export const flash = (req: FastifyRequest) => MESSAGES[(req.query as any)?.m ?? ''] ?? null;
export const view = (req: FastifyRequest, reply: FastifyReply, title: string, body: ReturnType<typeof html>, head?: ReturnType<typeof html>) =>
  reply.type('text/html; charset=utf-8').send(page(title, body, { csrf: req.csrfToken, user: req.user, flash: flash(req), head }));

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const password = z.string().min(10, 'min 10').max(200);

async function issueToken(userId: string, purpose: 'verify_email' | 'reset_password', ttl: string): Promise<string> {
  const token = randomToken();
  await q(`INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, $3, now() + $4::interval)`, [sha256(token), userId, purpose, ttl]);
  return token;
}

async function consumeToken(token: unknown, purpose: string): Promise<string | null> {
  if (typeof token !== 'string' || token.length > 100) return null;
  const row = await one<{ user_id: string }>(
    `UPDATE auth_tokens SET used_at = now() WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
    [sha256(token), purpose],
  );
  return row?.user_id ?? null;
}

async function sendVerification(userId: string, to: string) {
  const t = await issueToken(userId, 'verify_email', '48 hours');
  await sendMail(to, 'E-poçtunuzu təsdiqləyin', `Hesabınızı təsdiqləmək üçün linkə keçin (48 saat etibarlıdır):\n${config.APP_URL}/verify-email?token=${t}`);
}

const lockKey = (e: string) => `loginfail:${sha256(e).toString('hex')}`;

export function publicRoutes(app: FastifyInstance) {
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }));

  app.get('/', (req, reply) =>
    view(req, reply, 'Ana səhifə', html`<section class="card"><h1>Instagram və WhatsApp üçün AI cavablar</h1>
      <p>Biznesinizin məlumatlarını yazın, hesablarınızı bağlayın — müştərilərinizə 7/24 avtomatik, düzgün cavab verilsin. Lazım olanda söhbət əməkdaşa ötürülür.</p>
      <p><a class="btn" href="${req.user ? '/app' : '/signup'}">Başla</a></p></section>`),
  );

  app.get('/signup', (req, reply) =>
    view(req, reply, 'Qeydiyyat', html`<section class="card narrow"><h1>Qeydiyyat</h1>
      <form method="post" action="/signup">${csrfField(req.csrfToken)}
        <label>Biznesin adı<input name="business" required maxlength="120"></label>
        <label>E-poçt<input name="email" type="email" required autocomplete="email"></label>
        <label>Şifrə (min. 10 simvol)<input name="password" type="password" required minlength="10" maxlength="200" autocomplete="new-password"></label>
        <label class="row"><input type="checkbox" name="terms" value="1" required> <span><a href="/terms" target="_blank">Şərtlər</a> və <a href="/privacy" target="_blank">Məxfilik siyasəti</a> ilə razıyam</span></label>
        <button>Qeydiyyatdan keç</button></form></section>`),
  );

  app.post('/signup', { config: AUTH_LIMIT }, async (req, reply) => {
    const p = z.object({ business: z.string().trim().min(1).max(120), email, password, terms: z.literal('1') }).safeParse(req.body);
    if (!p.success) return reply.redirect('/signup?m=invalid');
    const existing = await one<{ id: string; email_verified_at: Date | null }>('SELECT id, email_verified_at FROM users WHERE email = $1', [p.data.email]);
    if (existing) {
      // Same response either way to avoid account enumeration.
      if (!existing.email_verified_at) await sendVerification(existing.id, p.data.email);
      else await sendMail(p.data.email, 'Qeydiyyat cəhdi', `Bu e-poçt artıq qeydiyyatdadır. Şifrəni unutmusunuzsa: ${config.APP_URL}/forgot`);
      return reply.redirect('/login?m=check_email');
    }
    const passwordHash = await hash(p.data.password, ARGON);
    const userId = await tx(async (c) => {
      const u = (await c.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [p.data.email, passwordHash])).rows[0];
      const w = (await c.query('INSERT INTO workspaces (name, monthly_reply_limit) VALUES ($1, $2) RETURNING id', [p.data.business, config.TRIAL_REPLY_LIMIT])).rows[0];
      await c.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [w.id, u.id]);
      await c.query('INSERT INTO assistants (workspace_id, business_name) VALUES ($1, $2)', [w.id, p.data.business]);
      return u.id as string;
    });
    await sendVerification(userId, p.data.email);
    return reply.redirect('/login?m=check_email');
  });

  app.get('/verify-email', async (req, reply) => {
    const userId = await consumeToken((req.query as any).token, 'verify_email');
    if (!userId) return reply.redirect('/login?m=bad_token');
    await q('UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1', [userId]);
    return reply.redirect('/login?m=verified');
  });

  app.get('/login', (req, reply) =>
    view(req, reply, 'Daxil ol', html`<section class="card narrow"><h1>Daxil ol</h1>
      <form method="post" action="/login">${csrfField(req.csrfToken)}
        <label>E-poçt<input name="email" type="email" required autocomplete="email"></label>
        <label>Şifrə<input name="password" type="password" required autocomplete="current-password"></label>
        <button>Daxil ol</button></form>
      <p><a href="/forgot">Şifrəni unutmusunuz?</a> · <a href="/resend">Təsdiq linkini yenidən göndər</a></p></section>`),
  );

  app.post('/login', { config: AUTH_LIMIT }, async (req, reply) => {
    const p = z.object({ email, password: z.string().max(200) }).safeParse(req.body);
    if (!p.success) return reply.redirect('/login?m=bad_login');
    const key = lockKey(p.data.email);
    if (Number(await redis.get(key)) >= 10) return reply.redirect('/login?m=locked');
    const u = await one<{ id: string; password_hash: string; email_verified_at: Date | null }>('SELECT id, password_hash, email_verified_at FROM users WHERE email = $1', [p.data.email]);
    const ok = await verify(u?.password_hash ?? DUMMY_HASH, p.data.password);
    if (!u || !ok || !u.email_verified_at) {
      await redis.multi().incr(key).expire(key, 900).exec();
      return reply.redirect('/login?m=bad_login');
    }
    await redis.del(key);
    await createSession(reply, u.id);
    return reply.redirect('/app');
  });

  app.post('/logout', async (req, reply) => {
    await destroySession(req, reply);
    return reply.redirect('/login');
  });

  const emailForm = (req: FastifyRequest, action: string, title: string) => html`<section class="card narrow"><h1>${title}</h1>
    <form method="post" action="${action}">${csrfField(req.csrfToken)}<label>E-poçt<input name="email" type="email" required></label><button>Göndər</button></form></section>`;

  app.get('/resend', (req, reply) => view(req, reply, 'Təsdiq linki', emailForm(req, '/resend', 'Təsdiq linkini yenidən göndər')));
  app.post('/resend', { config: AUTH_LIMIT }, async (req, reply) => {
    const p = email.safeParse((req.body as any)?.email);
    if (p.success) {
      const u = await one('SELECT id FROM users WHERE email = $1 AND email_verified_at IS NULL', [p.data]);
      if (u) await sendVerification(u.id, p.data);
    }
    return reply.redirect('/login?m=check_email');
  });

  app.get('/forgot', (req, reply) => view(req, reply, 'Şifrəni bərpa et', emailForm(req, '/forgot', 'Şifrəni bərpa et')));
  app.post('/forgot', { config: AUTH_LIMIT }, async (req, reply) => {
    const p = email.safeParse((req.body as any)?.email);
    if (p.success) {
      const u = await one('SELECT id FROM users WHERE email = $1', [p.data]);
      if (u) {
        const t = await issueToken(u.id, 'reset_password', '1 hour');
        await sendMail(p.data, 'Şifrənin bərpası', `Yeni şifrə təyin etmək üçün (1 saat etibarlıdır):\n${config.APP_URL}/reset?token=${t}\n\nBunu siz istəməmisinizsə, məktuba məhəl qoymayın.`);
      }
    }
    return reply.redirect('/login?m=check_email');
  });

  app.get('/reset', (req, reply) => {
    const token = String((req.query as any).token ?? '');
    return view(req, reply, 'Yeni şifrə', html`<section class="card narrow"><h1>Yeni şifrə</h1>
      <form method="post" action="/reset">${csrfField(req.csrfToken)}<input type="hidden" name="token" value="${token}">
      <label>Yeni şifrə (min. 10 simvol)<input name="password" type="password" required minlength="10" maxlength="200" autocomplete="new-password"></label><button>Yadda saxla</button></form></section>`);
  });
  app.post('/reset', { config: AUTH_LIMIT }, async (req, reply) => {
    const p = z.object({ token: z.string(), password }).safeParse(req.body);
    if (!p.success) return reply.redirect('/login?m=invalid');
    const userId = await consumeToken(p.data.token, 'reset_password');
    if (!userId) return reply.redirect('/login?m=bad_token');
    await q('UPDATE users SET password_hash = $2, email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1', [userId, await hash(p.data.password, ARGON)]);
    await q('DELETE FROM sessions WHERE user_id = $1', [userId]);
    return reply.redirect('/login?m=password_reset');
  });
}

export const passwordSchema = password;
export { ARGON };
