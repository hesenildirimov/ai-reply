import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAutomation, fake, igMessage, loginAs, resetDb, seedWorkspace, startFake, stopFake } from './helpers.js';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_REDIS_URL;

describe('keyword matching', async () => {
  const { matches, normalize } = await import('../src/automations/engine.js');
  it('ignores case, punctuation and Azerbaijani diacritics', () => {
    expect(normalize('Qiymət NƏDİR?!')).toBe('qiymet nedir');
    expect(matches({ mode: 'any', keywords: ['qiymət'], exclude: [] }, 'qiymet nedi')).toBe(true);
    expect(matches({ mode: 'any', keywords: ['qiymət'], exclude: ['spam'] }, 'qiymet spam')).toBe(false);
    expect(matches({ mode: 'all', keywords: ['don', 'qırmızı'], exclude: [] }, 'qirmizi don var?')).toBe(true);
    expect(matches({ mode: 'exact', keywords: ['menyu'], exclude: [] }, 'menyu lazımdır')).toBe(false);
    expect(matches({ mode: 'any', keywords: ['don'], exclude: [] }, 'dondurma')).toBe(false); // whole words only
  });
});

describe.skipIf(!enabled)('P1 automations (integration)', () => {
  let db: typeof import('../src/db.js');
  let engine: typeof import('../src/automations/engine.js');
  let pipeline: typeof import('../src/pipeline.js');
  let ws: Awaited<ReturnType<typeof seedWorkspace>>;
  let n = 0;
  const comment = (text: string, extra: Record<string, unknown> = {}) => ({
    type: 'comment' as const,
    channelType: 'instagram' as const,
    channelExternalId: 'IG1',
    commentId: `c${++n}`,
    mediaId: '111',
    fromId: 'U5',
    fromUsername: 'aysel',
    text,
    time: Date.now(),
    ...extra,
  });
  async function dm(text: string, from = 'U7', extra: Record<string, unknown> = {}) {
    const { parseInstagramWebhook } = await import('../src/channels/instagram.js');
    const body = igMessage('IG1', from, `dm.${++n}`, text);
    Object.assign(body.entry[0]!.messaging[0]!.message, extra);
    for (const ev of parseInstagramWebhook(body)) await pipeline.ingest(ev);
    const row = await db.one(`SELECT id, conversation_id FROM messages WHERE external_id = $1`, [`dm.${n}`]);
    await pipeline.processReply(row.conversation_id, row.id);
    return row.conversation_id as string;
  }

  beforeAll(async () => {
    await startFake();
    db = await import('../src/db.js');
    engine = await import('../src/automations/engine.js');
    pipeline = await import('../src/pipeline.js');
    await resetDb();
    ws = await seedWorkspace('auto', 'IG1');
  });
  beforeEach(async () => {
    fake.reset();
    await db.q(`DELETE FROM automations; DELETE FROM conversations; DELETE FROM contacts; DELETE FROM ig_comments;`);
  });
  afterAll(async () => {
    await stopFake();
    const { closeQueues, redis } = await import('../src/queue.js');
    await closeQueues();
    redis.disconnect();
    await db.pool.end();
  });

  it('comment-to-DM: one private reply per comment, sent to the comment id, duplicates ignored', async () => {
    await createAutomation(ws.workspaceId, 'comment', {
      match: { mode: 'any', keywords: ['qiymət'] },
      public_reply: { enabled: true, texts: ['DM-ə yazdıq'] },
      steps: [
        { type: 'message', text: 'Qiymətlər: 45 AZN' },
        { type: 'tag', add: ['lead'] },
      ],
    });
    const ev = comment('Qiymet nedir?');
    await engine.processComment(ev);
    await engine.processComment(ev); // duplicate webhook
    const sends = fake.sends();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.body.recipient).toEqual({ comment_id: ev.commentId });
    expect(fake.calls.filter((c) => c.path.endsWith(`${ev.commentId}/replies`))).toHaveLength(1);
    const run = await db.one(`SELECT status, sent_at FROM automation_runs`);
    expect(run.status).toBe('sent');
    expect((await db.one(`SELECT count(*)::int AS n FROM contact_tags`)).n).toBe(1);
    expect((await db.one(`SELECT kind FROM messages WHERE direction = 'out'`)).kind).toBe('private_reply');
  });

  it('comment-to-DM skips non-matching, own, old and opted-out comments', async () => {
    await createAutomation(ws.workspaceId, 'comment', { match: { mode: 'any', keywords: ['qiymət'] }, steps: [{ type: 'message', text: 'x' }] });
    await engine.processComment(comment('gözəldir'));
    await engine.processComment(comment('qiymət?', { fromId: 'IG1' }));
    await engine.processComment(comment('qiymət?', { time: Date.now() - 8 * 86400_000 }));
    await db.q(`INSERT INTO contacts (workspace_id, channel_id, external_id, opted_out) VALUES ($1, $2, 'U99', true)`, [ws.workspaceId, ws.channelId]);
    await engine.processComment(comment('qiymət?', { fromId: 'U99' }));
    expect(fake.sends()).toHaveLength(0);
    expect((await db.one(`SELECT count(*)::int AS n FROM ig_comments`)).n).toBe(3); // own comment is not stored
  });

  it('DM keyword + quick reply branching runs without the AI', async () => {
    const b = await createAutomation(
      ws.workspaceId,
      'quick_reply',
      { match: { mode: 'anything' }, steps: [{ type: 'message', text: 'Qiymətlər: 45 AZN' }] },
      'active',
      'qiymet',
    );
    await createAutomation(ws.workspaceId, 'dm_keyword', {
      match: { mode: 'any', keywords: ['menyu'] },
      steps: [{ type: 'message', text: 'Nə maraqlıdır?', quick_replies: [{ title: 'Qiymətlər', goto: b }] }],
    });
    const conv = await dm('MENYU');
    expect(fake.sends()[0]!.body.message.quick_replies[0]).toEqual({ content_type: 'text', title: 'Qiymətlər', payload: `qr:${b}` });
    await dm('Qiymətlər', 'U7', { quick_reply: { payload: `qr:${b}` } });
    expect(fake.sends().map((s) => s.body.message.text)).toEqual(['Nə maraqlıdır?', 'Qiymətlər: 45 AZN']);
    expect(fake.aiCalls()).toHaveLength(0);
    expect((await db.q(`SELECT sender FROM messages WHERE conversation_id = $1 AND direction = 'out'`, [conv])).every((m) => m.sender === 'bot')).toBe(true);
  });

  it('paused automation does not start new runs (AI answers instead)', async () => {
    await createAutomation(ws.workspaceId, 'dm_keyword', { match: { mode: 'any', keywords: ['menyu'] }, steps: [{ type: 'message', text: 'BOT' }] }, 'paused');
    await dm('menyu');
    expect(fake.sends().map((s) => s.body.message.text)).not.toContain('BOT');
    expect(fake.aiCalls()).toHaveLength(1);
    expect((await db.one(`SELECT count(*)::int AS n FROM automation_runs`)).n).toBe(0);
  });

  it('story mention triggers its automation', async () => {
    await createAutomation(ws.workspaceId, 'story_mention', { steps: [{ type: 'message', text: 'Təşəkkürlər! 💛' }] });
    await dm('', 'U8', { text: undefined, attachments: [{ type: 'story_mention', payload: { url: 'https://cdn.example/story.jpg' } }] });
    expect(fake.sends().map((s) => s.body.message.text)).toEqual(['Təşəkkürlər! 💛']);
    expect((await db.one(`SELECT kind, media FROM messages WHERE direction = 'in'`)).kind).toBe('story_mention');
  });

  it('STOP opts the contact out of all automated messages', async () => {
    await createAutomation(ws.workspaceId, 'dm_keyword', { match: { mode: 'anything' }, steps: [{ type: 'message', text: 'auto' }] });
    await dm('STOP', 'U3');
    await dm('salam', 'U3');
    expect(fake.sends()).toHaveLength(0);
    expect(fake.aiCalls()).toHaveLength(0);
    expect((await db.one(`SELECT opted_out FROM contacts WHERE external_id = 'U3'`)).opted_out).toBe(true);
  });

  it('delay step resumes later and stops if the automation was paused meanwhile', async () => {
    const id = await createAutomation(ws.workspaceId, 'dm_keyword', {
      match: { mode: 'any', keywords: ['salam'] },
      steps: [
        { type: 'message', text: 'bir' },
        { type: 'delay', minutes: 5 },
        { type: 'message', text: 'iki' },
      ],
    });
    await dm('salam', 'U4');
    const run = await db.one(`SELECT id FROM automation_runs`);
    await engine.resumeRun(run.id, 2);
    await engine.resumeRun(run.id, 2); // retried job: idempotent
    expect(fake.sends().map((s) => s.body.message.text)).toEqual(['bir', 'iki']);
    await db.q(`UPDATE automations SET status = 'paused' WHERE id = $1`, [id]);
    await db.q(`DELETE FROM messages WHERE idempotency_key = $1`, [`run:${run.id}:2`]); // forget the step-2 send so only the pause can stop it
    await engine.resumeRun(run.id, 2);
    expect(fake.sends()).toHaveLength(2);
  });

  it('a follow trigger (not available in Meta API) cannot be activated', async () => {
    const app = await (await import('../src/server.js')).buildServer();
    const s = await loginAs(app, ws.email);
    const id = await createAutomation(ws.workspaceId, 'follow', { match: { mode: 'anything' }, steps: [{ type: 'message', text: 'Xoş gəldin' }] }, 'draft');
    const res = await app.inject({ method: 'POST', url: `/app/automations/${id}/status`, headers: s.headers, payload: { _csrf: s.csrf, action: 'activate' } });
    expect(res.body).toContain('Aktivləşdirmək olmur');
    expect((await db.one(`SELECT status FROM automations WHERE id = $1`, [id])).status).toBe('draft');
    // creating one through the UI is refused too
    const create = await app.inject({ method: 'POST', url: '/app/automations', headers: s.headers, payload: { _csrf: s.csrf, trigger: 'follow' } });
    expect(create.headers.location).toContain('m=invalid');
    await app.close();
  });
});
