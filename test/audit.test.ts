// Regression tests for the 2026-10-27 security audit (O-1 … M-4, see SECURITY.md "Audit 2026-10-27").
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAutomation, igMessage, resetDb, seedWorkspace, startFake, stopFake } from './helpers.js';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_REDIS_URL;
const ORIGIN = 'http://localhost:3000';

// Mail is on for this file (reset links, admin links and lock warnings are mailed): a minimal SMTP server records them.
const SMTP_PORT = 4025;
process.env.SMTP_URL = `smtp://127.0.0.1:${SMTP_PORT}`;
const mails: { to: string[]; data: string }[] = [];
let smtp: Server | undefined;
function startSmtp() {
  smtp = createServer((s) => {
    let buf = '';
    let inData = false;
    let to: string[] = [];
    s.write('220 fake\r\n');
    s.on('data', (d) => {
      buf += d.toString();
      for (;;) {
        const end = inData ? buf.indexOf('\r\n.\r\n') : buf.indexOf('\r\n');
        if (end < 0) return;
        if (inData) {
          mails.push({ to, data: buf.slice(0, end).replace(/=\r\n/g, '') });
          buf = buf.slice(end + 5);
          inData = false;
          to = [];
          s.write('250 ok\r\n');
          continue;
        }
        const line = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'RCPT') to.push(/<([^>]+)>/.exec(line)?.[1] ?? '');
        if (cmd === 'DATA') {
          inData = true;
          s.write('354 go\r\n');
        } else if (cmd === 'QUIT') s.end('221 bye\r\n');
        else s.write('250 ok\r\n');
      }
    });
  });
  return new Promise<void>((ok) => smtp!.listen(SMTP_PORT, '127.0.0.1', ok));
}
const until = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const t = Date.now();
  while (!(await cond())) {
    if (Date.now() - t > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe.skipIf(!enabled)('security audit 2026-10-27', () => {
  let db: typeof import('../src/db.js');
  let app: import('fastify').FastifyInstance;
  let A: Awaited<ReturnType<typeof seedWorkspace>>;
  let owner: Awaited<ReturnType<typeof login>>;
  let ip = 0;
  const nextIp = () => `10.20.${Math.floor(++ip / 250)}.${ip % 250}`;
  const PW = 'correct-horse-battery';

  async function member(email: string, role: string, workspaceId = A.workspaceId) {
    const { hash } = await import('@node-rs/argon2');
    const u = await db.one(`INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, $2, now()) RETURNING id`, [email, await hash(PW)]);
    await db.q(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)`, [workspaceId, u.id, role]);
    return { id: u.id as string, ...(await login(email)) };
  }
  async function withTotp(userId: string) {
    const { newTotpSecret } = await import('../src/totp.js');
    const { encrypt } = await import('../src/crypto.js');
    const secret = newTotpSecret();
    await db.q('UPDATE users SET totp_secret_enc = $2, totp_enabled_at = now(), totp_last_step = 0 WHERE id = $1', [userId, encrypt(secret)]);
    return secret;
  }
  const code = async (secret: string, offset = 0) => {
    const { totpCode, currentStep } = await import('../src/totp.js');
    return totpCode(secret, currentStep() + offset);
  };
  /** Password step of the login form, from its own address. Returns the cookies the 2FA step needs. */
  async function passwordStep(email: string, from = nextIp(), password = PW) {
    const page = await app.inject({ url: '/login', remoteAddress: from });
    const pre = page.cookies.find((c) => c.name === 'pcsrf')!.value;
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1]!;
    const r = await app.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: from,
      headers: { origin: ORIGIN, cookie: `pcsrf=${pre}` },
      payload: { _csrf: csrf, email, password },
    });
    const mfa = r.cookies.find((c) => c.name === 'mfa')?.value;
    const sid = r.cookies.find((c) => c.name === 'sid')?.value;
    return { location: r.headers.location as string, from, csrf, sid, cookie: `pcsrf=${pre}${mfa ? `; mfa=${mfa}` : ''}` };
  }
  /** Like helpers' loginAs, but each login from its own address (the login form allows 10 a minute per address). */
  async function login(email: string) {
    const cookie = `sid=${(await passwordStep(email)).sid}`;
    const csrf = /name="_csrf" value="([^"]+)"/.exec((await app.inject({ url: '/app/settings', headers: { cookie } })).body)![1]!;
    return { cookie, csrf, headers: { cookie, origin: ORIGIN } };
  }
  const codeStep = (s: { from: string; csrf: string; cookie: string }, c: string) =>
    app.inject({
      method: 'POST',
      url: '/login/2fa',
      remoteAddress: s.from,
      headers: { origin: ORIGIN, cookie: s.cookie },
      payload: { _csrf: s.csrf, code: c },
    });
  const post = (s: { headers: Record<string, string>; csrf: string }, url: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url, headers: s.headers, payload: { _csrf: s.csrf, ...payload } });

  beforeAll(async () => {
    await startFake();
    await startSmtp();
    db = await import('../src/db.js');
    await resetDb();
    A = await seedWorkspace('au', 'IGAU');
    app = await (await import('../src/server.js')).buildServer();
    owner = await login(A.email);
  });
  afterAll(async () => {
    await app.close();
    await stopFake();
    await new Promise<void>((ok) => (smtp ? smtp.close(() => ok()) : ok()));
    const { closeQueues, redis } = await import('../src/queue.js');
    (await import('../src/realtime.js')).closeRealtime();
    await closeQueues();
    redis.disconnect();
    await db.pool.end();
  });

  describe('O-1 two-factor brute force', () => {
    it('10 wrong codes per user lock 2FA; logging in again does not reset the count; the owner is mailed', async () => {
      const u = await member('mfa@au.az', 'agent');
      const secret = await withTotp(u.id);
      const wrong = await code(secret, 20); // a real code of another time window: never valid now
      const results: string[] = [];
      // 3 password logins × 4 wrong codes, each from a new address (the per-IP limit must not be what stops it)
      for (let cycle = 0; cycle < 3; cycle++) {
        const s = await passwordStep('mfa@au.az');
        if (!s.location.startsWith('/login/2fa')) {
          results.push(s.location);
          continue;
        }
        for (let i = 0; i < 4; i++) results.push((await codeStep(s, wrong)).headers.location as string);
      }
      expect(results.slice(0, 9).every((l) => l.includes('bad_code'))).toBe(true);
      expect(results[9]).toContain('locked'); // 10th wrong code
      expect(results.slice(10).every((l) => /locked|bad_login/.test(l))).toBe(true); // the login attempt itself is void now
      // a fresh login with the right password is refused before any code is asked
      expect((await passwordStep('mfa@au.az')).location).toContain('locked');
      await until(() => mails.some((m) => m.to.includes('mfa@au.az')));

      // after the lock expires the right code works and clears the counter
      const { redis } = await import('../src/queue.js');
      await redis.del(`mfafail:${u.id}`);
      const s = await passwordStep('mfa@au.az');
      const ok = await codeStep(s, await code(secret));
      expect(ok.headers.location).toBe('/app');
      expect(await redis.exists(`mfafail:${u.id}`)).toBe(0);
    });

    it('a correct code is refused while the user is locked', async () => {
      const u = await member('mfa2@au.az', 'agent');
      const secret = await withTotp(u.id);
      const s = await passwordStep('mfa2@au.az');
      const { redis } = await import('../src/queue.js');
      await redis.set(`mfafail:${u.id}`, '10');
      expect((await codeStep(s, await code(secret))).headers.location).toContain('locked');
      expect(await db.one('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [u.id])).toEqual({ n: 1 }); // only member()'s own
    });
  });

  describe('A-2 forgot password', () => {
    it('at most 3 reset mails per address per hour, same answer for unknown addresses', async () => {
      const page = await app.inject({ url: '/forgot' });
      const pre = page.cookies.find((c) => c.name === 'pcsrf')!.value;
      const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1]!;
      const forgot = (email: string) =>
        app.inject({
          method: 'POST',
          url: '/forgot',
          remoteAddress: nextIp(),
          headers: { origin: ORIGIN, cookie: `pcsrf=${pre}` },
          payload: { _csrf: csrf, email },
        });
      const before = mails.length;
      const answers = [];
      for (let i = 0; i < 5; i++) answers.push((await forgot(A.email)).headers.location);
      answers.push((await forgot('nobody@au.az')).headers.location);
      expect(new Set(answers)).toEqual(new Set(['/login?m=check_email']));
      await until(async () => (await db.one(`SELECT count(*)::int AS n FROM auth_tokens WHERE user_id = $1`, [A.userId])).n >= 3);
      await new Promise((r) => setTimeout(r, 200));
      expect((await db.one(`SELECT count(*)::int AS n FROM auth_tokens WHERE user_id = $1`, [A.userId])).n).toBe(3);
      await until(() => mails.length - before >= 3);
      expect(mails.slice(before).filter((m) => m.to.includes(A.email))).toHaveLength(3);
      expect(mails.slice(before).some((m) => m.to.includes('nobody@au.az'))).toBe(false);
    });
  });

  describe('A-3 re-authentication for 2FA settings', () => {
    it('enabling 2FA needs the current password and ends the other sessions', async () => {
      const u = await member('setup@au.az', 'agent');
      const other = await login('setup@au.az'); // e.g. an intruder's parallel session
      const page = await app.inject({ url: '/app/2fa', headers: u.headers });
      const secret = /<code>([A-Z2-7 ]+)<\/code>/.exec(page.body)![1]!.replace(/ /g, '');
      const noPw = await post(u, '/app/2fa', { code: await code(secret) });
      expect(noPw.headers.location).toContain('bad_password');
      expect((await db.one('SELECT totp_enabled_at FROM users WHERE id = $1', [u.id])).totp_enabled_at).toBeNull();
      const ok = await post(u, '/app/2fa', { code: await code(secret), password: PW });
      expect(ok.headers.location).toContain('mfa_on');
      expect((await app.inject({ url: '/app/settings', headers: other.headers })).headers.location).toBe('/login');
      expect((await app.inject({ url: '/app/settings', headers: u.headers })).statusCode).toBe(200);

      // disabling needs the password too
      await db.q('UPDATE users SET totp_last_step = 0 WHERE id = $1', [u.id]);
      expect((await post(u, '/app/2fa/disable', { code: await code(secret) })).headers.location).toContain('bad_password');
      expect((await db.one('SELECT totp_enabled_at FROM users WHERE id = $1', [u.id])).totp_enabled_at).not.toBeNull();
    });

    it('5 wrong passwords in a re-auth form end every session of the user (stolen cookie)', async () => {
      const u = await member('thief@au.az', 'agent');
      const res = [];
      for (let i = 0; i < 5; i++)
        res.push((await post(u, '/app/settings/password', { current: 'guess-guess-guess', password: 'new-password-123' })).headers.location);
      expect(res.slice(0, 4).every((l) => l?.includes('bad_password'))).toBe(true);
      expect(res[4]).toContain('locked');
      expect(await db.one('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [u.id])).toEqual({ n: 0 });
    });
  });

  describe('A-4 platform admin password links', () => {
    let admin: Awaited<ReturnType<typeof login>>;
    beforeAll(async () => {
      const W = await seedWorkspace('adm', 'IGADM');
      await db.q('UPDATE users SET is_admin = true WHERE id = $1', [W.userId]);
      const secret = await withTotp(W.userId);
      const s = await passwordStep(W.email);
      const r = await codeStep(s, await code(secret));
      const cookie = `sid=${r.cookies.find((c) => c.name === 'sid')!.value}`;
      const csrf = /name="_csrf" value="([^"]+)"/.exec((await app.inject({ url: '/app/settings', headers: { cookie } })).body)![1]!;
      admin = { cookie, csrf, headers: { cookie, origin: ORIGIN } };
    });

    it('active account: the link goes only to the customer by mail and into their audit log', async () => {
      const before = mails.length;
      const r = await post(admin, `/admin/w/${A.workspaceId}/link`);
      expect(r.headers.location).toContain('link_mailed');
      expect(r.body).not.toContain('set-password');
      await until(() => mails.length > before);
      expect(mails.at(-1)!.to).toEqual([A.email]);
      expect(mails.at(-1)!.data).toContain('/set-password?token');
      const a = await db.one(`SELECT action, meta FROM audit_log WHERE workspace_id = $1 AND action = 'admin.password_link'`, [A.workspaceId]);
      expect(a.meta).toEqual({ sent_to: 'owner_email' });
    });

    it('not yet activated account: the invite link is shown to the admin, and audited', async () => {
      const N = await seedWorkspace('newbiz', 'IGNEW');
      await db.q('UPDATE users SET email_verified_at = NULL WHERE id = $1', [N.userId]);
      const r = await post(admin, `/admin/w/${N.workspaceId}/link`);
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('/set-password?token=');
      expect(await db.one(`SELECT meta FROM audit_log WHERE workspace_id = $1 AND action = 'admin.password_link'`, [N.workspaceId])).toEqual({
        meta: { sent_to: 'admin_screen', activated: false },
      });
    });
  });

  describe('A-5 / A-6 accounts and memberships', () => {
    it('deleting the account removes every member user, not only the owner', async () => {
      const D = await seedWorkspace('gone', 'IGGONE');
      const ownerD = await login(D.email);
      const m = await member('gone-agent@au.az', 'agent', D.workspaceId);
      const r = await post(ownerD, '/app/settings/delete', { password: PW });
      expect(r.headers.location).toContain('account_deleted');
      expect(await db.q('SELECT id FROM users WHERE id = ANY($1)', [[D.userId, m.id]])).toEqual([]);
      expect(await db.one('SELECT id FROM users WHERE id = $1', [A.userId])).toBeTruthy(); // other businesses untouched
    });

    it('a user can belong to one workspace only (database constraint)', async () => {
      const B = await seedWorkspace('two', 'IGTWO');
      await expect(db.q(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'agent')`, [B.workspaceId, A.userId])).rejects.toThrow(
        /memberships_user_unique/,
      );
    });
  });

  describe('A-11 analyst permissions', () => {
    it('analyst gets 403 on automations and knowledge; agent can view but not test or browse posts', async () => {
      const analyst = await member('analyst@au.az', 'analyst');
      const agent = await member('agent@au.az', 'agent');
      for (const url of ['/app/automations', '/app/knowledge']) {
        expect((await app.inject({ url, headers: analyst.headers })).statusCode).toBe(403);
        expect((await app.inject({ url, headers: agent.headers })).statusCode).toBe(200);
      }
      const nav = (await app.inject({ url: '/app', headers: analyst.headers })).body;
      expect(nav).not.toContain('href="/app/automations"');
      expect(nav).not.toContain('href="/app/knowledge"');
      const id = await createAutomation(A.workspaceId, 'comment', { match: { mode: 'any', keywords: ['qiymət'] }, steps: [{ type: 'message', text: 'x' }] });
      expect((await post(agent, `/app/automations/${id}/test`, { text: 'qiymət' })).statusCode).toBe(403);
      expect((await app.inject({ url: `/app/automations/${id}/media`, headers: agent.headers })).statusCode).toBe(403);
      expect((await post(owner, `/app/automations/${id}/test`, { text: 'qiymət' })).json()).toMatchObject({ ok: true, matched: true });
    });
  });

  describe('A-12 session lifetime', () => {
    const session = async (userId: string, age: string) => {
      const { randomToken, sha256 } = await import('../src/crypto.js');
      const token = randomToken();
      await db.q(
        `INSERT INTO sessions (id_hash, user_id, csrf_token, expires_at, created_at) VALUES ($1, $2, $3, now() + interval '7 days', now() - $4::interval)`,
        [sha256(token), userId, randomToken(), age],
      );
      return { cookie: `sid=${token}` };
    };
    const status = async (h: { cookie: string }) => (await app.inject({ url: '/app/settings', headers: h })).statusCode;

    it('30 days at most however active; platform admins 12 hours; old rows are cleaned up', async () => {
      expect(await status(await session(A.userId, '29 days'))).toBe(200);
      expect(await status(await session(A.userId, '31 days'))).toBe(302);
      const adm = await seedWorkspace('adm12', 'IGADM12');
      await db.q('UPDATE users SET is_admin = true WHERE id = $1', [adm.userId]);
      expect(await status(await session(adm.userId, '11 hours'))).toBe(200);
      expect(await status(await session(adm.userId, '13 hours'))).toBe(302);
      const { maintenance } = await import('../src/jobs.js');
      await maintenance();
      expect((await db.one(`SELECT count(*)::int AS n FROM sessions WHERE created_at < now() - interval '30 days'`)).n).toBe(0);
    });
  });

  describe('A-8 media URLs', () => {
    it('only https media URLs are kept; only Meta CDN media is embedded in the inbox', async () => {
      const { parseInstagramWebhook, onMetaCdn } = await import('../src/channels/instagram.js');
      const msg = (attachments: unknown[]) => {
        const p = igMessage('IGAU', 'U-media', `m.${Math.random()}`, '');
        (p.entry[0]!.messaging[0]!.message as any).attachments = attachments;
        return p;
      };
      const [ev] = parseInstagramWebhook(
        msg([
          { type: 'image', payload: { url: 'javascript:alert(1)' } },
          { type: 'image', payload: { url: 'http://evil.example/x.jpg' } },
          { type: 'image', payload: { url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1' } },
        ]),
      );
      expect((ev as any).media.map((m: any) => m.url)).toEqual([undefined, undefined, 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1']);
      expect(onMetaCdn('https://scontent-ams2-1.cdninstagram.com/v/x.jpg')).toBe(true);
      expect(onMetaCdn('https://cdninstagram.com.evil.example/x.jpg')).toBe(false);
      expect(onMetaCdn('http://scontent.cdninstagram.com/x.jpg')).toBe(false);

      const pipeline = await import('../src/pipeline.js');
      for (const e of parseInstagramWebhook(
        msg([
          { type: 'image', payload: { url: 'https://tracker.example/pixel.jpg' } },
          { type: 'image', payload: { url: 'https://scontent.cdninstagram.com/v/ok.jpg' } },
        ]),
      ))
        await pipeline.ingest(e);
      const c = await db
        .one(`SELECT c.id FROM conversations c JOIN contacts k ON k.id = c.contact_id WHERE k.external_user_id = 'U-media'`)
        .catch(async () => db.one(`SELECT id FROM conversations WHERE workspace_id = $1 ORDER BY last_message_at DESC LIMIT 1`, [A.workspaceId]));
      const body = (await app.inject({ url: `/app/inbox/${c.id}/part/thread`, headers: owner.headers })).body;
      expect(body).not.toContain('src="https://tracker.example');
      expect(body).toContain('href="https://tracker.example/pixel.jpg"');
      expect(body).toContain('src="https://scontent.cdninstagram.com/v/ok.jpg"');

      const csp = String((await app.inject({ url: '/login' })).headers['content-security-policy']);
      expect(csp).toMatch(/img-src 'self' data: https:\/\/\*\.cdninstagram\.com/);
      expect(csp).not.toMatch(/(img|media)-src[^;]* https:(;|\s|$)/);
    });
  });

  describe('A-10 live inbox streams', () => {
    it('at most 5 streams per user; a closed stream frees its slot; a deleted session is detected', async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const port = (app.server.address() as { port: number }).port;
      const open = () =>
        new Promise<{ status: number; req: http.ClientRequest }>((ok, fail) => {
          const req = http.get({ host: '127.0.0.1', port, path: '/app/events', headers: { cookie: owner.cookie } }, (res) => {
            ok({ status: res.statusCode ?? 0, req });
            if (res.statusCode !== 200) res.resume();
          });
          req.on('error', fail);
        });
      const streams = [];
      for (let i = 0; i < 6; i++) streams.push(await open());
      expect(streams.map((s) => s.status)).toEqual([200, 200, 200, 200, 200, 429]);
      streams[0]!.req.destroy();
      await new Promise((r) => setTimeout(r, 100));
      const again = await open();
      expect(again.status).toBe(200);
      for (const s of [...streams, again]) s.req.destroy();

      const { sessionAlive } = await import('../src/web/auth.js');
      const u = await member('sse@au.az', 'agent');
      const token = u.cookie.replace('sid=', '');
      expect(await sessionAlive(token, A.workspaceId)).toBe(true);
      expect(await sessionAlive(token, crypto.randomUUID())).toBe(false); // other workspace
      await db.q('DELETE FROM memberships WHERE user_id = $1', [u.id]); // removed from the team
      expect(await sessionAlive(token, A.workspaceId)).toBe(false);
    });
  });

  describe('O-2 least-privilege database role', () => {
    it('the owner/superuser connection counts as privileged; a data-only role does not', async () => {
      const { privilegedRole } = await import('../src/keycheck.js');
      expect(await privilegedRole()).toBe(true);
      const role = `app_rw_t${process.pid}`;
      await db.q(`CREATE ROLE ${role} LOGIN PASSWORD 'pw_${role}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      try {
        await db.q(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
        const url = new URL(process.env.TEST_DATABASE_URL!);
        url.username = role;
        url.password = `pw_${role}`;
        const pg = (await import('pg')).default;
        const limited = new pg.Pool({ connectionString: url.toString(), max: 1 });
        try {
          expect(await privilegedRole(limited)).toBe(false);
          await expect(limited.query('CREATE TABLE should_fail (id int)')).rejects.toThrow();
        } finally {
          await limited.end();
        }
      } finally {
        await db.q(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
      }
    });
  });

  describe('A-13 / M-4', () => {
    it('the app refuses to start without NODE_ENV', () => {
      const env = { ...process.env };
      delete env.NODE_ENV;
      const run = (e: NodeJS.ProcessEnv) => spawnSync(process.execPath, ['--import', 'tsx', 'src/config.ts'], { env: e, encoding: 'utf8' });
      const r = run(env);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('NODE_ENV');
      expect(run({ ...env, NODE_ENV: 'test' }).status).toBe(0);
    });

    it('webhook delivery errors shown to tenants are coarse categories, not raw socket errors', async () => {
      const { errorCategory } = await import('../src/webhooks.js');
      const err = (message: string, code?: string) => Object.assign(new Error(message), { code });
      expect(errorCategory(err('connect ECONNREFUSED 1.2.3.4:443', 'ECONNREFUSED'))).toBe('bağlantı alınmadı');
      expect(errorCategory(err('getaddrinfo ENOTFOUND x.example', 'ENOTFOUND'))).toBe('domen tapılmadı');
      expect(errorCategory(err('certificate has expired', 'CERT_HAS_EXPIRED'))).toBe('TLS xətası');
      expect(errorCategory(err('timeout'))).toBe('vaxt bitdi');
      expect(errorCategory(err('blocked address'))).toBe('ünvan bloklanıb');
    });
  });
});
