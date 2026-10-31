// Public website, lead form, admin Leads, plan-based reply limits and the photo-model setting.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fake, loginAs, resetDb, seedWorkspace, startFake, stopFake, until } from './helpers.js';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_REDIS_URL;
const ORIGIN = 'http://localhost:3000';
const PW = 'correct-horse-battery';

// New leads also go to a Telegram chat: the fake API server stands in for Telegram.
process.env.TELEGRAM_API_BASE = 'http://127.0.0.1:4011';
process.env.LEADS_TELEGRAM_CHAT_ID = '777';

describe.skipIf(!enabled)('website and leads', () => {
  let db: typeof import('../src/db.js');
  let app: import('fastify').FastifyInstance;
  let ip = 0;
  const nextIp = () => `10.40.0.${++ip}`;

  /** The request form as a visitor sends it (anonymous CSRF cookie + token from the page). */
  async function submit(fields: Record<string, string>, lang = '') {
    const from = nextIp();
    const page = await app.inject({ url: `${lang}/request`, remoteAddress: from });
    const pre = page.cookies.find((c) => c.name === 'pcsrf')!.value;
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1]!;
    return app.inject({
      method: 'POST',
      url: '/request',
      remoteAddress: from,
      headers: { origin: ORIGIN, cookie: `pcsrf=${pre}` },
      payload: { _csrf: csrf, ...fields },
    });
  }
  const valid = {
    lang: 'az',
    name: 'Aysel Məmmədova',
    business: 'Gül Butik',
    phone: '+994 50 123 45 67',
    email: 'aysel@gulbutik.az',
    instagram: '@gulbutik.az',
    industry: 'clothing',
    monthly_messages: '2000_10000',
    plan: 'biznes',
    intent: 'demo',
    preferred_time: 'iş günləri 15:00',
    message: '',
    consent: '1',
    website: '',
  };

  beforeAll(async () => {
    await startFake();
    db = await import('../src/db.js');
    await resetDb();
    app = await (await import('../src/server.js')).buildServer();
  });
  afterAll(async () => {
    await app.close();
    await stopFake();
    const { closeQueues, redis } = await import('../src/queue.js');
    (await import('../src/realtime.js')).closeRealtime();
    await closeQueues();
    redis.disconnect();
    await db.pool.end();
  });

  it('home page in three languages, plans and limits from the plans table', async () => {
    const az = await app.inject({ url: '/' });
    expect(az.statusCode).toBe(200);
    expect(az.body).toContain('<html lang="az">');
    expect(az.body).toContain('Görüş təyin et');
    expect(az.body).toContain('Daxil ol');
    expect(az.body).toMatch(/Biznes<\/h3>\s*<p class="price">79 AZN/);
    expect(az.body).toContain('<b>6 000</b> AI cavabı ayda'); // migration 017: Biznes = 6 000 AI replies
    expect(az.body).toContain('href="/request?plan=pro"');
    const ru = await app.inject({ url: '/ru' });
    expect(ru.body).toContain('<html lang="ru">');
    expect(ru.body).toContain('Записаться на встречу');
    expect(ru.body).toContain('href="/ru/request?plan=biznes"');
    const en = await app.inject({ url: '/en' });
    expect(en.body).toContain('Book a meeting');
    // no demo link configured -> no "see the demo" button
    expect(az.body).not.toContain('Demoya bax');
  });

  it('the form arrives with the chosen plan and intent', async () => {
    const r = await app.inject({ url: '/request?plan=pro&intent=call' });
    expect(r.body).toMatch(/<option value="pro" selected>Pro/);
    expect(r.body).toMatch(/value="call" checked/);
    expect(r.body).toContain('name="website"'); // honeypot field exists, hidden by CSS
    const unknown = await app.inject({ url: '/en/request' });
    expect(unknown.body).toMatch(/<option value="unknown" selected>Not sure yet/);
  });

  it('a request is stored as a lead and the admins hear about it (Telegram)', async () => {
    fake.reset();
    const r = await submit(valid);
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/request/thanks');
    const lead = await db.one(`SELECT * FROM leads WHERE email = 'aysel@gulbutik.az'`);
    expect(lead).toMatchObject({ business: 'Gül Butik', plan: 'biznes', intent: 'demo', status: 'new', lang: 'az', industry: 'clothing' });
    expect(lead.consent_at).toBeTruthy();
    await until(() => fake.calls.some((c) => c.path.endsWith('/sendMessage')));
    const tg = fake.calls.find((c) => c.path.endsWith('/sendMessage'))!;
    expect(tg.body.chat_id).toBe('777');
    expect(tg.body.text).toContain('Gül Butik');
    expect(tg.body.text).toContain(`/admin/leads/${lead.id}`);
    expect((await app.inject({ url: '/request/thanks' })).body).toContain('Təşəkkürlər');
  });

  it('bots that fill the hidden field get a "thank you" and nothing is stored', async () => {
    const before = (await db.one(`SELECT count(*)::int AS n FROM leads`)).n;
    const r = await submit({ ...valid, email: 'bot@spam.xyz', website: 'http://spam.xyz' });
    expect(r.headers.location).toBe('/request/thanks');
    expect((await db.one(`SELECT count(*)::int AS n FROM leads`)).n).toBe(before);
  });

  it('missing consent or a broken phone: the form comes back with the values kept', async () => {
    const r = await submit({ ...valid, consent: '', email: 'x@y.az', lang: 'ru' }, '/ru');
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Пожалуйста, проверьте');
    expect(r.body).toContain('value="Gül Butik"');
    const bad = await submit({ ...valid, phone: 'call me', email: 'y@y.az' });
    expect(bad.statusCode).toBe(400);
    expect(await db.one(`SELECT 1 FROM leads WHERE email IN ('x@y.az', 'y@y.az')`)).toBeUndefined();
  });

  describe('admin Leads', () => {
    let admin: Awaited<ReturnType<typeof loginAs>>;
    beforeAll(async () => {
      const W = await seedWorkspace('platform', 'IGPLAT');
      const { newTotpSecret, totpCode, currentStep } = await import('../src/totp.js');
      const { encryptSecret } = await import('../src/crypto.js');
      const secret = newTotpSecret();
      await db.q(`UPDATE users SET is_admin = true, totp_secret_enc = $2, totp_enabled_at = now(), totp_last_step = 0 WHERE id = $1`, [
        W.userId,
        encryptSecret(secret),
      ]);
      const from = nextIp();
      const page = await app.inject({ url: '/login', remoteAddress: from });
      const pre = page.cookies.find((c) => c.name === 'pcsrf')!.value;
      const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1]!;
      const r1 = await app.inject({
        method: 'POST',
        url: '/login',
        remoteAddress: from,
        headers: { origin: ORIGIN, cookie: `pcsrf=${pre}` },
        payload: { _csrf: csrf, email: W.email, password: PW },
      });
      const mfa = r1.cookies.find((c) => c.name === 'mfa')!.value;
      const r2 = await app.inject({
        method: 'POST',
        url: '/login/2fa',
        remoteAddress: from,
        headers: { origin: ORIGIN, cookie: `pcsrf=${pre}; mfa=${mfa}` },
        payload: { _csrf: csrf, code: totpCode(secret, currentStep()) },
      });
      const cookie = `sid=${r2.cookies.find((c) => c.name === 'sid')!.value}`;
      const s = /name="_csrf" value="([^"]+)"/.exec((await app.inject({ url: '/app/settings', headers: { cookie } })).body)![1]!;
      admin = { cookie, csrf: s, headers: { cookie, origin: ORIGIN } };
    });
    const post = (url: string, payload: Record<string, unknown> = {}) =>
      app.inject({ method: 'POST', url, headers: admin.headers, payload: { _csrf: admin.csrf, ...payload } });

    it('only platform admins see leads', async () => {
      const C = await seedWorkspace('customer1', 'IGC1');
      const owner = await loginAs(app, C.email);
      expect((await app.inject({ url: '/admin/leads', headers: owner.headers })).statusCode).toBe(404);
      const list = await app.inject({ url: '/admin/leads', headers: admin.headers });
      expect(list.statusCode).toBe(200);
      expect(list.body).toContain('Gül Butik');
      expect((await app.inject({ url: '/admin', headers: admin.headers })).body).toMatch(/Lead-lər <span class="count">1<\/span>/);
    });

    it('status, notes, search and CSV', async () => {
      const lead = await db.one(`SELECT id FROM leads WHERE email = 'aysel@gulbutik.az'`);
      await post(`/admin/leads/${lead.id}/status`, { status: 'meeting' });
      await post(`/admin/leads/${lead.id}/note`, { body: 'Cümə axşamı 15:00 görüş' });
      const page = await app.inject({ url: `/admin/leads/${lead.id}`, headers: admin.headers });
      expect(page.body).toContain('Cümə axşamı 15:00 görüş');
      expect(page.body).toMatch(/<option value="meeting" selected>Görüş/);
      expect((await app.inject({ url: '/admin/leads?status=meeting&q=gül', headers: admin.headers })).body).toContain('Gül Butik');
      expect((await app.inject({ url: '/admin/leads?status=lost', headers: admin.headers })).body).not.toContain('Gül Butik');
      const csv = await app.inject({ url: '/admin/leads.csv', headers: admin.headers });
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.body).toContain('Gül Butik');
    });

    it('one click turns the lead into a customer with the plan’s limits', async () => {
      const lead = await db.one(`SELECT id FROM leads WHERE email = 'aysel@gulbutik.az'`);
      const pro = await db.one(`SELECT id FROM plans WHERE name = 'Pro'`);
      const r = await post(`/admin/leads/${lead.id}/convert`, { plan_id: pro.id, paid_until: '' });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('Gül Butik yaradıldı');
      expect(r.body).toContain('/set-password?token=');
      const l = await db.one(`SELECT status, workspace_id FROM leads WHERE id = $1`, [lead.id]);
      expect(l.status).toBe('won');
      const { subscriptionOf } = await import('../src/billing.js');
      expect(await subscriptionOf(l.workspace_id)).toMatchObject({ name: 'Gül Butik', replyLimit: 20000, customLimit: false, planName: 'Pro' });
      expect(await db.one(`SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1`, [l.workspace_id])).toEqual({
        email: 'aysel@gulbutik.az',
      });
      // a second click does not create a second customer
      expect((await post(`/admin/leads/${lead.id}/convert`, { plan_id: pro.id, paid_until: '' })).headers.location).toBe(`/admin/w/${l.workspace_id}`);
    });

    it('a custom limit overrides the plan; empty goes back to the plan', async () => {
      const ws = (await db.one(`SELECT workspace_id FROM leads WHERE email = 'aysel@gulbutik.az'`)).workspace_id;
      const { subscriptionOf, reserveReply } = await import('../src/billing.js');
      await post(`/admin/w/${ws}/update`, { name: 'Gül Butik', limit: '2', paid_until: '', note: '' });
      expect(await subscriptionOf(ws)).toMatchObject({ replyLimit: 2, customLimit: true });
      expect([await reserveReply(ws), await reserveReply(ws), await reserveReply(ws)]).toEqual(['ok', 'ok', 'limit']);
      await post(`/admin/w/${ws}/update`, { name: 'Gül Butik', limit: '', paid_until: '', note: '' });
      expect(await subscriptionOf(ws)).toMatchObject({ replyLimit: 20000, customLimit: false });
      expect(await reserveReply(ws)).toBe('ok');
    });
  });

  it('photo analysis: the cheap model by default, the precise one when the business switches it on', async () => {
    const W = await seedWorkspace('photos', 'IGPH');
    const owner = await loginAs(app, W.email);
    expect((await db.one(`SELECT media_model FROM assistants WHERE workspace_id = $1`, [W.workspaceId])).media_model).toBe('fast');
    const form = { business_name: 'photos', knowledge: '', style_guide: '', style_preset: 'auto', handoff_message: 'x', enabled: '1' };
    await app.inject({ method: 'POST', url: '/app/assistant', headers: owner.headers, payload: { _csrf: owner.csrf, ...form, media_smart: '1' } });
    expect((await db.one(`SELECT media_model FROM assistants WHERE workspace_id = $1`, [W.workspaceId])).media_model).toBe('smart');
    await app.inject({ method: 'POST', url: '/app/assistant', headers: owner.headers, payload: { _csrf: owner.csrf, ...form } });
    expect((await db.one(`SELECT media_model FROM assistants WHERE workspace_id = $1`, [W.workspaceId])).media_model).toBe('fast');
  });
});
