// Regression tests for the 2026-10-28 high-level audit (H-1 … L-4, see SECURITY.md "Audit 2026-10-28").
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fake, mails, resetDb, seedWorkspace, startFake, startFakeSmtp, stopFake, stopFakeSmtp, until } from './helpers.js';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_REDIS_URL;
const ORIGIN = 'http://localhost:3000';
const PW = 'correct-horse-battery';

// This file runs with the second (secrets) key configured and with mail on (admin and health alerts are mailed).
process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 2).toString('base64');
const SMTP_PORT = 4026;
process.env.SMTP_URL = `smtp://127.0.0.1:${SMTP_PORT}`;

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!enabled)('hardening (audit 2026-10-28)', () => {
  let db: typeof import('../src/db.js');
  let app: import('fastify').FastifyInstance;
  let A: Awaited<ReturnType<typeof seedWorkspace>>;
  let ip = 0;
  const nextIp = () => `10.30.${Math.floor(++ip / 250)}.${ip % 250}`;

  async function newUser(email: string, opts: { admin?: boolean; totp?: boolean; workspaceId?: string; role?: string } = {}) {
    const { hash } = await import('@node-rs/argon2');
    const { newTotpSecret } = await import('../src/totp.js');
    const { encryptSecret } = await import('../src/crypto.js');
    const secret = newTotpSecret();
    const u = await db.one(
      `INSERT INTO users (email, password_hash, email_verified_at, is_admin, totp_secret_enc, totp_enabled_at, totp_last_step)
       VALUES ($1, $2, now(), $3, $4, $5, 0) RETURNING id`,
      [email, await hash(PW), !!opts.admin, opts.totp ? encryptSecret(secret) : null, opts.totp ? new Date() : null],
    );
    if (opts.workspaceId)
      await db.q(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)`, [opts.workspaceId, u.id, opts.role ?? 'owner']);
    return { id: u.id as string, secret };
  }
  const code = async (secret: string) => {
    const { totpCode, currentStep } = await import('../src/totp.js');
    return totpCode(secret, currentStep());
  };
  /** Full login (password, then the 2FA code when the user has one), each from its own address. */
  async function login(email: string, secret?: string) {
    const from = nextIp();
    const page = await app.inject({ url: '/login', remoteAddress: from });
    const pre = page.cookies.find((c) => c.name === 'pcsrf')!.value;
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1]!;
    let r = await app.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: from,
      headers: { origin: ORIGIN, cookie: `pcsrf=${pre}` },
      payload: { _csrf: csrf, email, password: PW },
    });
    if (secret) {
      const mfa = r.cookies.find((c) => c.name === 'mfa')!.value;
      r = await app.inject({
        method: 'POST',
        url: '/login/2fa',
        remoteAddress: from,
        headers: { origin: ORIGIN, cookie: `pcsrf=${pre}; mfa=${mfa}` },
        payload: { _csrf: csrf, code: await code(secret) },
      });
    }
    const cookie = `sid=${r.cookies.find((c) => c.name === 'sid')!.value}`;
    const s = /name="_csrf" value="([^"]+)"/.exec((await app.inject({ url: '/app/settings', headers: { cookie } })).body)![1]!;
    return { cookie, csrf: s, headers: { cookie, origin: ORIGIN } };
  }
  const post = (s: { headers: Record<string, string>; csrf: string }, url: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url, headers: s.headers, payload: { _csrf: s.csrf, ...payload } });

  beforeAll(async () => {
    await startFake();
    await startFakeSmtp(SMTP_PORT);
    db = await import('../src/db.js');
    await resetDb();
    A = await seedWorkspace('hd', 'IGHD');
    app = await (await import('../src/server.js')).buildServer();
  });
  afterAll(async () => {
    await app.close();
    await stopFake();
    await stopFakeSmtp();
    const { closeQueues, redis } = await import('../src/queue.js');
    (await import('../src/realtime.js')).closeRealtime();
    await closeQueues();
    redis.disconnect();
    await db.pool.end();
  });

  describe('H-1 separate key for credentials', () => {
    it('credentials use the secrets key, content the content key; old secrets move over; neither key opens the other', async () => {
      const { encrypt, encryptSecret, decrypt } = await import('../src/crypto.js');
      expect(encryptSecret('token')).toMatch(/^s1:/);
      expect(encrypt('message')).toMatch(/^v1:/);
      expect(decrypt(encryptSecret('token'))).toBe('token');
      // An "s1:" ciphertext under the content key (or vice versa) does not open: the key sets are separate.
      const forged = `s1:${encrypt('x').slice(3)}`;
      expect(() => decrypt(forged)).toThrow(/SECRETS_ENCRYPTION_KEY/);

      // seedWorkspace stored the channel token the old way (content key): maintenance moves it to the secrets key.
      expect((await db.one(`SELECT access_token_enc FROM channels WHERE id = $1`, [A.channelId])).access_token_enc).toMatch(/^v1:/);
      const { reencryptSecrets } = await import('../src/jobs.js');
      await reencryptSecrets();
      const row = await db.one(`SELECT access_token_enc FROM channels WHERE id = $1`, [A.channelId]);
      expect(row.access_token_enc).toMatch(/^s1:/);
      expect(decrypt(row.access_token_enc)).toBe('ig-token-SECRET');
    });

    it('refuses to start with a different secrets key than the one the data was set up with', async () => {
      const { assertEncryptionKey } = await import('../src/keycheck.js');
      await assertEncryptionKey();
      expect((await db.one(`SELECT value FROM app_meta WHERE key = 'secrets_key_fp'`)).value).toHaveLength(24);
      await db.q(`UPDATE app_meta SET value = 'another-key-fingerprint' WHERE key = 'secrets_key_fp'`);
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(assertEncryptionKey()).rejects.toThrow('exit');
      expect(err.mock.calls.flat().join(' ')).toContain('SECRETS_ENCRYPTION_KEY does not match');
      exit.mockRestore();
      err.mockRestore();
      await db.q(`DELETE FROM app_meta WHERE key = 'secrets_key_fp'`);
    });
  });

  describe('H-2 platform admin controls', () => {
    let a1: Awaited<ReturnType<typeof newUser>>;
    let a2: Awaited<ReturnType<typeof newUser>>;
    let s1: Awaited<ReturnType<typeof login>>;
    let s2: Awaited<ReturnType<typeof login>>;
    beforeAll(async () => {
      const W = await seedWorkspace('adminhome', 'IGADMH');
      a1 = await newUser('boss1@platform.az', { admin: true, totp: true, workspaceId: W.workspaceId });
      a2 = await newUser('boss2@platform.az', { admin: true, totp: true, workspaceId: W.workspaceId, role: 'admin' });
      const before = mails.length;
      s1 = await login('boss1@platform.az', a1.secret);
      // every platform-admin login is announced to all admins
      await until(() => mails.slice(before).filter((m) => m.data.includes('daxil oldu')).length >= 2);
      s2 = await login('boss2@platform.az', a2.secret);
    });

    it('billing changes and password links are mailed to every admin', async () => {
      const before = mails.length;
      await post(s1, `/admin/w/${A.workspaceId}/extend`);
      await until(() => mails.length - before >= 2);
      expect(new Set(mails.slice(before).flatMap((m) => m.to))).toEqual(new Set(['boss1@platform.az', 'boss2@platform.az']));
      expect(await db.one(`SELECT action FROM audit_log WHERE workspace_id = $1 AND action = 'admin.payment_extended'`, [A.workspaceId])).toBeTruthy();
    });

    it('deleting a customer: name + fresh 2FA code, and a second admin must confirm', async () => {
      const D = await seedWorkspace('todelete', 'IGDEL2');
      const del = (s: typeof s1, secret: string, name = 'todelete') =>
        code(secret).then((c) => post(s, `/admin/w/${D.workspaceId}/delete`, { confirm_name: name, code: c }));
      expect((await del(s1, a1.secret, 'wrong name')).headers.location).toContain('delete_confirm_failed');
      expect((await post(s1, `/admin/w/${D.workspaceId}/delete`, { confirm_name: 'todelete', code: '000000' })).headers.location).toContain(
        'delete_confirm_failed',
      );
      // first admin: only a request
      await db.q(`UPDATE users SET totp_last_step = 0 WHERE id = $1`, [a1.id]);
      expect((await del(s1, a1.secret)).headers.location).toContain('delete_requested');
      expect(await db.one(`SELECT id FROM workspaces WHERE id = $1`, [D.workspaceId])).toBeTruthy();
      // the same admin cannot confirm their own request
      await db.q(`UPDATE users SET totp_last_step = 0 WHERE id = $1`, [a1.id]);
      expect((await del(s1, a1.secret)).headers.location).toContain('delete_requested');
      expect(await db.one(`SELECT id FROM workspaces WHERE id = $1`, [D.workspaceId])).toBeTruthy();
      // the second admin confirms (with a code not used yet: each 2FA code works once)
      await db.q(`UPDATE users SET totp_last_step = 0 WHERE id = $1`, [a2.id]);
      expect((await del(s2, a2.secret)).headers.location).toContain('customer_deleted');
      expect(await db.one(`SELECT id FROM workspaces WHERE id = $1`, [D.workspaceId])).toBeUndefined();
    });
  });

  describe('M-1 auth limits fail closed', () => {
    it('without Redis the login form answers an error instead of running unthrottled; other pages keep working', async () => {
      const { redis } = await import('../src/queue.js');
      const r = redis as unknown as { rateLimit: (...a: unknown[]) => void };
      const real = r.rateLimit;
      r.rateLimit = (...a: unknown[]) => (a.at(-1) as (e: Error) => void)(new Error('redis down'));
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const page = await app.inject({ url: '/login', remoteAddress: nextIp() });
        expect(page.statusCode).toBe(200); // global limit: fail open
        const res = await app.inject({
          method: 'POST',
          url: '/login',
          remoteAddress: nextIp(),
          headers: { origin: ORIGIN },
          payload: { email: A.email, password: PW },
        });
        expect(res.statusCode).toBe(500);
        expect(res.cookies.find((c) => c.name === 'sid')).toBeUndefined();
      } finally {
        r.rateLimit = real;
        errors.mockRestore();
      }
    });
  });

  describe('M-2 ffmpeg reads only real media', () => {
    it.skipIf(!hasFfmpeg)('a playlist disguised as a video cannot make ffmpeg fetch a URL', async () => {
      fake.reset();
      fake.handler = (_b, path) =>
        path === '/media/clip.mp4'
          ? { file: { type: 'video/mp4', body: Buffer.from('#EXTM3U\n#EXTINF:1,\nhttp://127.0.0.1:4011/ssrf-hit.ts\n#EXT-X-ENDLIST\n') } }
          : undefined;
      const { mediaNote } = await import('../src/media.js');
      const ch = await db.one(`SELECT * FROM channels WHERE id = $1`, [A.channelId]);
      const note = await mediaNote(ch, [{ type: 'video', url: 'http://127.0.0.1:4011/media/clip.mp4' }], {
        workspaceId: A.workspaceId,
        conversationId: '00000000-0000-0000-0000-000000000000',
      });
      expect(note).toContain('[Video:');
      expect(fake.calls.some((c) => c.path.includes('ssrf-hit'))).toBe(false);
      fake.reset();
    });
  });

  describe('M-4 AI behaviour', () => {
    it('a reply that echoes our instructions is blocked', async () => {
      const { checkReply } = await import('../src/guard.js');
      expect(checkReply('Sure! <business_info name="x"> ...', 'Don: 45 AZN')).toMatchObject({ ok: false, reason: 'prompt_leak' });
      expect(checkReply('My rules: use the request_human tool when...', '')).toMatchObject({ ok: false, reason: 'prompt_leak' });
      expect(checkReply('Bəli, don 45 AZN-dir 🙂', 'Don: 45 AZN')).toEqual({ ok: true });
    });

    it('EU market: AI self-identification is on and the business cannot switch it off', async () => {
      const W = await seedWorkspace('eushop', 'IGEU');
      const adm = await newUser('boss3@platform.az', { admin: true, totp: true, workspaceId: W.workspaceId });
      const s = await login('boss3@platform.az', adm.secret);
      await post(s, `/admin/w/${W.workspaceId}/update`, { name: 'eushop', limit: 100, paid_until: '', note: '', region: 'eu' });
      expect((await db.one(`SELECT ai_disclosure FROM assistants WHERE workspace_id = $1`, [W.workspaceId])).ai_disclosure).toBe(true);
      const owner = await login(W.email);
      const page = await app.inject({ url: '/app/assistant', headers: owner.headers });
      expect(page.body).toMatch(/name="ai_disclosure" value="1" checked\s+disabled/);
      await post(owner, '/app/assistant', {
        business_name: 'eushop',
        knowledge: '',
        style_guide: '',
        style_preset: 'auto',
        handoff_message: 'x',
        enabled: '1',
      });
      expect((await db.one(`SELECT ai_disclosure FROM assistants WHERE workspace_id = $1`, [W.workspaceId])).ai_disclosure).toBe(true);
    });
  });

  describe('M-5 contact data', () => {
    it('custom field values are encrypted; old plaintext values are sealed by maintenance and still read the same', async () => {
      const ct = await db.one(`INSERT INTO contacts (workspace_id, channel_id, external_id, fields) VALUES ($1, $2, 'U-f', $3) RETURNING id`, [
        A.workspaceId,
        A.channelId,
        JSON.stringify({ phone: '0501234567' }),
      ]);
      const { setField, openFields } = await import('../src/contacts.js');
      await setField(ct.id, 'address', 'Nizami 10');
      let row = await db.one(`SELECT fields FROM contacts WHERE id = $1`, [ct.id]);
      expect(row.fields.address).toMatch(/^v1:/);
      expect(row.fields.phone).toBe('0501234567'); // legacy
      const { sealLegacyMessages } = await import('../src/jobs.js');
      await sealLegacyMessages();
      row = await db.one(`SELECT fields FROM contacts WHERE id = $1`, [ct.id]);
      expect(row.fields.phone).toMatch(/^v1:/);
      expect(JSON.stringify(row.fields)).not.toContain('0501234567');
      expect(openFields(row.fields)).toEqual({ phone: '0501234567', address: 'Nizami 10' });
    });
  });

  describe('L-4 health alerts', () => {
    it('a burst of lockouts mails the admins once', async () => {
      const { healthSignal } = await import('../src/alerts.js');
      const admins = (await db.one(`SELECT count(*)::int AS n FROM users WHERE is_admin AND email_verified_at IS NOT NULL`)).n;
      const before = mails.length;
      for (let i = 0; i < 25; i++) await healthSignal('login_locked');
      await until(() => mails.length - before >= admins);
      await new Promise((r) => setTimeout(r, 200));
      expect(mails.length - before).toBe(admins); // one alert per admin, not one per lockout
    });
  });
});
