// INTEGRATION_MODE=mock: the whole catalog workflow (new post -> Telegram picker -> comment "Qiymət?" -> product cards ->
// tap -> price from PostgreSQL) through the real pipeline, with no Instagram/Telegram credentials and zero LLM calls.
process.env.INTEGRATION_MODE = 'mock';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drainAll, fake, loginAs, resetDb, seedWorkspace, startFake, stopFake } from './helpers.js';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_REDIS_URL;

describe.skipIf(!enabled)('mock mode: catalog workflow without external credentials', () => {
  let db: typeof import('../src/db.js');
  let sim: typeof import('../src/commerce/simulator.js');
  let posts: typeof import('../src/commerce/posts.js');
  let catalog: typeof import('../src/commerce/catalog.js');
  let fx: typeof import('../src/commerce/fixtures.js');
  let events: typeof import('../src/integrations/events.js');
  let ws: Awaited<ReturnType<typeof seedWorkspace>>;
  let app: import('fastify').FastifyInstance;
  let demo: Awaited<ReturnType<ReturnType<typeof importFx>['seedDemoData']>>;
  const importFx = () => fx;

  const eventsOf = async (kind: string) => (await events.listIntegrationEvents(ws.workspaceId, { kind, limit: 200 })).reverse();
  /** Every call that reached the fake Meta/Telegram/Anthropic server: in mock mode there must be none. */
  const outside = () => fake.calls.map((c) => c.path);

  beforeAll(async () => {
    await startFake();
    db = await import('../src/db.js');
    sim = await import('../src/commerce/simulator.js');
    posts = await import('../src/commerce/posts.js');
    catalog = await import('../src/commerce/catalog.js');
    fx = await import('../src/commerce/fixtures.js');
    events = await import('../src/integrations/events.js');
    await resetDb();
    ws = await seedWorkspace('mock', 'IGMOCK');
    demo = await fx.seedDemoData(ws.workspaceId);
  });
  afterAll(async () => {
    await app?.close();
    await stopFake();
    const { closeQueues, redis } = await import('../src/queue.js');
    (await import('../src/realtime.js')).closeRealtime();
    await closeQueues();
    redis.disconnect();
    await db.pool.end();
  });
  beforeEach(() => fake.reset());

  const productRow = (sku: string) => db.one(`SELECT * FROM products WHERE workspace_id = $1 AND sku = $2`, [ws.workspaceId, sku]);
  const lastBotMessage = async (convUser: string) => {
    const { openBody } = await import('../src/messages.js');
    const row = await db.one(
      `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.external_user_id = $1 AND m.direction = 'out' ORDER BY m.created_at DESC LIMIT 1`,
      [convUser],
    );
    return row && { ...row, text: openBody(row) };
  };

  it('seeds the development fixtures', async () => {
    expect((await catalog.listProducts(ws.workspaceId)).length).toBeGreaterThanOrEqual(10);
    expect(
      await db.one(`SELECT count(*)::int AS n FROM knowledge_items WHERE workspace_id = $1 AND kind IN ('faq', 'delivery', 'policy', 'info')`, [
        ws.workspaceId,
      ]),
    ).toMatchObject({ n: 5 });
    const byState = await db.q(
      `SELECT p.media_id, p.product_state, (SELECT count(*)::int FROM post_products x WHERE x.post_id = p.id) AS n FROM ig_posts p WHERE p.workspace_id = $1 ORDER BY media_id`,
      [ws.workspaceId],
    );
    expect(byState).toEqual([
      { media_id: 'mock_media_1001', product_state: 'assigned', n: 1 }, // one post, one product
      { media_id: 'mock_media_1002', product_state: 'assigned', n: 3 }, // one post, several products
      { media_id: 'mock_media_1003', product_state: 'skipped', n: 0 }, // a post without products
      { media_id: 'mock_media_1004', product_state: 'pending', n: 0 },
    ]);
    // running the seed again changes nothing
    await fx.seedDemoData(ws.workspaceId);
    expect((await db.one(`SELECT count(*)::int AS n FROM products WHERE workspace_id = $1`, [ws.workspaceId])).n).toBe(fx.DEMO_PRODUCTS.length);
  });

  it('uses the mock providers: SIMULATED, never DELIVERED, and nothing leaves the server', async () => {
    const { telegramProvider, instagramProvider } = await import('../src/integrations/index.js');
    expect(instagramProvider().name).toBe('mock');
    expect(telegramProvider().name).toBe('mock');
    // the database itself refuses a "delivered" event in mock mode
    await expect(
      db.q(`INSERT INTO integration_events (provider, direction, kind, status, mode) VALUES ('instagram', 'out', 'dm', 'DELIVERED', 'mock')`),
    ).rejects.toThrow();
  });

  describe('new post -> dashboard notification -> Telegram picker -> saved products', () => {
    let mediaId: string;
    let chatId: string;

    it('simulates Telegram account connection', async () => {
      const r = await sim.simulateTelegramConnect(ws.workspaceId, ws.userId);
      chatId = r.chatId;
      expect(await db.one(`SELECT label FROM notify_targets WHERE workspace_id = $1 AND chat_id = $2`, [ws.workspaceId, chatId])).toBeTruthy();
      const connected = await eventsOf('account_connected');
      expect(connected.length).toBeGreaterThan(0);
      expect(connected.every((e) => e.status === 'SIMULATED' && e.mode === 'mock')).toBe(true);
    });

    it('simulates a newly published post and detects it once', async () => {
      ({ mediaId } = await sim.simulatePublishPost(ws.workspaceId, 'Yeni kolleksiya: çanta və şərf 👜'));
      const found = await sim.simulateDetectPosts(ws.workspaceId);
      expect(found.map((p) => p.media_id)).toEqual([mediaId]); // the four seeded posts are baseline, not "new"
      expect(await sim.simulateDetectPosts(ws.workspaceId)).toHaveLength(0); // announced once
      expect(await db.one(`SELECT product_state, source FROM ig_posts WHERE media_id = $1`, [mediaId])).toEqual({ product_state: 'pending', source: 'mock' });
    });

    it('shows a dashboard notification', async () => {
      const [e] = (await eventsOf('new_post')).slice(-1);
      expect(e).toMatchObject({ provider: 'instagram', direction: 'in', status: 'SIMULATED', mode: 'mock' });
      expect(e!.summary).toContain('Yeni kolleksiya');
      expect(await posts.pendingPostCount(ws.workspaceId)).toBe(2); // the seeded pending post and this one
    });

    it('generates the Telegram notification with an inline keyboard', async () => {
      const [e] = (await eventsOf('new_post_picker')).slice(-1);
      expect(e).toMatchObject({ provider: 'telegram', direction: 'out', status: 'SIMULATED' });
      const p = e!.payload as { chatId: string; text: string; keyboard: { text: string; callbackData: string }[][] };
      expect(p.chatId).toBe(chatId);
      expect(p.text).toContain('Yeni kolleksiya');
      const flat = p.keyboard.flat();
      expect(flat.filter((b) => b.callbackData.startsWith('pt:'))).toHaveLength(10); // the first 10 of the 12 products
      expect(p.text).toContain('Kataloqda 12 məhsul var');
      expect(flat.every((b) => Buffer.byteLength(b.callbackData) <= 64)).toBe(true); // Telegram's callback_data limit
      expect(flat.some((b) => b.text.includes('Yadda saxla'))).toBe(true);
    });

    it('selects several products through Inline Keyboard callbacks and saves the association', async () => {
      const [pickerEvent] = (await eventsOf('new_post_picker')).slice(-1);
      const picker = pickerEvent!;
      const kb = (picker.payload as any).keyboard.flat() as { text: string; callbackData: string }[];
      const post = (await db.one(`SELECT * FROM ig_posts WHERE media_id = $1`, [mediaId]))!;
      const pick = kb.filter((b) => b.callbackData.startsWith('pt:')).slice(0, 3); // A, B, C
      const skuOf = async (b: { callbackData: string }) =>
        (await db.one(`SELECT sku FROM products WHERE workspace_id = $1 AND seq = $2`, [ws.workspaceId, b.callbackData.split(':')[2]])).sku as string;

      // saving with nothing selected is refused
      await sim.simulateTelegramCallback(chatId, picker.externalId, `pd:${post.seq}`);
      expect((await db.one(`SELECT product_state FROM ig_posts WHERE id = $1`, [post.id])).product_state).toBe('pending');

      for (const b of pick) await sim.simulateTelegramCallback(chatId, picker.externalId, b.callbackData);
      await sim.simulateTelegramCallback(chatId, picker.externalId, pick[2]!.callbackData); // C toggled off again
      // still a draft: comments are not answered from it yet
      expect((await db.one(`SELECT product_state FROM ig_posts WHERE id = $1`, [post.id])).product_state).toBe('pending');

      await sim.simulateTelegramCallback(chatId, picker.externalId, `pd:${post.seq}`);
      const saved = await db.q(`SELECT pr.sku FROM post_products pp JOIN products pr ON pr.id = pp.product_id WHERE pp.post_id = $1 ORDER BY pr.sku`, [
        post.id,
      ]);
      expect(saved.map((r) => r.sku)).toEqual([await skuOf(pick[0]!), await skuOf(pick[1]!)].sort());
      expect((await db.one(`SELECT product_state FROM ig_posts WHERE id = $1`, [post.id])).product_state).toBe('assigned');
      const confirmations = await eventsOf('post_products_saved');
      expect(confirmations.at(-1)!.summary).toContain('2 məhsul');
      expect(outside()).toEqual([]);
    });
  });

  describe('customer comment "Qiymət?" -> product cards -> selection -> price from PostgreSQL', () => {
    const customer = { id: 'CUST1', username: 'aysel' };

    it('a post with several products gets a Rich Card carousel as the private reply', async () => {
      const { commentId } = await sim.simulateComment(ws.workspaceId, 'mock_media_1002', 'Qiymət?', customer);
      await drainAll();

      const c = await db.one(`SELECT * FROM ig_comments WHERE id = $1`, [commentId]);
      expect(c).toMatchObject({ ai_status: 'catalog', matched: true, ai_category: 'question' });
      const [cards] = (await eventsOf('cards')).slice(-1);
      expect(cards).toMatchObject({ provider: 'instagram', direction: 'out', status: 'SIMULATED', mode: 'mock' });
      const payload = cards!.payload as { commentId: string; cards: { title: string; buttons: { type: string; title: string; payload: string }[] }[] };
      expect(payload.commentId).toBe(commentId); // Meta's one private reply to the comment
      expect(payload.cards.map((x) => x.title).sort()).toEqual(['Ağ köynək', 'Dəri gödəkçə', 'Jean şalvar']);
      for (const card of payload.cards) {
        expect(card.buttons).toHaveLength(1);
        expect(card.buttons[0]).toMatchObject({ type: 'postback', title: 'Qiyməti göstər' });
        expect(card.buttons[0]!.payload).toMatch(/^prod:\d+$/);
      }
      // the message is stored as simulated, so the inbox never claims it was delivered
      expect((await lastBotMessage(customer.id))!.status).toBe('simulated');
    });

    it('the tapped product is answered with the CURRENT price from PostgreSQL, using the predefined response', async () => {
      const [cardsEvent] = (await eventsOf('cards')).slice(-1);
      const cards = (cardsEvent!.payload as any).cards as { title: string; buttons: { payload: string }[] }[];
      const jean = cards.find((c) => c.title === 'Jean şalvar')!;
      // The price changes after the cards went out: the answer must follow the database, not the card.
      await db.q(`UPDATE products SET price = 74.50 WHERE workspace_id = $1 AND sku = 'JN-001'`, [ws.workspaceId]);

      await sim.simulatePostback(ws.workspaceId, customer.id, jean.buttons[0]!.payload);
      await drainAll();

      const row = await productRow('JN-001');
      expect(row.price).toBe('74.50');
      const answer = await lastBotMessage(customer.id);
      expect(answer!.text).toBe(catalog.productAnswer(row));
      expect(answer!.text).toBe('Jean şalvar — 74.50 AZN 💰\nYüksək belli, mavi\nSifariş vermək və ya sual vermək üçün bu söhbətə yazın 🙏');
      expect(answer).toMatchObject({ sender: 'bot', status: 'simulated' });
      const dm = (await eventsOf('dm')).at(-1)!;
      expect(dm).toMatchObject({ status: 'SIMULATED' });
      expect((await eventsOf('postback')).at(-1)!.status).toBe('SIMULATED');
    });

    it('a post with one product is answered directly (private reply, no carousel)', async () => {
      const before = (await eventsOf('cards')).length;
      const { commentId } = await sim.simulateComment(ws.workspaceId, 'mock_media_1001', 'Qiymeti neçədir?', { id: 'CUST2', username: 'leyla' });
      await drainAll();
      expect((await eventsOf('cards')).length).toBe(before);
      const answer = await lastBotMessage('CUST2');
      expect(answer!.text).toBe(catalog.productAnswer(await productRow('DR-001')));
      expect(answer!.text).toContain('45 AZN');
      expect((await db.one(`SELECT kind FROM messages WHERE id = $1`, [answer!.id])).kind).toBe('private_reply');
      expect((await db.one(`SELECT ai_status FROM ig_comments WHERE id = $1`, [commentId])).ai_status).toBe('catalog');
    });

    it('a post without products and comments that are not price questions are left to the other flows', async () => {
      const a = await sim.simulateComment(ws.workspaceId, 'mock_media_1003', 'Qiymət?', { id: 'CUST3', username: 'nigar' });
      const b = await sim.simulateComment(ws.workspaceId, 'mock_media_1001', 'Çox gözəldir 😍', { id: 'CUST4', username: 'rauf' });
      const c = await sim.simulateComment(ws.workspaceId, 'mock_media_1004', 'Qiymət?', { id: 'CUST5', username: 'elnur' }); // products not chosen yet
      await drainAll();
      for (const id of [a.commentId, b.commentId, c.commentId])
        expect((await db.one(`SELECT ai_status, matched FROM ig_comments WHERE id = $1`, [id])).matched).toBe(false);
      expect(
        await db.one(
          `SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.external_user_id IN ('CUST3','CUST4','CUST5') AND m.direction = 'out'`,
        ),
      ).toEqual({ n: 0 });
    });

    it('made zero LLM calls and zero calls to Meta or Telegram in the whole flow', () => {
      expect(fake.aiCalls()).toHaveLength(0);
      expect(outside()).toEqual([]);
    });
  });

  describe('isolation', () => {
    it("another business's chat and product numbers change nothing", async () => {
      const other = await seedWorkspace('other', 'IGOTHER');
      const otherDemo = await fx.seedDemoData(other.workspaceId);
      const otherChat = (await sim.simulateTelegramConnect(other.workspaceId, other.userId)).chatId;
      const post = (await db.one(`SELECT * FROM ig_posts WHERE workspace_id = $1 AND media_id = 'mock_media_1004'`, [ws.workspaceId]))!;
      const mine = await productRow('SC-001');
      // The other business's chat presses a button of MY post
      await sim.simulateTelegramCallback(otherChat, '1', `pt:${post.seq}:${mine.seq}`);
      await sim.simulateTelegramCallback(otherChat, '1', `pn:${post.seq}`);
      expect((await db.one(`SELECT product_state FROM ig_posts WHERE id = $1`, [post.id])).product_state).toBe('pending');
      expect((await db.one(`SELECT count(*)::int AS n FROM post_products WHERE post_id = $1`, [post.id])).n).toBe(0);
      // A card button carrying MY product number, tapped in the other business's conversation
      await sim.simulatePostback(other.workspaceId, 'XCUST', `prod:${mine.seq}`);
      await drainAll();
      expect((await lastBotMessage('XCUST'))!.text).toBe(catalog.productUnavailableAnswer());
      expect(otherDemo.products['SC-001']).not.toBe(demo.products['SC-001']);
      expect(fake.aiCalls()).toHaveLength(0);
    });

    it('products of one business cannot be attached to a post of another (composite keys)', async () => {
      const post = (await db.one(`SELECT id FROM ig_posts WHERE workspace_id = $1 LIMIT 1`, [ws.workspaceId]))!;
      const theirs = await db.one(`SELECT id, workspace_id FROM products WHERE workspace_id <> $1 LIMIT 1`, [ws.workspaceId]);
      await expect(
        db.q(`INSERT INTO post_products (post_id, product_id, workspace_id) VALUES ($1, $2, $3)`, [post.id, theirs.id, ws.workspaceId]),
      ).rejects.toThrow();
      await expect(posts.setPostProducts(ws.workspaceId, post.id, [theirs.id])).rejects.toThrow();
    });
  });

  describe('dashboard', () => {
    let session: Awaited<ReturnType<typeof loginAs>>;
    const get = (url: string) => app.inject({ url, headers: session.headers });
    const post = (url: string, payload: Record<string, unknown> = {}) =>
      app.inject({ method: 'POST', url, headers: session.headers, payload: { _csrf: session.csrf, ...payload } });

    beforeAll(async () => {
      app = await (await import('../src/server.js')).buildServer();
      session = await loginAs(app, ws.email);
    });

    it('shows the development indicator on every dashboard page', async () => {
      for (const url of ['/app', '/app/activity', '/app/posts', '/app/catalog', '/app/dev', '/app/inbox']) {
        const res = await get(url);
        expect(res.statusCode, url).toBe(200);
        expect(res.body, url).toContain('DEVELOPMENT MODE — MOCK INTEGRATIONS');
      }
    });

    it('notifies about posts waiting for products on the home page', async () => {
      const res = await get('/app');
      expect(res.body).toMatch(/1 yeni post<\/b> məhsul seçiminizi gözləyir/);
    });

    it('lists events as SIMULATED and never as DELIVERED', async () => {
      const res = await get('/app/activity');
      expect(res.body).toContain('chip warn">SIMULATED');
      const rows = res.body.slice(res.body.indexOf('<tbody>'));
      expect(rows).not.toContain('DELIVERED'); // the legend above names it, no event row carries it in mock mode
      expect(res.body).toContain('new_post');
      expect(res.body).toContain('cards');
    });

    it('marks simulated messages in the inbox thread', async () => {
      const conv = await db.one(`SELECT id FROM conversations WHERE external_user_id = 'CUST1'`);
      const res = await get(`/app/inbox/${conv.id}/part/thread`);
      expect(res.body).toContain('SIMULATED');
      expect(res.body).not.toContain('chip ok">DELIVERED');
    });

    it('saves a post\'s products from the dashboard form (one or several), and "no product"', async () => {
      const p = (await db.one(`SELECT id FROM ig_posts WHERE workspace_id = $1 AND media_id = 'mock_media_1004'`, [ws.workspaceId]))!;
      expect((await post(`/app/posts/${p.id}/products`, {})).headers.location).toContain('post_none'); // nothing ticked
      const bags = await db.q(`SELECT id FROM products WHERE workspace_id = $1 AND sku IN ('BG-001', 'BG-002') ORDER BY sku`, [ws.workspaceId]);
      const res = await post(`/app/posts/${p.id}/products`, { products: bags.map((b) => b.id) });
      expect(res.headers.location).toContain('post_saved');
      expect(
        await db.one(`SELECT product_state, (SELECT count(*)::int FROM post_products WHERE post_id = $1) AS n FROM ig_posts WHERE id = $1`, [p.id]),
      ).toEqual({ product_state: 'assigned', n: 2 });
      expect((await post(`/app/posts/${p.id}/skip`)).headers.location).toContain('post_skipped');
      expect(
        await db.one(`SELECT product_state, (SELECT count(*)::int FROM post_products WHERE post_id = $1) AS n FROM ig_posts WHERE id = $1`, [p.id]),
      ).toEqual({ product_state: 'skipped', n: 0 });
    });

    it('adds and deactivates catalog products; a deactivated product is no longer offered', async () => {
      expect((await post('/app/catalog', { sku: 'NEW-1', name: 'Yeni kəmər', price: '19.9', description: 'Dəri' })).headers.location).toContain(
        'catalog_saved',
      );
      const row = await db.one(`SELECT id, price FROM products WHERE workspace_id = $1 AND sku = 'NEW-1'`, [ws.workspaceId]);
      expect(row.price).toBe('19.90');
      expect((await post('/app/catalog', { sku: 'BAD', name: 'x', price: '1', image_url: 'http://insecure.example/x.png' })).headers.location).toContain(
        'invalid',
      );
      await post(`/app/catalog/${row.id}/toggle`);
      expect((await db.one(`SELECT active FROM products WHERE id = $1`, [row.id])).active).toBe(false);
    });

    it('the simulator forms run the same pipeline: comment -> worker -> carousel', async () => {
      fake.reset();
      const res = await post('/app/dev/comment', { media: 'mock_media_1002', text: 'qiymət neçədir', user: 'sevinc' });
      expect(res.headers.location).toContain('sim_queued');
      await drainAll();
      const cards = await eventsOf('cards');
      expect(cards.at(-1)!.summary).toContain('Jean şalvar');
      expect(fake.aiCalls()).toHaveLength(0);
      const page = await get('/app/dev');
      expect(page.body).toContain('Qiyməti göstər');
    });

    it("does not let the simulator be used for another business's Telegram chat", async () => {
      const other = await db.one(`SELECT chat_id FROM notify_targets WHERE workspace_id <> $1 LIMIT 1`, [ws.workspaceId]);
      const mine = (await db.one(`SELECT seq FROM ig_posts WHERE workspace_id = $1 AND media_id = 'mock_media_1004'`, [ws.workspaceId]))!;
      await post('/app/dev/telegram-press', { chat: other.chat_id, message: '1', data: `pn:${mine.seq}` });
      expect((await db.one(`SELECT product_state FROM ig_posts WHERE seq = $1`, [mine.seq])).product_state).toBe('skipped'); // unchanged from the previous test
    });
  });
});
