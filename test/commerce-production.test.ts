// INTEGRATION_MODE=production (the default) with META_COMMERCE_VERIFIED=on: the same catalog workflow, but through the
// REAL providers pointed at the fake Meta/Telegram server. Proves the mock and the real path run the same business logic,
// and that only a real provider's confirmation produces DELIVERED.
process.env.META_COMMERCE_VERIFIED = 'on';
process.env.TELEGRAM_API_BASE = 'http://127.0.0.1:4011';

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drainAll, fake, resetDb, seedWorkspace, startFake, stopFake } from './helpers.js';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_REDIS_URL;

describe.skipIf(!enabled)('production mode (verified): real providers against the fake Meta and Telegram', () => {
  let db: typeof import('../src/db.js');
  let app: import('fastify').FastifyInstance;
  let ws: Awaited<ReturnType<typeof seedWorkspace>>;
  let events: typeof import('../src/integrations/events.js');
  const igId = 'IGPROD';

  const signed = (body: unknown) => {
    const raw = JSON.stringify(body);
    return {
      method: 'POST' as const,
      url: '/webhooks/instagram',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'test-meta-secret').update(raw).digest('hex')}` },
      payload: raw,
    };
  };
  const comment = (id: string, mediaId: string, text: string, from = 'U9') => ({
    object: 'instagram',
    entry: [
      {
        id: igId,
        time: Math.floor(Date.now() / 1000),
        changes: [{ field: 'comments', value: { id, text, from: { id: from, username: 'real_user' }, media: { id: mediaId } } }],
      },
    ],
  });
  const postback = (from: string, payload: string) => ({
    object: 'instagram',
    entry: [
      {
        id: igId,
        time: Date.now(),
        messaging: [
          {
            sender: { id: from },
            recipient: { id: igId },
            timestamp: Date.now(),
            postback: { mid: `pb.${payload}.${from}`, title: 'Qiyməti göstər', payload },
          },
        ],
      },
    ],
  });
  const igSends = () => fake.sends();
  const telegramCalls = (method: string) => fake.calls.filter((c) => c.path.endsWith(`/${method}`) && c.path.startsWith('/bot'));

  beforeAll(async () => {
    await startFake();
    db = await import('../src/db.js');
    events = await import('../src/integrations/events.js');
    await resetDb();
    ws = await seedWorkspace('prod', igId);
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

  it('selects the real providers', async () => {
    const { instagramProvider, telegramProvider } = await import('../src/integrations/index.js');
    expect(instagramProvider().name).toBe('meta');
    expect(telegramProvider().name).toBe('bot');
  });

  it('comment "Qiymət?" -> carousel sent through the Graph API (Generic Template), recorded DELIVERED, no LLM call', async () => {
    const res = await app.inject(signed(comment('c-prod-1', 'mock_media_1002', 'Qiymət?')));
    expect(res.statusCode).toBe(200);
    await drainAll();

    const sends = igSends();
    expect(sends).toHaveLength(1);
    const b = sends[0]!.body;
    expect(b.recipient).toEqual({ comment_id: 'c-prod-1' });
    expect(b.message.attachment.type).toBe('template');
    expect(b.message.attachment.payload.template_type).toBe('generic');
    const elements = b.message.attachment.payload.elements;
    expect(elements.map((e: any) => e.title).sort()).toEqual(['Ağ köynək', 'Dəri gödəkçə', 'Jean şalvar']);
    expect(elements[0].buttons[0]).toMatchObject({ type: 'postback', title: 'Qiyməti göstər' });
    expect(elements[0].buttons[0].payload).toMatch(/^prod:\d+$/);

    // DELIVERED only because the (fake) Meta API confirmed with a message id
    const ev = (await events.listIntegrationEvents(ws.workspaceId, { kind: 'cards' }))[0]!;
    expect(ev).toMatchObject({ status: 'DELIVERED', mode: 'production', direction: 'out' });
    expect(ev.externalId).toMatch(/^mid\./);
    const msg = await db.one(`SELECT status FROM messages WHERE direction = 'out' ORDER BY created_at DESC LIMIT 1`);
    expect(msg.status).toBe('sent');
    expect(fake.aiCalls()).toHaveLength(0);
  });

  it('tapping a card -> the price answer from PostgreSQL, sent as a normal DM', async () => {
    const jean = await db.one(`SELECT seq FROM products WHERE workspace_id = $1 AND sku = 'JN-001'`, [ws.workspaceId]);
    await db.q(`UPDATE products SET price = 71 WHERE workspace_id = $1 AND sku = 'JN-001'`, [ws.workspaceId]);
    await app.inject(signed(postback('U9', `prod:${jean.seq}`)));
    await drainAll();
    const sends = igSends();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.body.recipient).toEqual({ id: 'U9' });
    expect(sends[0]!.body.message.text).toBe('Jean şalvar — 71 AZN 💰\nYüksək belli, mavi\nSifariş vermək və ya sual vermək üçün bu söhbətə yazın 🙏');
    expect(fake.aiCalls()).toHaveLength(0);
  });

  it('a Meta refusal is recorded FAILED, never DELIVERED', async () => {
    fake.handler = (_b, path) => (/\/messages$/.test(path) ? { status: 400, json: { error: { code: 100, message: 'nope' } } } : undefined);
    await app.inject(signed(comment('c-prod-2', 'mock_media_1001', 'Qiymət?', 'U10')));
    await drainAll();
    const ev = (await events.listIntegrationEvents(ws.workspaceId, { kind: 'private_reply' }))[0]!;
    expect(ev).toMatchObject({ status: 'FAILED', error: 'api_100' });
    expect((await db.one(`SELECT ai_status FROM ig_comments WHERE id = 'c-prod-2'`)).ai_status).toBe('failed');
  });

  it('new post: listed through the Graph API, announced in Telegram with a real inline keyboard, callbacks via the secured webhook', async () => {
    await db.q(`INSERT INTO notify_targets (workspace_id, user_id, kind, chat_id, label) VALUES ($1, $2, 'telegram', '555', 'owner')`, [
      ws.workspaceId,
      ws.userId,
    ]);
    fake.handler = (_b, path) => {
      if (path.endsWith('/me/media'))
        return {
          json: {
            data: [
              {
                id: 'real_media_9',
                caption: 'Real yeni post',
                media_type: 'IMAGE',
                permalink: 'https://www.instagram.com/p/x/',
                timestamp: new Date().toISOString(),
              },
              { id: 'mock_media_1001', caption: 'old', media_type: 'IMAGE', timestamp: new Date().toISOString() },
            ],
          },
        };
      if (/^\/bot\w+\/sendMessage$/.test(path)) return { json: { ok: true, result: { message_id: 4242 } } };
      if (/^\/bot\w+\/(editMessageReplyMarkup|answerCallbackQuery)$/.test(path)) return { json: { ok: true, result: true } };
      return undefined;
    };
    const { detectNewPosts } = await import('../src/commerce/posts.js');
    const ch = await db.one(`SELECT * FROM channels WHERE workspace_id = $1`, [ws.workspaceId]);
    const fresh = await detectNewPosts(ch);
    expect(fresh.map((p) => p.media_id)).toEqual(['real_media_9']);
    expect(fresh[0]!.source).toBe('meta');

    const sent = telegramCalls('sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.chat_id).toBe('555');
    const kb = sent[0]!.body.reply_markup.inline_keyboard.flat();
    expect(kb.length).toBeGreaterThan(3);
    expect(kb.every((b: any) => Buffer.byteLength(b.callback_data) <= 64)).toBe(true);
    const ev = (await events.listIntegrationEvents(ws.workspaceId, { kind: 'new_post_picker' }))[0]!;
    expect(ev).toMatchObject({ status: 'DELIVERED', externalId: '4242' });

    // a press arrives at the real webhook route with the secret header
    const first = kb.find((b: any) => b.callback_data.startsWith('pt:'));
    const call = (cbData: string, secret = 'test-telegram-secret-123') =>
      app.inject({
        method: 'POST',
        url: '/webhooks/telegram',
        headers: { 'x-telegram-bot-api-secret-token': secret },
        payload: { callback_query: { id: 'cb1', data: cbData, message: { message_id: 4242, chat: { id: 555, type: 'private' } } } },
      });
    expect((await call(first.callback_data, 'wrong-secret-wrong-secret')).statusCode).toBe(401);
    expect((await call(first.callback_data)).statusCode).toBe(200);
    const post = (await db.one(`SELECT id, seq FROM ig_posts WHERE media_id = 'real_media_9'`))!;
    expect((await db.one(`SELECT count(*)::int AS n FROM post_products WHERE post_id = $1`, [post.id])).n).toBe(1);
    expect(telegramCalls('editMessageReplyMarkup')).toHaveLength(1);
    expect(telegramCalls('answerCallbackQuery')).toHaveLength(1);
    await call(`pd:${post.seq}`);
    expect((await db.one(`SELECT product_state FROM ig_posts WHERE id = $1`, [post.id])).product_state).toBe('assigned');
  });
});
