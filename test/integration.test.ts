import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { hash } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainInbound } from './helpers.js';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_REDIS_URL;

describe.skipIf(!enabled)('security (integration)', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/db.js');
  const ids: Record<string, string> = {};
  const ORIGIN = { origin: 'http://localhost:3000' };

  /** Logs in through the real form (CSRF cookie + token) and returns the session cookie header. */
  async function login(email: string): Promise<{ cookie: string; csrf: string }> {
    const page = await app.inject({ url: '/login' });
    const pre = page.cookies.find((c) => c.name === 'pcsrf')!;
    const token = /name="_csrf" value="([^"]+)"/.exec(page.body)![1]!;
    const res = await app.inject({
      method: 'POST', url: '/login', headers: { ...ORIGIN, cookie: `pcsrf=${pre.value}` },
      payload: { _csrf: token, email, password: 'correct-horse-battery' },
    });
    expect(res.headers.location).toBe('/app');
    const cookie = `sid=${res.cookies.find((c) => c.name === 'sid')!.value}`;
    const csrf = /name="_csrf" value="([^"]+)"/.exec((await app.inject({ url: '/app/settings', headers: { cookie } })).body)![1]!;
    return { cookie, csrf };
  }

  beforeAll(async () => {
    db = await import('../src/db.js');
    const { encrypt } = await import('../src/crypto.js');
    await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await (await import('../src/queue.js')).redis.flushdb(); // no rate-limit counters left over from other test files
    for (const f of readdirSync('migrations').filter((x) => x.endsWith('.sql')).sort()) await db.pool.query(readFileSync(`migrations/${f}`, 'utf8'));
    const pw = await hash('correct-horse-battery');
    for (const name of ['a', 'b']) {
      const u = await db.one(`INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, $2, now()) RETURNING id`, [`${name}@test.az`, pw]);
      const w = await db.one(`INSERT INTO workspaces (name, monthly_reply_limit) VALUES ($1, 10) RETURNING id`, [`WS ${name}`]);
      await db.q(`INSERT INTO memberships VALUES ($1, $2, 'owner')`, [w.id, u.id]);
      await db.q(`INSERT INTO assistants (workspace_id) VALUES ($1)`, [w.id]);
      const ch = await db.one(`INSERT INTO channels (workspace_id, type, external_id, access_token_enc) VALUES ($1, 'whatsapp', $2, $3) RETURNING id`, [w.id, `1000${name === 'a' ? 1 : 2}`, encrypt('token')]);
      const c = await db.one(`INSERT INTO conversations (workspace_id, channel_id, external_user_id) VALUES ($1, $2, '99450') RETURNING id`, [w.id, ch.id]);
      Object.assign(ids, { [`ws_${name}`]: w.id, [`conv_${name}`]: c.id });
    }
    app = await (await import('../src/server.js')).buildServer();
  });

  afterAll(async () => {
    await app?.close();
    const { closeQueues, redis } = await import('../src/queue.js');
    await closeQueues();
    redis.disconnect();
    await db?.pool.end();
  });

  it('requires login for the panel and admin', async () => {
    for (const url of ['/app', '/app/inbox', '/admin', '/app/settings/export']) {
      expect((await app.inject({ url })).headers.location).toBe('/login');
    }
  });

  it('rejects state-changing requests without CSRF token or from another origin', async () => {
    const { cookie, csrf } = await login('a@test.az');
    expect((await app.inject({ method: 'POST', url: '/app/assistant', headers: { cookie, ...ORIGIN }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/app/assistant', headers: { cookie, origin: 'https://evil.example' }, payload: { _csrf: csrf } })).statusCode).toBe(403);
  });

  it('blocks access to another workspace (IDOR) and to admin pages', async () => {
    const { cookie, csrf } = await login('a@test.az');
    expect((await app.inject({ url: `/app/inbox/${ids.conv_b}`, headers: { cookie } })).statusCode).toBe(404);
    await app.inject({ method: 'POST', url: `/app/inbox/${ids.conv_b}/delete`, headers: { cookie, ...ORIGIN }, payload: { _csrf: csrf } });
    await app.inject({ method: 'POST', url: `/app/inbox/${ids.conv_b}/reply`, headers: { cookie, ...ORIGIN }, payload: { _csrf: csrf, text: 'hi' } });
    expect((await db.one('SELECT count(*)::int AS n FROM conversations WHERE id = $1', [ids.conv_b])).n).toBe(1);
    expect((await db.one('SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1', [ids.conv_b])).n).toBe(0);
    expect((await app.inject({ url: '/admin', headers: { cookie } })).statusCode).toBe(404);
  });

  it('verifies webhook signatures, deduplicates retries and escapes message content', async () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '10001' }, contacts: [], messages: [{ from: '99450', id: 'wamid.T1', type: 'text', text: { body: '<script>alert(1)</script>' } }] } }] }] });
    const sig = 'sha256=' + createHmac('sha256', 'test-meta-secret').update(body).digest('hex');
    const post = (s: string) => app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': s }, payload: body });
    expect((await post('sha256=' + '0'.repeat(64))).statusCode).toBe(401);
    expect((await post(sig)).statusCode).toBe(200);
    expect((await post(sig)).statusCode).toBe(200);
    await drainInbound();
    expect((await db.one(`SELECT count(*)::int AS n FROM messages WHERE external_id = 'wamid.T1'`)).n).toBe(1);
    const { cookie } = await login('a@test.az');
    const page = (await app.inject({ url: `/app/inbox/${ids.conv_a}`, headers: { cookie } })).body;
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('&lt;script&gt;');
  });

  it('forces admins to set up two-factor login and enforces it at login', async () => {
    const { encrypt } = await import('../src/crypto.js');
    const { newTotpSecret, totpCode, currentStep } = await import('../src/totp.js');
    await db.q(`UPDATE users SET is_admin = true WHERE email = 'b@test.az'`);
    const b = await login('b@test.az');
    expect((await app.inject({ url: '/admin', headers: { cookie: b.cookie } })).headers.location).toBe('/app/2fa?m=mfa_required');
    const secret = newTotpSecret();
    await db.q(`UPDATE users SET totp_secret_enc = $1, totp_enabled_at = now() WHERE email = 'b@test.az'`, [encrypt(secret)]);
    // Password alone no longer creates a session.
    const page = await app.inject({ url: '/login' });
    const pre = page.cookies.find((c) => c.name === 'pcsrf')!;
    const token = /name="_csrf" value="([^"]+)"/.exec(page.body)![1]!;
    const res = await app.inject({ method: 'POST', url: '/login', headers: { ...ORIGIN, cookie: `pcsrf=${pre.value}` }, payload: { _csrf: token, email: 'b@test.az', password: 'correct-horse-battery' } });
    expect(res.headers.location).toBe('/login/2fa');
    expect(res.cookies.find((c) => c.name === 'sid')).toBeUndefined();
    const mfa = `pcsrf=${pre.value}; mfa=${res.cookies.find((c) => c.name === 'mfa')!.value}`;
    const bad = await app.inject({ method: 'POST', url: '/login/2fa', headers: { ...ORIGIN, cookie: mfa }, payload: { _csrf: token, code: '000000' } });
    expect(bad.headers.location).toBe('/login/2fa?m=bad_code');
    const code = totpCode(secret, currentStep());
    const good = await app.inject({ method: 'POST', url: '/login/2fa', headers: { ...ORIGIN, cookie: mfa }, payload: { _csrf: token, code } });
    expect(good.headers.location).toBe('/app');
    expect(good.cookies.find((c) => c.name === 'sid')).toBeDefined();
  });

  it('accepts browser push subscriptions only for real push services (no SSRF)', async () => {
    const { subscriptionSchema } = await import('../src/webpush.js');
    const keys = { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) };
    expect(subscriptionSchema.safeParse({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys }).success).toBe(true);
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://169.254.169.254/latest', 'https://redis:6379/', 'https://fcm.googleapis.com.evil.com/x', 'https://fcm.googleapis.com:8443/x']) {
      expect(subscriptionSchema.safeParse({ endpoint, keys }).success).toBe(false);
    }
  });

  it('rejects Telegram updates without the secret header', async () => {
    const res = await app.inject({ method: 'POST', url: '/webhooks/telegram', payload: { message: { chat: { id: 1, type: 'private' }, text: '/stop' } } });
    expect(res.statusCode).toBe(401);
  });

  it('enforces payment date and monthly limit on the server', async () => {
    const { reserveReply } = await import('../src/billing.js');
    await db.q(`UPDATE workspaces SET paid_until = current_date - 1 WHERE id = $1`, [ids.ws_b]);
    expect(await reserveReply(ids.ws_b!)).toBe('expired');
    await db.q(`UPDATE workspaces SET paid_until = NULL, monthly_reply_limit = 2 WHERE id = $1`, [ids.ws_b]);
    expect([await reserveReply(ids.ws_b!), await reserveReply(ids.ws_b!), await reserveReply(ids.ws_b!)]).toEqual(['ok', 'ok', 'limit']);
  });
});
