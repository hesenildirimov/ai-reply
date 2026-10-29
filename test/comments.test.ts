// AI answers to Instagram comments (src/comments.ts): triage, DM via the reply pipeline, public reply, approval.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aiText, createAutomation, fake, igMessage, loginAs, resetDb, seedWorkspace, startFake, stopFake } from './helpers.js';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_REDIS_URL;

const triage = (category: string, publicReply = 'Salam! Ətraflı məlumatı DM-ə yazdıq 🙏', publicInvite = 'Salam! Zəhmət olmasa bizə DM yazın 🙏') => ({
  json: {
    id: 'msg_tr',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'tu_1', name: 'comment_triage', input: { category, public_reply: publicReply, public_invite: publicInvite } }],
    usage: { input_tokens: 400, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
});

describe.skipIf(!enabled)('AI answers to Instagram comments', () => {
  let db: typeof import('../src/db.js');
  let engine: typeof import('../src/automations/engine.js');
  let pipeline: typeof import('../src/pipeline.js');
  let comments: typeof import('../src/comments.js');
  let app: import('fastify').FastifyInstance;
  let ws: Awaited<ReturnType<typeof seedWorkspace>>;
  let n = 0;
  // What the fake Claude answers: the triage call (forced comment_triage tool) and the DM reply.
  let triageReply = triage('question');
  let dmReply = aiText('Bəli, qara rəng var, S-L ölçülərdə. Qiyməti 45 AZN.');
  const comment = (text: string, extra: Record<string, unknown> = {}) => ({
    type: 'comment' as const,
    channelType: 'instagram' as const,
    channelExternalId: 'IGC',
    commentId: `cm${++n}`,
    mediaId: '777',
    fromId: 'U5',
    fromUsername: 'aysel',
    text,
    time: Date.now(),
    ...extra,
  });
  /** Webhook → automations → AI triage job → reply job, as the worker would run them. */
  async function run(ev: ReturnType<typeof comment>) {
    await engine.processComment(ev);
    const { queue } = await import('../src/queue.js');
    if (await queue.getJob(`comment-ai-${ev.commentId}`)) await comments.handleCommentAi(ev.commentId);
    const row = await db.one(`SELECT * FROM ig_comments WHERE id = $1`, [ev.commentId]);
    if (row?.ai_status === 'queued') await pipeline.processReply(row.conversation_id, row.message_id);
    return db.one(`SELECT * FROM ig_comments WHERE id = $1`, [ev.commentId]);
  }
  const triageCalls = () => fake.aiCalls().filter((c) => c.body.tools?.[0]?.name === 'comment_triage');
  const dmCalls = () => fake.aiCalls().filter((c) => c.body.tools?.[0]?.name !== 'comment_triage');
  const publicReplies = () => fake.calls.filter((c) => /\/replies$/.test(c.path));
  const setAssistant = (sql: string, params: unknown[] = []) => db.q(`UPDATE assistants SET ${sql} WHERE workspace_id = $1`, [ws.workspaceId, ...params]);

  beforeAll(async () => {
    await startFake();
    db = await import('../src/db.js');
    engine = await import('../src/automations/engine.js');
    pipeline = await import('../src/pipeline.js');
    comments = await import('../src/comments.js');
    await resetDb();
    ws = await seedWorkspace('cmt', 'IGC');
    app = await (await import('../src/server.js')).buildServer();
  });
  beforeEach(async () => {
    fake.reset();
    triageReply = triage('question');
    dmReply = aiText('Bəli, qara rəng var, S-L ölçülərdə. Qiyməti 45 AZN.');
    fake.handler = (body, path) => {
      if (path === '/v1/messages') return body.tools?.[0]?.name === 'comment_triage' ? triageReply : dmReply;
      if (/\/replies$/.test(path)) return { json: { id: `reply.${fake.calls.length}` } };
      if (path.endsWith('/777')) return { json: { caption: 'Yeni yay donları ☀️' } };
      return undefined;
    };
    await db.q(`DELETE FROM automations; DELETE FROM ig_comments; DELETE FROM messages; DELETE FROM conversations; DELETE FROM contacts;`);
    await setAssistant(`comment_ai = true, comment_approval = false, comment_excluded_media = '{}', knowledge = 'Don: 45 AZN, rənglər: qara, ağ, ölçülər S-L'`);
    const { redis } = await import('../src/queue.js');
    await redis.flushdb();
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

  it('is off unless the business switches it on', async () => {
    await setAssistant('comment_ai = false');
    const c = await run(comment('Qara rəngi var? Neçəyədir?'));
    expect(c.ai_status).toBeNull();
    expect(fake.aiCalls()).toHaveLength(0);
    expect(fake.sends()).toHaveLength(0);
  });

  it('a question: answered privately from the knowledge base, then a short public reply under the comment', async () => {
    const ev = comment('Qara rəngi var? Neçəyədir?');
    const c = await run(ev);
    expect(c).toMatchObject({ ai_status: 'replied', ai_category: 'question' });
    // triage on the fast model, with the post caption as context
    expect(triageCalls()).toHaveLength(1);
    expect(triageCalls()[0]!.body.model).toMatch(/haiku/);
    expect(JSON.stringify(triageCalls()[0]!.body.messages)).toContain('Yeni yay donları');
    // the DM answer sees the comment as the customer's turn and goes out as Meta's private reply to that comment
    expect(JSON.stringify(dmCalls()[0]!.body.messages)).toContain('[Şərh: \\"Qara rəngi var? Neçəyədir?\\"]');
    const sends = fake.sends();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.body.recipient).toEqual({ comment_id: ev.commentId });
    expect(sends[0]!.body.message.text).toContain('45 AZN');
    // public reply only after the DM, under this comment
    expect(publicReplies().map((r) => r.path)).toEqual([expect.stringContaining(`${ev.commentId}/replies`)]);
    expect(publicReplies()[0]!.raw).toContain('DM');
    // the inbox shows the comment in the conversation; it does not open the 24 h window
    const conv = await db.one(`SELECT last_inbound_at FROM conversations WHERE id = $1`, [c.conversation_id]);
    expect(conv.last_inbound_at).toBeNull();
    expect((await db.one(`SELECT kind FROM messages WHERE id = $1`, [c.message_id])).kind).toBe('comment');
    expect((await db.one(`SELECT kind FROM messages WHERE direction = 'out'`)).kind).toBe('private_reply');
  });

  it('praise, emoji and tagged friends get nothing; emoji-only comments cost no AI call', async () => {
    expect((await run(comment('😍😍🔥'))).ai_status).toBe('skipped');
    expect((await run(comment('@leyla_m @nigar.a !!'))).ai_status).toBe('skipped');
    expect(fake.aiCalls()).toHaveLength(0);
    triageReply = triage('other');
    expect(await run(comment('Çox gözəldir!'))).toMatchObject({ ai_status: 'skipped', ai_category: 'other' });
    expect(await run(comment('@leyla_m bax'))).toMatchObject({ ai_status: 'skipped', ai_category: 'other' });
    expect(dmCalls()).toHaveLength(0);
    expect(fake.sends()).toHaveLength(0);
    expect(publicReplies()).toHaveLength(0);
    expect((await db.one(`SELECT count(*)::int AS n FROM messages`)).n).toBe(0);
  });

  it('a complaint goes to staff: nothing is posted or sent, the conversation is flagged', async () => {
    triageReply = triage('complaint');
    const c = await run(comment('Sifarişim 2 həftədir gəlmir, aldatdınız!'));
    expect(c).toMatchObject({ ai_status: 'handoff', ai_category: 'complaint' });
    expect(fake.sends()).toHaveLength(0);
    expect(publicReplies()).toHaveLength(0);
    expect(dmCalls()).toHaveLength(0);
    expect((await db.one(`SELECT needs_human FROM conversations WHERE id = $1`, [c.conversation_id])).needs_human).toBe(true);
  });

  it('a keyword automation wins over the AI', async () => {
    await createAutomation(ws.workspaceId, 'comment', { match: { mode: 'any', keywords: ['kataloq'] }, steps: [{ type: 'message', text: 'Kataloq: ...' }] });
    const c = await run(comment('kataloq göndərin'));
    expect(c.ai_status).toBeNull();
    expect(c.matched).toBe(true);
    expect(fake.aiCalls()).toHaveLength(0);
    expect(fake.sends()[0]!.body.message.text).toBe('Kataloq: ...');
  });

  it('the public reply never carries prices, links or phone numbers', async () => {
    triageReply = triage('question', 'Bəli, qiyməti 45 AZN-dir 🙏', 'Bizə yazın: 050 123 45 67');
    const c = await run(comment('qiymət?'));
    expect(c.ai_status).toBe('replied');
    expect(c.public_reply).toBe('');
    expect(c.public_invite).toBe('');
    expect(fake.sends()).toHaveLength(1); // the DM (with the price from the knowledge base) still goes out
    expect(publicReplies()).toHaveLength(0);
  });

  it('one public reply per person per post a day, however many comments they write', async () => {
    await run(comment('Qara var?'));
    await run(comment('S ölçü var?'));
    expect(fake.sends()).toHaveLength(2); // each comment: one private reply
    expect(publicReplies()).toHaveLength(1);
  });

  it('if the person is already chatting in DM, the comment is answered there as a normal message', async () => {
    const { parseInstagramWebhook } = await import('../src/channels/instagram.js');
    for (const e of parseInstagramWebhook(igMessage('IGC', 'U5', 'dm.1', 'Salam'))) await pipeline.ingest(e);
    fake.calls = [];
    await run(comment('Ağ rəngi də var?'));
    const sends = fake.sends();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.body.recipient).toEqual({ id: 'U5' });
  });

  it('excluded posts, blocked people and comment floods are left alone', async () => {
    await setAssistant(`comment_excluded_media = '{777}'`);
    expect((await run(comment('qiymət?'))).ai_status).toBe('skipped');
    await setAssistant(`comment_excluded_media = '{}'`);
    await db.q(`UPDATE contacts SET blocked = true WHERE external_id = 'U5'`);
    expect((await run(comment('qiymət?'))).ai_status).toBeNull(); // blocked: not even stored for the AI
    await db.q(`UPDATE contacts SET blocked = false`);
    for (let i = 0; i < 3; i++) await run(comment(`sual ${i}?`, { fromId: 'U9', fromUsername: 'flood' }));
    expect((await run(comment('yenə sual?', { fromId: 'U9' }))).ai_status).toBe('skipped');
    expect(triageCalls()).toHaveLength(3);
  });

  it('Meta refuses the private reply: the public invite asks them to write to us', async () => {
    const base = fake.handler;
    fake.handler = (body, path) =>
      /\/messages$/.test(path) && !path.startsWith('/v1/') ? { status: 400, json: { error: { code: 10, message: 'user cannot receive' } } } : base(body, path);
    const c = await run(comment('Neçəyədir?'));
    expect(c.ai_status).toBe('invited');
    expect(publicReplies()).toHaveLength(1);
    expect(publicReplies()[0]!.raw).toContain('DM');
  });

  describe('approval mode and the /app/comments page', () => {
    let owner: Awaited<ReturnType<typeof loginAs>>;
    beforeAll(async () => {
      owner = await loginAs(app, ws.email);
    });
    const post = (url: string, payload: Record<string, unknown> = {}) =>
      app.inject({ method: 'POST', url, headers: owner.headers, payload: { _csrf: owner.csrf, ...payload } });

    it('with approval on, nothing goes out until staff press "Göndər"; edits are sent as edited', async () => {
      await setAssistant('comment_approval = true');
      const ev = comment('Qara rəngi var?');
      const c = await run(ev);
      expect(c.ai_status).toBe('pending_approval');
      expect(c.dm_draft).toMatch(/^v1:/); // encrypted at rest
      expect(fake.sends()).toHaveLength(0);
      expect(publicReplies()).toHaveLength(0);

      const page = await app.inject({ url: '/app/comments', headers: owner.headers });
      expect(page.body).toContain('Qara rəngi var?');
      expect(page.body).toContain('qara rəng var, S-L ölçülərdə');

      expect((await post(`/app/comments/${ev.commentId}/approve`, { dm: 'Bəli var, 45 AZN.', public: 'Qiymət 45 AZN' })).headers.location).toContain(
        'comment_public_unsafe',
      );
      expect(fake.sends()).toHaveLength(0);
      const ok = await post(`/app/comments/${ev.commentId}/approve`, { dm: 'Bəli var, 45 AZN 🙂', public: 'Ətraflı DM-ə yazdıq 🙏' });
      expect(ok.headers.location).toContain('comment_sent');
      expect(fake.sends()[0]!.body).toMatchObject({ recipient: { comment_id: ev.commentId }, message: { text: 'Bəli var, 45 AZN 🙂' } });
      expect(publicReplies()[0]!.raw).toContain('DM');
      expect((await db.one(`SELECT ai_status FROM ig_comments WHERE id = $1`, [ev.commentId])).ai_status).toBe('replied');
      // a second press sends nothing more
      expect((await post(`/app/comments/${ev.commentId}/approve`, { dm: 'x' })).statusCode).toBe(404);
      expect(fake.sends()).toHaveLength(1);
    });

    it('reject sends nothing', async () => {
      await setAssistant('comment_approval = true');
      const ev = comment('Ölçü var?');
      await run(ev);
      expect((await post(`/app/comments/${ev.commentId}/reject`)).headers.location).toContain('comment_rejected');
      expect((await db.one(`SELECT ai_status, dm_draft FROM ig_comments WHERE id = $1`, [ev.commentId])).ai_status).toBe('rejected');
      expect(fake.sends()).toHaveLength(0);
    });

    it('settings: switch on/off, approval and excluded posts are saved; analysts cannot open the page', async () => {
      const r = await post('/app/comments/settings', { comment_approval: '1', excluded: ['777', '888', 'not-an-id'] });
      expect(r.headers.location).toContain('comments_saved');
      const a = await db.one(`SELECT comment_ai, comment_approval, comment_excluded_media FROM assistants WHERE workspace_id = $1`, [ws.workspaceId]);
      expect(a).toEqual({ comment_ai: false, comment_approval: true, comment_excluded_media: ['777', '888'] });

      const { hash } = await import('@node-rs/argon2');
      const u = await db.one(`INSERT INTO users (email, password_hash, email_verified_at) VALUES ('an@cmt.az', $1, now()) RETURNING id`, [
        await hash('correct-horse-battery'),
      ]);
      await db.q(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'analyst')`, [ws.workspaceId, u.id]);
      const analyst = await loginAs(app, 'an@cmt.az');
      expect((await app.inject({ url: '/app/comments', headers: analyst.headers })).statusCode).toBe(403);
    });
  });
});
