import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aiText, fake, igMessage, resetDb, seedWorkspace, startFake, stopFake } from './helpers.js';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_REDIS_URL;

describe('context selection (unit)', async () => {
  const { selectKnowledge, chooseRoute, planKnowledge } = await import('../src/context.js');
  const items = [
    { kind: 'price', title: 'Yay donu', body: 'Qiymət 45-65 AZN', keywords: ['don'] },
    { kind: 'delivery', title: 'Çatdırılma', body: 'Bakı daxili 3 AZN, 1 gün', keywords: ['çatdırılma', 'kuryer'] },
    { kind: 'forbidden', title: 'Siyasət', body: 'Siyasi mövzulara cavab vermə', keywords: [] },
    { kind: 'product', title: 'Kişi köynəyi', body: 'Pambıq köynək 30 AZN', keywords: ['köynək'] },
  ];
  it('sends only the relevant items (+ always-on rules) within the budget', () => {
    const k = selectKnowledge(items, 'Salam, yay donu neçəyədir?', 1500);
    expect(k).toContain('Yay donu');
    expect(k).toContain('Siyasət');
    expect(k).not.toContain('Kişi köynəyi');
    expect(k).not.toContain('Çatdırılma');
    expect(selectKnowledge(items, 'catdirilma necedir', 1500)).toContain('Bakı daxili'); // ə/ç-insensitive
    expect(selectKnowledge(items, 'don', 5)).not.toContain('Yay donu'); // over budget -> skipped
  });
  it('ignores words shared by most of a catalogue and caps the number of items', () => {
    const cat = Array.from({ length: 60 }, (_, i) => ({
      kind: 'price',
      title: `Don model ${i + 1}`,
      body: `Don model ${i + 1}: qiymət ${30 + i} AZN`,
      keywords: [`model ${i + 1}`],
    }));
    const k = selectKnowledge(cat, 'don model 17 qiyməti neçədir', 5000);
    expect(k).toContain('Don model 17:');
    expect(k.split('\n').length).toBeLessThanOrEqual(8);
  });
  it('pins a small knowledge base whole into the cached prefix, retrieves for a large one', () => {
    expect(planKnowledge(items, 'salam')).toMatchObject({ knowledge: '' });
    expect(planKnowledge(items, 'salam').pinned).toContain('Kişi köynəyi');
    const big = Array.from({ length: 400 }, (_, i) => ({ kind: 'price', title: `Məhsul ${i}`, body: 'x'.repeat(100), keywords: [`kod${i}`] }));
    const r = planKnowledge(big, 'kod7 var?');
    expect(r.pinned).toBe('');
    expect(r.knowledge).toContain('Məhsul 7:');
  });
  it('routes short simple questions to the fast model and sensitive/complex ones to the smart model', () => {
    expect(chooseRoute('Saat neçədə açıqsınız?', 2, 200)).toBe('fast');
    expect(chooseRoute('Sifarişim gəlmədi, pulu qaytarın', 2, 200)).toBe('smart');
    expect(chooseRoute('x'.repeat(300), 2, 200)).toBe('smart');
    expect(chooseRoute('Ölçü?', 25, 200)).toBe('smart');
  });
});

