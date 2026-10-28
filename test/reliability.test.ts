import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aiText, fake, igMessage, migrationFiles, resetDb, seedWorkspace, startFake, stopFake } from './helpers.js';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_REDIS_URL;

describe.skipIf(!enabled)('P0 reliability (integration)', () => {
  let db: typeof import('../src/db.js');
  let pipeline: typeof import('../src/pipeline.js');
  let ws: Awaited<ReturnType<typeof seedWorkspace>>;
  let n = 0;

  /** Stores one inbound Instagram message through the real ingest path; returns its conversation and message ids. */
  async function inbound(text: string, from = 'U1') {
    const mid = `m.${++n}`;
    const { parseInstagramWebhook } = await import('../src/channels/instagram.js');
    for (const ev of parseInstagramWebhook(igMessage('IG1', from, mid, text))) await pipeline.ingest(ev);
    const row = await db.one(`SELECT id, conversation_id FROM messages WHERE external_id = $1`, [mid]);
    return { conversationId: row.conversation_id as string, messageId: row.id as string };
  }
  const outbound = async (conversationId: string) => {
    const { openRows } = await import('../src/messages.js');
    return openRows(
      await db.q(`SELECT sender, status, body, enc, error FROM messages WHERE conversation_id = $1 AND direction = 'out' ORDER BY created_at`, [
        conversationId,
      ]),
    ).map(({ enc, ...m }) => m);
  };

  beforeAll(async () => {
    await startFake();
    db = await import('../src/db.js');
    pipeline = await import('../src/pipeline.js');
    await resetDb();
    ws = await seedWorkspace('rel', 'IG1');
  });
  beforeEach(async () => {
    fake.reset();
    await db.q(`UPDATE channels SET status = 'active'`);
    await db.q(`DELETE FROM conversations`);
  });
  afterAll(async () => {
    await stopFake();
    const { closeQueues, redis } = await import('../src/queue.js');
    await closeQueues();
    redis.disconnect();
    await db.pool.end();
  });

  it('applies every migration on an empty database', async () => {
    const tables = await db.q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    expect(tables.map((t) => t.tablename)).toEqual(expect.arrayContaining(['messages', 'ai_usage', 'channel_events', 'audit_log']));
    expect(migrationFiles().length).toBeGreaterThanOrEqual(5);
  });

  it('stores a duplicate webhook once and queues one reply job', async () => {
    const { parseInstagramWebhook } = await import('../src/channels/instagram.js');
    const body = igMessage('IG1', 'U9', 'dup.1', 'Salam');
    for (let i = 0; i < 2; i++) for (const ev of parseInstagramWebhook(body)) await pipeline.ingest(ev);
    const rows = await db.q(`SELECT id FROM messages WHERE external_id = 'dup.1'`);
    expect(rows).toHaveLength(1);
    const { queue } = await import('../src/queue.js');
    const jobs = (await queue.getJobs(['delayed', 'waiting'])).filter((j) => (j.data as any).messageId === rows[0]!.id);
    expect(jobs).toHaveLength(1);
  });

  it('two workers on the same message send exactly one DM', async () => {
    const { conversationId, messageId } = await inbound('Don neçəyədir?');
    const results = await Promise.all([pipeline.processReply(conversationId, messageId), pipeline.processReply(conversationId, messageId)]);
    // One runs, the other is told the conversation is busy (the worker re-queues it) — then the re-run is a no-op.
    expect(results.sort()).toEqual(['busy', 'done']);
    await pipeline.processReply(conversationId, messageId);
    expect(fake.sends()).toHaveLength(1);
    expect(fake.aiCalls()).toHaveLength(1);
    expect((await outbound(conversationId)).map((m) => m.status)).toEqual(['sent']);
  });

  it('expired token: message is not marked sent and the channel needs re-authorization', async () => {
    const { conversationId, messageId } = await inbound('Salam');
    fake.handler = (_b, path) =>
      path.endsWith('/messages') && !path.startsWith('/v1')
        ? { status: 401, json: { error: { code: 190, message: 'Error validating access token' } } }
        : undefined;
    await expect(pipeline.processReply(conversationId, messageId)).rejects.toMatchObject({ reason: 'token_invalid', retryable: false });
    expect((await outbound(conversationId)).map((m) => m.status)).toEqual(['failed']);
    const ch = await db.one(`SELECT status, status_reason FROM channels WHERE id = $1`, [ws.channelId]);
    expect(ch.status).toBe('reauth_required');
    expect((await db.one(`SELECT count(*)::int AS n FROM channel_events WHERE kind = 'token_invalid'`)).n).toBe(1);
  });

  it('rate limit: retry re-sends the stored reply without a second AI call', async () => {
    const { conversationId, messageId } = await inbound('Ünvan?');
    let first = true;
    fake.handler = (_b, path) => {
      if (path.endsWith('/messages') && !path.startsWith('/v1') && first) {
        first = false;
        return { status: 400, json: { error: { code: 4, message: 'Application request limit reached' } } };
      }
    };
    await expect(pipeline.processReply(conversationId, messageId)).rejects.toMatchObject({ reason: 'rate_limited', retryable: true });
    await pipeline.processReply(conversationId, messageId); // BullMQ retry
    expect(fake.aiCalls()).toHaveLength(1);
    expect(fake.sends()).toHaveLength(2);
    expect((await outbound(conversationId)).map((m) => m.status)).toEqual(['sent']);
  });

  it('Claude failure: retried while attempts remain, then handed to staff (no silent drop, no invented reply)', async () => {
    const { conversationId, messageId } = await inbound('Sabah açıqsınız?');
    fake.handler = (_b, path) =>
      path === '/v1/messages' ? { status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } } : undefined;
    await expect(pipeline.processReply(conversationId, messageId, false)).rejects.toBeTruthy();
    expect(fake.sends()).toHaveLength(0);
    await pipeline.processReply(conversationId, messageId, true);
    const conv = await db.one(`SELECT needs_human FROM conversations WHERE id = $1`, [conversationId]);
    expect(conv.needs_human).toBe(true);
    const out = await outbound(conversationId);
    expect(out).toHaveLength(1); // only the configured holding message
    expect(out[0]!.body).toBe((await db.one(`SELECT handoff_message FROM assistants WHERE workspace_id = $1`, [ws.workspaceId])).handoff_message);
    expect((await db.one(`SELECT count(*)::int AS n FROM ai_usage WHERE outcome IN ('error', 'timeout')`)).n).toBeGreaterThan(0);
  });

  it('bot stays silent while staff handles the conversation', async () => {
    const { conversationId, messageId } = await inbound('Sual');
    await db.q(`UPDATE conversations SET ai_paused_until = now() + interval '1 hour' WHERE id = $1`, [conversationId]);
    await pipeline.processReply(conversationId, messageId);
    await db.q(`UPDATE conversations SET ai_paused_until = NULL, needs_human = true WHERE id = $1`, [conversationId]);
    await pipeline.processReply(conversationId, messageId);
    expect(fake.sends()).toHaveLength(0);
    expect(fake.aiCalls()).toHaveLength(0);
  });

  it('records AI token usage and estimated cost for every reply', async () => {
    fake.handler = (_b, path) => (path === '/v1/messages' ? aiText('45 AZN') : undefined);
    const { conversationId, messageId } = await inbound('Qiymət?');
    await pipeline.processReply(conversationId, messageId);
    const u = await db.one(
      `SELECT input_tokens, output_tokens, cache_read_tokens, est_cost_usd::float AS cost, outcome FROM ai_usage WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(u).toMatchObject({ input_tokens: 1200, output_tokens: 40, cache_read_tokens: 900, outcome: 'reply' });
    expect(u.cost).toBeGreaterThan(0);
  });

  it('never puts access tokens or app secrets into error messages', async () => {
    const { graph } = await import('../src/channels/graph.js');
    fake.handler = () => ({ status: 400, json: { error: { code: 100, message: 'bad request' } } });
    const err = await graph('http://127.0.0.1:4011', '/v24.0/me', { token: 'ig-token-SECRET', query: { client_secret: 'app-SECRET' } }).catch((e) => e);
    expect(String(err.message)).not.toMatch(/SECRET/);
    expect(JSON.stringify(err)).not.toMatch(/SECRET/);
  });

  it('webhook signature uses the raw body (tampered payload rejected)', () => {
    const body = JSON.stringify(igMessage('IG1', 'U1', 'x', 'hi'));
    const sig = 'sha256=' + createHmac('sha256', 'test-meta-secret').update(body).digest('hex');
    return import('../src/crypto.js').then(({ verifyMetaSignature }) => {
      expect(verifyMetaSignature(Buffer.from(body), sig, ['test-meta-secret'])).toBe(true);
      expect(verifyMetaSignature(Buffer.from(body.replace('hi', 'ha')), sig, ['test-meta-secret'])).toBe(false);
    });
  });
  // Runs last in this file: it rebuilds the schema.
  it('every rollback file reverses its migration and the migration re-applies cleanly (up → down → up)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const tables = async () => (await db.q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((t) => t.tablename);
    const before = await tables();
    const downs = readdirSync('migrations/down')
      .filter((f) => f.endsWith('.down.sql'))
      .sort()
      .reverse();
    expect(downs.length).toBeGreaterThanOrEqual(6);
    for (const f of downs) await db.pool.query(readFileSync(`migrations/down/${f}`, 'utf8'));
    const after = await tables();
    for (const t of ['ai_usage', 'automations', 'plans', 'conversation_notes', 'knowledge_items', 'webhooks']) expect(after).not.toContain(t);
    for (const f of downs.map((d) => d.replace('.down.sql', '.sql')).reverse()) await db.pool.query(readFileSync(`migrations/${f}`, 'utf8'));
    expect(await tables()).toEqual(before);
  });
});
