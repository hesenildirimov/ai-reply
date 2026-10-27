// Webhook intake (fast ack, Redis fallback) and reliable echo identification.
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drainInbound, fake, igMessage, resetDb, seedWorkspace, startFake, stopFake } from './helpers.js';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_REDIS_URL;
const sign = (body: string) => `sha256=${createHmac('sha256', 'test-meta-secret').update(body).digest('hex')}`;
const metaSends = () => fake.calls.filter((c) => /\/messages$/.test(c.path) && !c.path.startsWith('/v1/'));

describe.skipIf(!enabled)('webhook intake and echoes (integration)', () => {
  let db: typeof import('../src/db.js');
  let pipeline: typeof import('../src/pipeline.js');
  let queues: typeof import('../src/queue.js');
  let intake: typeof import('../src/inbound.js');
  let app: import('fastify').FastifyInstance;
  let ws: Awaited<ReturnType<typeof seedWorkspace>>;
  let n = 0;
  let decrypt: (s: string) => string;

  const post = (url: string, payload: string) => app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload) }, payload });
  const waBody = (mid: string, text: string) =>
    JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, contacts: [{ wa_id: '99450', profile: { name: 'Aysel' } }], messages: [{ from: '99450', id: mid, type: 'text', text: { body: text } }] } }] }] });
  /** New customer per call (own conversation); returns their id as `user`. */
  async function inbound(text: string) {
    const mid = `e.${++n}`;
    const from = `E${n}`;
    const { parseInstagramWebhook } = await import('../src/channels/instagram.js');
    for (const ev of parseInstagramWebhook(igMessage('IGE', from, mid, text))) await pipeline.ingest(ev);
    const row = await db.one(`SELECT id, conversation_id FROM messages WHERE external_id = $1`, [mid]);
    return { conversationId: row.conversation_id as string, messageId: row.id as string, user: from };
  }
  const conv = (id: string) => db.one(`SELECT ai_paused_until > now() AS paused FROM conversations WHERE id = $1`, [id]);
  const outbound = async (id: string) =>
    (await db.q(`SELECT sender, status, external_id, body, enc FROM messages WHERE conversation_id = $1 AND direction = 'out' ORDER BY created_at`, [id])).map(({ enc, ...m }) => ({ ...m, body: enc ? decrypt(m.body) : m.body }));

  beforeAll(async () => {
    await startFake();
    db = await import('../src/db.js');
    pipeline = await import('../src/pipeline.js');
    queues = await import('../src/queue.js');
    intake = await import('../src/inbound.js');
    ({ decrypt } = await import('../src/crypto.js'));
    await resetDb();
    ws = await seedWorkspace('intake', 'IGE');
    const { encrypt } = await import('../src/crypto.js');
    await db.q(`INSERT INTO channels (workspace_id, type, external_id, waba_id, display_name, access_token_enc) VALUES ($1, 'whatsapp', 'PN1', 'WABA1', 'WA', $2)`, [ws.workspaceId, encrypt('wa-token')]);
    app = await (await import('../src/server.js')).buildServer();
  });
  beforeEach(async () => {
    fake.reset();
    intake.resetIntake();
    await queues.inboundQueue.drain(true);
  });
  afterAll(async () => {
    await app.close();
    await stopFake();
    (await import('../src/realtime.js')).closeRealtime();
    await queues.closeQueues();
    queues.redis.disconnect();
    await db.pool.end();
  });

  describe('#7 webhook returns before any slow work', () => {
    it('acks a WhatsApp webhook without calling Meta; storing, read receipt and reply run as separate jobs', async () => {
      fake.handler = () => ({ delayMs: 3000, json: { success: true } }); // Meta answers slowly
      const t = Date.now();
      const res = await post('/webhooks/whatsapp', waBody('wamid.fast1', 'Salam'));
      expect(res.statusCode).toBe(200);
      expect(Date.now() - t).toBeLessThan(1000);
      expect(fake.calls).toHaveLength(0); // no Graph call inside the request
      expect((await db.one(`SELECT count(*)::int AS n FROM messages WHERE external_id = 'wamid.fast1'`)).n).toBe(0); // not yet: queued

      await drainInbound();
      const msg = await db.one(`SELECT id FROM messages WHERE external_id = 'wamid.fast1'`);
      expect(msg).toBeTruthy();
      const jobs = await queues.inboundQueue.getJobs(['waiting']);
      expect(jobs.filter((j) => j.data.kind === 'wa_read')).toHaveLength(1); // read receipt: own job, not inline
      expect(fake.calls).toHaveLength(0);
      const replies = (await queues.queue.getJobs(['delayed', 'waiting'])).filter((j) => (j.data as any).messageId === msg.id);
      expect(replies).toHaveLength(1);
    });

    it('collapses Meta re-deliveries of the same event into one intake job', async () => {
      const body = waBody('wamid.dup', 'Salam');
      await Promise.all([1, 2, 3].map(() => post('/webhooks/whatsapp', body)));
      expect((await queues.inboundQueue.getJobs(['waiting'])).filter((j) => j.data.kind === 'inbound')).toHaveLength(1);
    });

    it('Redis unavailable: the webhook is still accepted (Postgres outbox) and processed once Redis is back', async () => {
      const real = queues.inboundQueue.addBulk.bind(queues.inboundQueue);
      queues.inboundQueue.addBulk = (() => new Promise(() => {})) as never; // Redis hangs (ioredis offline queue)
      try {
        const t = Date.now();
        expect((await post('/webhooks/whatsapp', waBody('wamid.out1', 'Redis yoxdur'))).statusCode).toBe(200);
        expect(Date.now() - t).toBeLessThan(2500); // bounded wait, then outbox
        // Breaker open: the next webhook goes straight to the outbox without waiting.
        const t2 = Date.now();
        expect((await post('/webhooks/whatsapp', waBody('wamid.out2', 'yenə'))).statusCode).toBe(200);
        expect(Date.now() - t2).toBeLessThan(300);
        expect((await post('/webhooks/whatsapp', waBody('wamid.out2', 'yenə'))).statusCode).toBe(200); // re-delivery
      } finally {
        queues.inboundQueue.addBulk = real;
      }
      expect((await db.one(`SELECT count(*)::int AS n FROM inbound_outbox`)).n).toBe(2);
      expect(await intake.drainOutbox()).toBe(2);
      expect((await db.one(`SELECT count(*)::int AS n FROM inbound_outbox`)).n).toBe(0);
      await drainInbound();
      expect((await db.one(`SELECT count(*)::int AS n FROM messages WHERE external_id IN ('wamid.out1', 'wamid.out2')`)).n).toBe(2);
    });

    it('Redis and Postgres both failing: 500 so Meta retries', async () => {
      const real = queues.inboundQueue.addBulk.bind(queues.inboundQueue);
      queues.inboundQueue.addBulk = (() => Promise.reject(new Error('down'))) as never;
      await db.q(`ALTER TABLE inbound_outbox RENAME TO inbound_outbox_off`);
      try {
        expect((await post('/webhooks/whatsapp', waBody('wamid.dead', 'x'))).statusCode).toBe(500);
      } finally {
        queues.inboundQueue.addBulk = real;
        await db.q(`ALTER TABLE inbound_outbox_off RENAME TO inbound_outbox`);
      }
    });
  });

  describe('#10 Redis outage behaviour', () => {
    it('readiness stays OK (degraded) without Redis: webhooks use the outbox, staff keep working', async () => {
      const real = queues.redis.ping.bind(queues.redis);
      queues.redis.ping = (() => Promise.reject(new Error('down'))) as never;
      try {
        const r = await app.inject({ url: '/readyz' });
        expect(r.statusCode).toBe(200);
        expect(r.json()).toEqual({ ok: true, degraded: true });
      } finally {
        queues.redis.ping = real;
      }
      expect((await app.inject({ url: '/readyz' })).json()).toEqual({ ok: true });
    });

    it('re-queues replies whose jobs were lost with Redis data, never twice and never after an answer', async () => {
      const { requeueStranded } = await import('../src/jobs.js');
      const lost = await inbound('Cavab gəlmədi');
      const answered = await inbound('Cavab gəldi');
      await pipeline.processReply(answered.conversationId, answered.messageId);
      await db.q(`UPDATE conversations SET last_inbound_at = now() - interval '10 minutes' WHERE id = ANY($1)`, [[lost.conversationId, answered.conversationId]]);
      await db.q(`UPDATE messages SET created_at = now() - interval '10 minutes' WHERE id = ANY($1)`, [[lost.messageId, answered.messageId]]);
      await queues.queue.drain(true); // Redis lost its jobs
      expect(await requeueStranded()).toBe(1);
      expect(await queues.queue.getJob(`reply-${lost.messageId}`)).toBeTruthy();
      expect(await requeueStranded()).toBe(0); // job exists now
      await pipeline.processReply(lost.conversationId, lost.messageId);
      expect((await outbound(lost.conversationId)).filter((m) => m.sender === 'ai')).toHaveLength(1);
    });
  });

  describe('#6 own messages are identified by state, not by a timing window', () => {
    it('echo processed while our AI reply is still in flight (Meta slow) is recognised as ours: AI is not paused', async () => {
      const { conversationId, messageId, user } = await inbound('Don var?');
      fake.handler = (_b, path) => (path.endsWith('/IGE/messages') ? { delayMs: 400, json: { message_id: 'mid.race' } } : undefined);
      const reply = pipeline.processReply(conversationId, messageId);
      // The echo overtakes the send API's response: our row exists ('pending') but has no Meta id yet.
      for (let i = 0; i < 50 && !(await outbound(conversationId)).length; i++) await new Promise((r) => setTimeout(r, 20));
      const [pending] = await outbound(conversationId);
      expect(pending).toMatchObject({ status: 'pending', external_id: null });
      expect(await pipeline.processEcho(ws.channelId, user, 'mid.race', pending.body, false)).toBe('done');
      await reply;
      expect((await conv(conversationId)).paused).toBeFalsy();
      expect(await outbound(conversationId)).toEqual([expect.objectContaining({ sender: 'ai', status: 'sent', external_id: 'mid.race' })]);
    });

    it('echo after the send completed (id known) is ours', async () => {
      const { conversationId, messageId, user } = await inbound('Ünvan?');
      await pipeline.processReply(conversationId, messageId);
      const [sent] = await outbound(conversationId);
      expect(await pipeline.processEcho(ws.channelId, user, sent.external_id, sent.body, true)).toBe('done');
      expect((await conv(conversationId)).paused).toBeFalsy();
      expect(await outbound(conversationId)).toHaveLength(1);
    });

    it('unknown echo while one of our sends is in flight waits instead of guessing; then counts as staff', async () => {
      const { conversationId, user } = await inbound('Salam');
      await db.q(`INSERT INTO messages (workspace_id, conversation_id, direction, sender, body, status, idempotency_key) VALUES ($1, $2, 'out', 'ai', 'AI mətni', 'pending', 'k-wait')`, [ws.workspaceId, conversationId]);
      expect(await pipeline.processEcho(ws.channelId, user, 'mid.staff1', 'Əməkdaş yazdı', false)).toBe('wait');
      expect((await conv(conversationId)).paused).toBeFalsy();
      // Our send finished with its own id: the echo is not ours -> staff.
      await db.q(`UPDATE messages SET status = 'sent', external_id = 'mid.ai1' WHERE idempotency_key = 'k-wait'`);
      expect(await pipeline.processEcho(ws.channelId, user, 'mid.staff1', 'Əməkdaş yazdı', false)).toBe('done');
      expect((await conv(conversationId)).paused).toBe(true);
      expect((await outbound(conversationId)).map((m) => m.sender)).toEqual(['ai', 'human']);
    });

    it('staff message in the Instagram app (no send of ours) pauses the AI right away', async () => {
      const { conversationId, user } = await inbound('Sual');
      expect(await pipeline.processEcho(ws.channelId, user, 'mid.staff2', 'Bəli, var', false)).toBe('done');
      expect((await conv(conversationId)).paused).toBe(true);
      // Re-delivered echo: stored once.
      expect(await pipeline.processEcho(ws.channelId, user, 'mid.staff2', 'Bəli, var', false)).toBe('done');
      expect((await outbound(conversationId)).filter((m) => m.sender === 'human')).toHaveLength(1);
    });

    it('a send that timed out ("unknown") is confirmed by its echo instead of being taken for staff', async () => {
      const { conversationId, messageId, user } = await inbound('Qiymət?');
      fake.handler = (_b, path) => (path.endsWith('/IGE/messages') ? { drop: true } : undefined); // request sent, answer lost
      await pipeline.processReply(conversationId, messageId).catch(() => {});
      const [row] = await outbound(conversationId);
      expect(row.status).toBe('unknown');
      expect(await pipeline.processEcho(ws.channelId, user, 'mid.late', row.body, true)).toBe('done');
      expect(await outbound(conversationId)).toEqual([expect.objectContaining({ sender: 'ai', status: 'sent', external_id: 'mid.late' })]);
      expect((await conv(conversationId)).paused).toBeFalsy();
      expect(metaSends()).toHaveLength(1); // never re-sent
    });
  });
});
