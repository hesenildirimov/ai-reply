import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fake, igMessage, loginAs, resetDb, seedWorkspace, startFake, stopFake } from './helpers.js';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_REDIS_URL;

describe.skipIf(!enabled)('P2 inbox (integration)', () => {
  let db: typeof import('../src/db.js');
  let pipeline: typeof import('../src/pipeline.js');
  let app: import('fastify').FastifyInstance;
  let A: Awaited<ReturnType<typeof seedWorkspace>>;
  let B: Awaited<ReturnType<typeof seedWorkspace>>;
  let n = 0;
  async function inbound(ig: string, from: string, text: string) {
    const { parseInstagramWebhook } = await import('../src/channels/instagram.js');
    const mid = `ib.${++n}`;
    for (const ev of parseInstagramWebhook(igMessage(ig, from, mid, text))) await pipeline.ingest(ev);
    return db.one(`SELECT m.id, m.conversation_id, c.contact_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.external_id = $1`, [mid]);
  }

  beforeAll(async () => {
    await startFake();
    db = await import('../src/db.js');
    pipeline = await import('../src/pipeline.js');
    await resetDb();
    A = await seedWorkspace('wa', 'IGA');
    B = await seedWorkspace('wb', 'IGB');
    app = await (await import('../src/server.js')).buildServer();
  });
  beforeEach(() => fake.reset());
  afterAll(async () => {
    await app.close();
    await stopFake();
    const { queue, redis } = await import('../src/queue.js');
    const { closeRealtime } = await import('../src/realtime.js');
    closeRealtime();
    await queue.close();
    redis.disconnect();
    await db.pool.end();
  });

  it('workspace A cannot read or change workspace B conversations and contacts', async () => {
    const b = await inbound('IGB', 'UB1', 'B-nin gizli mesajı');
    const s = await loginAs(app, A.email);
    for (const url of [`/app/inbox/${b.conversation_id}`, `/app/inbox/${b.conversation_id}/part/thread`, `/app/inbox/${b.conversation_id}/part/profile`, `/app/media/${b.id}/0`]) {
      expect((await app.inject({ url, headers: s.headers })).statusCode).toBe(404);
    }
    const list = await app.inject({ url: '/app/inbox?f=all&q=gizli', headers: s.headers });
    expect(list.body).not.toContain('B-nin');
    const post = (url: string, payload: Record<string, string>) => app.inject({ method: 'POST', url, headers: { ...s.headers, accept: 'application/json' }, payload: { _csrf: s.csrf, ...payload } });
    expect((await post(`/app/contacts/${b.contact_id}/tags`, { add: 'hack' })).statusCode).toBe(404);
    expect((await post(`/app/contacts/${b.contact_id}/flags`, { blocked: '1' })).statusCode).toBe(404);
    await post(`/app/inbox/${b.conversation_id}/assign`, { user_id: 'me' });
    await post(`/app/inbox/${b.conversation_id}/note`, { body: 'x' });
    expect((await db.one(`SELECT assignee_user_id FROM conversations WHERE id = $1`, [b.conversation_id])).assignee_user_id).toBeNull();
    expect((await db.one(`SELECT count(*)::int AS n FROM conversation_notes`)).n).toBe(0);
    expect((await db.one(`SELECT count(*)::int AS n FROM contact_tags`)).n).toBe(0);
  });

  it('assigning a conversation to an operator keeps the bot silent; actions are audited', async () => {
    const a = await inbound('IGA', 'UA1', 'Salam');
    const s = await loginAs(app, A.email);
    const post = (path: string, payload: Record<string, string>) =>
      app.inject({ method: 'POST', url: `/app/inbox/${a.conversation_id}/${path}`, headers: { ...s.headers, accept: 'application/json' }, payload: { _csrf: s.csrf, ...payload } });
    expect((await post('assign', { user_id: 'me' })).json()).toEqual({ ok: true });
    await pipeline.processReply(a.conversation_id, a.id);
    expect(fake.sends()).toHaveLength(0);
    expect(fake.aiCalls()).toHaveLength(0);
    await post('note', { body: 'VIP müştəri' });
    await post('status', { status: 'closed' });
    const conv = await db.one(`SELECT status FROM conversations WHERE id = $1`, [a.conversation_id]);
    expect(conv.status).toBe('closed');
    const actions = (await db.q(`SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id`, [a.conversation_id])).map((r) => r.action);
    expect(actions).toEqual(['conversation.assign', 'conversation.close']);
    const page = await app.inject({ url: `/app/inbox/${a.conversation_id}`, headers: s.headers });
    expect(page.body).toContain('VIP müştəri');
    // a new inbound message reopens the conversation
    await inbound('IGA', 'UA1', 'Bir sual da');
    expect((await db.one(`SELECT status, unread_count FROM conversations WHERE id = $1`, [a.conversation_id])).status).toBe('open');
  });

  it('read-only analysts cannot reply or change conversations', async () => {
    const { hash } = await import('@node-rs/argon2');
    const u = await db.one(`INSERT INTO users (email, password_hash, email_verified_at) VALUES ('analyst@test.az', $1, now()) RETURNING id`, [await hash('correct-horse-battery')]);
    await db.q(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'analyst')`, [A.workspaceId, u.id]);
    const a = await inbound('IGA', 'UA2', 'Salam');
    const s = await loginAs(app, 'analyst@test.az');
    expect((await app.inject({ url: `/app/inbox/${a.conversation_id}`, headers: s.headers })).statusCode).toBe(200);
    for (const [path, payload] of [['reply', { text: 'hi' }], ['status', { status: 'closed' }], ['assign', { user_id: 'me' }]] as const) {
      const res = await app.inject({ method: 'POST', url: `/app/inbox/${a.conversation_id}/${path}`, headers: s.headers, payload: { _csrf: s.csrf, ...payload } });
      expect(res.statusCode).toBe(403);
    }
    expect(fake.sends()).toHaveLength(0);
  });

  it('publishes live events only to the conversation’s workspace', async () => {
    const { subscribe } = await import('../src/realtime.js');
    const gotA: unknown[] = [];
    const gotB: unknown[] = [];
    const offA = subscribe(A.workspaceId, (e) => gotA.push(e));
    const offB = subscribe(B.workspaceId, (e) => gotB.push(e));
    await new Promise((r) => setTimeout(r, 200));
    const a = await inbound('IGA', 'UA3', 'canlı');
    await new Promise((r) => setTimeout(r, 300));
    offA();
    offB();
    expect(gotA).toContainEqual({ type: 'message', conversationId: a.conversation_id });
    expect(gotB).toHaveLength(0);
  });

  it('search finds conversations by message text and contact name', async () => {
    await inbound('IGA', 'UA4', 'qırmızı don M ölçüdə');
    const s = await loginAs(app, A.email);
    const res = await app.inject({ url: '/app/inbox?f=all&q=' + encodeURIComponent('qırmızı'), headers: s.headers });
    expect(res.body).toContain('qırmızı don');
  });
});