describe.skipIf(!enabled)('P3 analytics & AI cost controls (integration)', () => {
  let db: typeof import('../src/db.js');
  let ws: Awaited<ReturnType<typeof seedWorkspace>>;
  const T0 = new Date(Date.now() - 2 * 86400_000); // inside the default 7-day window
  const at = (s: number) => new Date(T0.getTime() + s * 1000);

  beforeAll(async () => {
    await startFake();
    db = await import('../src/db.js');
    await resetDb();
    ws = await seedWorkspace('an', 'IGX');
  });
  beforeEach(() => fake.reset());
  afterAll(async () => {
    await stopFake();
    const { closeQueues, redis } = await import('../src/queue.js');
    await closeQueues();
    redis.disconnect();
    await db.pool.end();
  });

  it('metrics match values recomputed by hand from the test data', async () => {
    const ct = await db.one(`INSERT INTO contacts (workspace_id, channel_id, external_id) VALUES ($1, $2, 'U1') RETURNING id`, [ws.workspaceId, ws.channelId]);
    const cv = await db.one(`INSERT INTO conversations (workspace_id, channel_id, external_user_id, contact_id) VALUES ($1, $2, 'U1', $3) RETURNING id`, [
      ws.workspaceId,
      ws.channelId,
      ct.id,
    ]);
    const msg = (dir: string, sender: string, status: string, t: Date) =>
      db.q(`INSERT INTO messages (workspace_id, conversation_id, direction, sender, body, status, created_at) VALUES ($1, $2, $3, $4, 'x', $5, $6)`, [
        ws.workspaceId,
        cv.id,
        dir,
        sender,
        status,
        t,
      ]);
    await msg('in', 'customer', 'received', at(0));
    await msg('out', 'ai', 'sent', at(60)); // 60 s response
    await msg('in', 'customer', 'received', at(1000));
    await msg('in', 'customer', 'received', at(1010)); // same customer turn
    await msg('out', 'human', 'sent', at(1300)); // 300 s from turn start
    await msg('out', 'bot', 'failed', at(1400));
    const a = await db.one(
      `INSERT INTO automations (workspace_id, name, trigger, status, config) VALUES ($1, 'C', 'comment', 'active', '{"media":{"scope":"all","ids":[]}}') RETURNING id`,
      [ws.workspaceId],
    );
    for (const [id, matched] of [
      ['c1', true],
      ['c2', true],
      ['c3', false],
    ] as const) {
      await db.q(`INSERT INTO ig_comments (id, workspace_id, channel_id, from_id, matched, received_at) VALUES ($1, $2, $3, 'U1', $4, $5)`, [
        id,
        ws.workspaceId,
        ws.channelId,
        matched,
        at(10),
      ]);
    }
    await db.q(
      `INSERT INTO automation_runs (workspace_id, automation_id, version, contact_id, conversation_id, trigger_ref, status, matched_at, attempted_at, sent_at, replied_at) VALUES
      ($1, $2, 1, $3, $4, 'comment:c1', 'sent', $5, $5, $5, $6), ($1, $2, 1, $3, $4, 'comment:c2', 'failed', $5, $5, NULL, NULL)`,
      [ws.workspaceId, a.id, ct.id, cv.id, at(20), at(900)],
    );
    await db.q(
      `INSERT INTO ai_usage (workspace_id, purpose, model, input_tokens, output_tokens, cache_read_tokens, est_cost_usd, outcome, created_at) VALUES
      ($1, 'reply', 'claude-opus-5-5', 1000, 100, 500, 0.0061, 'reply', $2), ($1, 'reply', 'claude-haiku-5-5', 800, 50, 0, 0.000105, 'timeout', $2)`,
      [ws.workspaceId, at(30)],
    );

    const A = await import('../src/analytics.js');
    const f = A.filterSchema.parse({});
    const w = await A.windowFor(ws.workspaceId, f);
    const o = await A.overview(ws.workspaceId, f, w);
    expect(o).toMatchObject({
      conversations: 1,
      new_conversations: 1,
      incoming: 3,
      outgoing: 2,
      ai_messages: 1,
      human_messages: 1,
      bot_messages: 0,
      failed_sends: 1,
      unique_contacts: 1,
      answered_turns: 2,
    });
    expect(o.median_response_s).toBe(180); // median of 60 and 300
    expect(o.avg_response_s).toBe(180);
    expect(o.automation).toEqual({ runs: 2, sent: 1, failed: 1, skipped: 0 });

    const days = await A.daily(ws.workspaceId, f, w);
    expect(days).toHaveLength(w.days);
    expect(days.reduce((s, d) => s + d.incoming, 0)).toBe(3);
    expect(days.reduce((s, d) => s + d.outgoing, 0)).toBe(2);

    const funnel = Object.fromEntries((await A.commentFunnel(ws.workspaceId, f, w)).map((s) => [s.key, s.value]));
    expect(funnel).toEqual({ received: 3, matched: 2, triggered: 2, attempted: 2, accepted: 1, delivered: null, replied: 1, clicked: 0, converted: null });

    const ai = await A.aiStats(ws.workspaceId, w);
    expect(ai).toMatchObject({ calls: 2, input: 1800, output: 150, cache_read: 500, timeouts: 1 });
    expect(ai.cost).toBeCloseTo(0.006205, 6);
  });

  it('estimated cost uses the configured price table', async () => {
    const { estimateCost } = await import('../src/aiconfig.js');
    // opus 5.5: $4 in / $20 out / $0.20 cache read per 1M
    expect(estimateCost('claude-opus-5-5', { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 500 })).toBeCloseTo(0.0061, 8);
    expect(estimateCost('unknown-model', { input_tokens: 1000, output_tokens: 100 })).toBe(0);
  });

  it('stops calling the AI when the workspace budget is spent, and hands over to staff', async () => {
    const pipeline = await import('../src/pipeline.js');
    const { parseInstagramWebhook } = await import('../src/channels/instagram.js');
    await db.q(`UPDATE workspaces SET limit_overrides = '{"ai_budget_usd_day": 0.001}' WHERE id = $1`, [ws.workspaceId]);
    await db.q(`INSERT INTO ai_usage (workspace_id, purpose, model, est_cost_usd, outcome) VALUES ($1, 'reply', 'claude-opus-5-5', 0.01, 'reply')`, [
      ws.workspaceId,
    ]);
    for (const ev of parseInstagramWebhook(igMessage('IGX', 'U9', 'bud.1', 'Salam'))) await pipeline.ingest(ev);
    const m = await db.one(`SELECT id, conversation_id FROM messages WHERE external_id = 'bud.1'`);
    await pipeline.processReply(m.conversation_id, m.id);
    expect(fake.aiCalls()).toHaveLength(0);
    expect((await db.one(`SELECT needs_human FROM conversations WHERE id = $1`, [m.conversation_id])).needs_human).toBe(true);
    expect((await db.one(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'ai.budget_exceeded'`)).n).toBe(1);
    await db.q(`UPDATE workspaces SET limit_overrides = '{}' WHERE id = $1`, [ws.workspaceId]);
  });

  it('throttles AI calls above the per-workspace rate limit', async () => {
    const pipeline = await import('../src/pipeline.js');
    const { redis } = await import('../src/queue.js');
    const { parseInstagramWebhook } = await import('../src/channels/instagram.js');
    for (const ev of parseInstagramWebhook(igMessage('IGX', 'U8', 'rpm.1', 'Salam'))) await pipeline.ingest(ev);
    const m = await db.one(`SELECT id, conversation_id FROM messages WHERE external_id = 'rpm.1'`);
    await redis.set(`airpm:${ws.workspaceId}:${Math.floor(Date.now() / 60_000)}`, '1000', 'EX', 120);
    expect(await pipeline.processReply(m.conversation_id, m.id)).toBe('throttled');
    expect(fake.aiCalls()).toHaveLength(0);
    await redis.del(`airpm:${ws.workspaceId}:${Math.floor(Date.now() / 60_000)}`);
  });

  it('long conversations: older turns are folded into a summary and not resent', async () => {
    const { buildContext, updateSummary } = await import('../src/context.js');
    const ct = await db.one(`INSERT INTO contacts (workspace_id, channel_id, external_id) VALUES ($1, $2, 'U7') RETURNING id`, [ws.workspaceId, ws.channelId]);
    const cv = await db.one(`INSERT INTO conversations (workspace_id, channel_id, external_user_id, contact_id) VALUES ($1, $2, 'U7', $3) RETURNING id`, [
      ws.workspaceId,
      ws.channelId,
      ct.id,
    ]);
    for (let i = 0; i < 30; i++) {
      await db.q(
        `INSERT INTO messages (workspace_id, conversation_id, direction, sender, body, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(mins => $7))`,
        [ws.workspaceId, cv.id, i % 2 ? 'out' : 'in', i % 2 ? 'ai' : 'customer', `mesaj ${i} ${'uzun mətn '.repeat(20)}`, i % 2 ? 'sent' : 'received', 60 - i],
      );
    }
    const before = await buildContext(cv.id, ws.workspaceId);
    expect(before.history.length).toBeLessThan(30); // token budget already trims
    fake.handler = (_b, path) => (path === '/v1/messages' ? aiText('Müştəri M ölçü don istəyir; ünvanı Nərimanov.') : undefined);
    await updateSummary(cv.id, ws.workspaceId);
    const after = await buildContext(cv.id, ws.workspaceId);
    expect(after.extra.summary).toContain('M ölçü');
    expect(after.unsummarized).toBeLessThan(before.unsummarized);
    const call = fake.aiCalls()[0]!;
    expect(call.body.model).toBe('claude-haiku-5-5'); // summaries use the fast route
    expect(call.body.fallbacks).toBeUndefined(); // not supported on Haiku
    expect((await db.one(`SELECT count(*)::int AS n FROM ai_usage WHERE purpose = 'summary'`)).n).toBe(1);
  });

  it('pins a small knowledge base into the cached prefix, byte-identical across conversations', async () => {
    const pipeline = await import('../src/pipeline.js');
    const { parseInstagramWebhook } = await import('../src/channels/instagram.js');
    await db.q(
      `INSERT INTO knowledge_items (workspace_id, kind, title, body, keywords) VALUES ($1, 'price', 'Yay donu', 'Qiymət 45 AZN', '{don}'), ($1, 'product', 'Köynək', 'Köynək 30 AZN', '{köynək}')`,
      [ws.workspaceId],
    );
    for (const [user, mid, text] of [
      ['U6', 'ctx.1', 'Don neçəyədir?'],
      ['U5', 'ctx.2', 'Köynək var?'],
    ]) {
      for (const ev of parseInstagramWebhook(igMessage('IGX', user, mid, text))) await pipeline.ingest(ev);
      const m = await db.one(`SELECT id, conversation_id FROM messages WHERE external_id = $1`, [mid]);
      await pipeline.processReply(m.conversation_id, m.id);
    }
    const [body, body2] = fake.aiCalls().map((c) => c.body);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[0].text).toContain('Qiymət 45 AZN');
    expect(body.system[0].text).toContain('Köynək 30 AZN');
    expect(body2.system[0].text).toBe(body.system[0].text); // same cached prefix for every conversation
    expect(body.model).toBe('claude-haiku-5-5'); // short simple question
    expect(body.max_tokens).toBe(2000);
  });
});
