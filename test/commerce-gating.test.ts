// INTEGRATION_MODE=production WITHOUT META_COMMERCE_VERIFIED: the catalog flows stay off, existing behaviour is untouched,
// the dashboard says production is not ready, and mock mode cannot be switched on with NODE_ENV=production.
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drainAll, fake, loginAs, resetDb, seedWorkspace, startFake, stopFake } from './helpers.js';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_REDIS_URL;

describe('INTEGRATION_MODE guard', () => {
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ['--import', 'tsx', '-e', "await import('./src/config.ts'); console.log('loaded')"], {
      env: {
        PATH: process.env.PATH ?? '',
        ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
        APP_URL: 'https://example.com',
        DATABASE_URL: 'postgres://x',
        REDIS_URL: 'redis://x',
        ...env,
      },
      encoding: 'utf8',
    });

  it('refuses INTEGRATION_MODE=mock with NODE_ENV=production', () => {
    const r = run({ NODE_ENV: 'production', INTEGRATION_MODE: 'mock', ANTHROPIC_API_KEY: 'k', SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64') });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('INTEGRATION_MODE=mock is not allowed');
  });

  it('accepts mock in development and rejects unknown modes', () => {
    expect(run({ NODE_ENV: 'development', INTEGRATION_MODE: 'mock' }).stdout).toContain('loaded');
    expect(run({ NODE_ENV: 'development', INTEGRATION_MODE: 'live' }).status).toBe(1);
  });
});

describe.skipIf(!enabled)('production mode, catalog flows not verified', () => {
  let db: typeof import('../src/db.js');
  let app: import('fastify').FastifyInstance;
  let ws: Awaited<ReturnType<typeof seedWorkspace>>;

  beforeAll(async () => {
    await startFake();
    db = await import('../src/db.js');
    await resetDb();
    ws = await seedWorkspace('gate', 'IGGATE');
    await (await import('../src/commerce/fixtures.js')).seedDemoData(ws.workspaceId);
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
  beforeEach(() => fake.reset());

  it('leaves a price question under a post with products to the existing flows', async () => {
    const raw = JSON.stringify({
      object: 'instagram',
      entry: [
        {
          id: 'IGGATE',
          time: Math.floor(Date.now() / 1000),
          changes: [{ field: 'comments', value: { id: 'g1', text: 'Qiymət?', from: { id: 'U1', username: 'u' }, media: { id: 'mock_media_1002' } } }],
        },
      ],
    });
    await app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'test-meta-secret').update(raw).digest('hex')}` },
      payload: raw,
    });
    await drainAll();
    expect(await db.one(`SELECT matched, ai_status FROM ig_comments WHERE id = 'g1'`)).toEqual({ matched: false, ai_status: null });
    expect(fake.sends()).toHaveLength(0);
    expect(fake.aiCalls()).toHaveLength(0);
  });

  it('does not run post detection, and the simulator does not exist', async () => {
    const { sweepPosts } = await import('../src/commerce/posts.js');
    expect(await sweepPosts()).toBe(0);
    expect(fake.calls).toHaveLength(0);
    const s = await loginAs(app, ws.email);
    expect((await app.inject({ url: '/app/dev', headers: s.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/app/dev/seed', headers: s.headers, payload: { _csrf: s.csrf } })).statusCode).toBe(404);
    const sim = await import('../src/commerce/simulator.js');
    await expect(sim.simulatePublishPost(ws.workspaceId, 'x')).rejects.toThrow(/INTEGRATION_MODE=mock/);
  });

  it('shows no development banner, and says production is not ready', async () => {
    const s = await loginAs(app, ws.email);
    const home = await app.inject({ url: '/app', headers: s.headers });
    expect(home.body).not.toContain('DEVELOPMENT MODE');
    const page = await app.inject({ url: '/app/activity', headers: s.headers });
    expect(page.body).toContain('PRODUCTION MODE — hazır deyil');
    expect(page.body).toContain('META_APP_ID');
    expect(page.body).toContain('META_COMMERCE_VERIFIED=on');
  });
});
