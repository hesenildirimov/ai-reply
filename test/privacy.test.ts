// Message text at rest: encrypted, searchable through the blind index, legacy rows sealed, key rotation covered.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fake, igMessage, loginAs, resetDb, seedWorkspace, startFake, stopFake } from './helpers.js';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_REDIS_URL;
const MARK = 'Gizli 0501234567 ünvan Nizami küçəsi';

describe.skipIf(!enabled)('message encryption at rest (integration)', () => {
  let db: typeof import('../src/db.js');
  let pipeline: typeof import('../src/pipeline.js');
  let app: import('fastify').FastifyInstance;
  let ws: Awaited<ReturnType<typeof seedWorkspace>>;
  let owner: Awaited<ReturnType<typeof loginAs>>;
  let n = 0;

  async function inbound(text: string) {
    const mid = `p.${++n}`;
    const { parseInstagramWebhook } = await import('../src/channels/instagram.js');
    for (const ev of parseInstagramWebhook(igMessage('IGP', `P${n}`, mid, text))) await pipeline.ingest(ev);
    const row = await db.one(`SELECT id, conversation_id FROM messages WHERE external_id = $1`, [mid]);
    return { conversationId: row.conversation_id as string, messageId: row.id as string };
  }
  /** Conversation ids the inbox list shows for a search. */
  const search = async (term: string) => [...(await app.inject({ url: `/app/inbox?f=all&q=${encodeURIComponent(term)}`, headers: owner.headers })).body.matchAll(/data-conv="([0-9a-f-]{36})"/g)].map((m) => m[1]);

  beforeAll(async () => {
    await startFake();
    db = await import('../src/db.js');
    pipeline = await import('../src/pipeline.js');
    await resetDb();
    ws = await seedWorkspace('priv', 'IGP');
    await db.q(`INSERT INTO webhooks (workspace_id, url, secret_enc, events) VALUES ($1, 'https://hooks.example.com/x', $2, '{message.received}')`, [ws.workspaceId, (await import('../src/crypto.js')).encrypt('s')]);
    app = await (await import('../src/server.js')).buildServer();
    owner = await loginAs(app, ws.email);
  });
  afterAll(async () => {
    await app.close();
    await stopFake();
    (await import('../src/realtime.js')).closeRealtime();
    const { closeQueues, redis } = await import('../src/queue.js');
    await closeQueues();
    redis.disconnect();
    await db.pool.end();
  });

  it('no message text in the database: messages, AI reply, summary and webhook payloads are ciphertext', async () => {
    fake.reset();
    const { conversationId, messageId } = await inbound(MARK);
    await pipeline.processReply(conversationId, messageId);
    await db.q(`UPDATE conversations SET summary = $2 WHERE id = $1`, [conversationId, (await import('../src/messages.js')).sealText(`Müştəri: ${MARK}`)]);
    const leaks = await db.one(
      `SELECT (SELECT count(*) FROM messages WHERE body ILIKE '%0501234567%' OR body ILIKE '%Salam!%')::int AS messages,
              (SELECT count(*) FROM conversations WHERE summary ILIKE '%0501234567%')::int AS summaries,
              (SELECT count(*) FROM webhook_deliveries WHERE payload::text ILIKE '%0501234567%')::int AS payloads,
              (SELECT count(*) FROM messages WHERE NOT enc)::int AS plaintext_rows`,
    );
    expect(leaks).toEqual({ messages: 0, summaries: 0, payloads: 0, plaintext_rows: 0 });
    // ...yet staff, the AI and integrations see the text.
    const page = (await app.inject({ url: `/app/inbox/${conversationId}`, headers: owner.headers })).body;
    expect(page).toContain('0501234567');
    expect(page).toContain('Salam! Bəli, var.');
    expect(JSON.stringify(fake.aiCalls()[0]!.body)).toContain('0501234567');
  });

  it('inbox search finds encrypted messages by word and word beginning (diacritics-insensitive)', async () => {
    const { conversationId } = await inbound('Çatdırılma Gəncəyə neçəyədir?');
    const other = (await inbound('Ölçü M var?')).conversationId;
    for (const term of ['Çatdırılma', 'çatdır', 'catdirilma', 'gəncə', 'GENCEYE', 'çatdırılma gəncəyə']) expect(await search(term)).toContain(conversationId);
    expect(await search('çatdırılma ölçü')).toEqual([]); // every word must match
    expect(await search('ölçü')).toEqual([other]);
    expect(await search('xyzabc')).toEqual([]);
  });

  it('rows stored before encryption keep working and are sealed by maintenance', async () => {
    const { conversationId } = await inbound('yeni');
    const legacy = await db.one(`INSERT INTO messages (workspace_id, conversation_id, direction, sender, body, status) VALUES ($1, $2, 'in', 'customer', 'köhnə mesaj Sumqayıt', 'received') RETURNING id`, [ws.workspaceId, conversationId]);
    await db.q(`UPDATE conversations SET summary = 'köhnə xülasə' WHERE id = $1`, [conversationId]);
    expect((await app.inject({ url: `/app/inbox/${conversationId}`, headers: owner.headers })).body).toContain('köhnə mesaj Sumqayıt');
    const { sealLegacyMessages } = await import('../src/jobs.js');
    expect(await sealLegacyMessages()).toBe(1);
    const row = await db.one(`SELECT body, enc, cardinality(search_tokens) AS t FROM messages WHERE id = $1`, [legacy.id]);
    expect(row.enc).toBe(true);
    expect(row.body).toMatch(/^v1:/);
    expect(row.t).toBeGreaterThan(0);
    expect((await db.one(`SELECT summary FROM conversations WHERE id = $1`, [conversationId])).summary).toMatch(/^v1:/);
    expect((await app.inject({ url: `/app/inbox/${conversationId}`, headers: owner.headers })).body).toContain('köhnə mesaj Sumqayıt');
    expect(await search('sumqay')).toContain(conversationId);
  });

  it('key rotation re-encrypts and re-indexes message text; then only the new key is needed', async () => {
    const { conversationId } = await inbound('Rotasiya testi Lənkəran');
    const K1 = process.env.ENCRYPTION_KEY!;
    const K2 = Buffer.alloc(32, 9).toString('base64');
    const before = await db.one(`SELECT body FROM messages WHERE conversation_id = $1 AND direction = 'in'`, [conversationId]);
    try {
      // New process view: K2 current, K1 previous (what an operator sets during rotation).
      Object.assign(process.env, { ENCRYPTION_KEY: K2, ENCRYPTION_KEY_PREVIOUS: K1 });
      vi.resetModules();
      const jobs = await import('../src/jobs.js');
      const freshDb = await import('../src/db.js');
      await jobs.reencryptSecrets();
      await freshDb.pool.end();
      const fq = await import('../src/queue.js');
      await fq.closeQueues();
      fq.redis.disconnect();

      // Only K2 now.
      process.env.ENCRYPTION_KEY_PREVIOUS = '';
      vi.resetModules();
      const crypto2 = await import('../src/crypto.js');
      const msgs2 = await import('../src/messages.js');
      const after = await db.one(`SELECT body, search_tokens FROM messages WHERE conversation_id = $1 AND direction = 'in'`, [conversationId]);
      expect(after.body).not.toBe(before.body);
      expect(crypto2.decrypt(after.body)).toBe('Rotasiya testi Lənkəran');
      expect(after.search_tokens).toEqual(expect.arrayContaining(msgs2.queryTokens('lənkəran')[0]!));
      expect((await db.one(`SELECT count(*)::int AS n FROM app_meta WHERE key = 'msg_rotation_cursor'`)).n).toBe(0);
    } finally {
      Object.assign(process.env, { ENCRYPTION_KEY: K1, ENCRYPTION_KEY_PREVIOUS: '' });
      vi.resetModules();
    }
  });
});
