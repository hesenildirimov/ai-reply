import { encryptSecret } from '../crypto.js';
import { one, q, tx } from '../db.js';
import { createProduct } from './catalog.js';
import { markPostsBaseline } from './posts.js';

/**
 * Development fixtures for INTEGRATION_MODE=mock: one demo business, one (simulated) Instagram account, a 12-product
 * catalog, FAQ records and four posts: one with a single product, one with several, one without a product and one still
 * waiting for the business to pick. Idempotent: running it again fills in what is missing and changes nothing else.
 */
export const DEMO_BUSINESS = 'Demo Butik';
export const DEMO_IG_ID = '17841400000000001';
export const DEMO_IG_NAME = '@demo.butik';

export const DEMO_PRODUCTS = [
  { sku: 'DR-001', name: 'Yay donu', description: 'Yüngül pambıq, S-L ölçülər', price: 45 },
  { sku: 'DR-002', name: 'Axşam donu', description: 'Qara, ipək astarlı', price: 129.9 },
  { sku: 'SH-001', name: 'Ağ köynək', description: 'Klassik kəsim, 100% pambıq', price: 39 },
  { sku: 'SH-002', name: 'Zolaqlı köynək', description: 'Yay kolleksiyası', price: 42.5 },
  { sku: 'JN-001', name: 'Jean şalvar', description: 'Yüksək belli, mavi', price: 69 },
  { sku: 'JN-002', name: 'Qara jean', description: 'Dar kəsim', price: 72 },
  { sku: 'JK-001', name: 'Dəri gödəkçə', description: 'Təbii dəri, qara', price: 349 },
  { sku: 'JK-002', name: 'Yağışlıq', description: 'Su keçirməyən, kapüşonlu', price: 89 },
  { sku: 'BG-001', name: 'Çiyin çantası', description: 'Qəhvəyi, fermuarlı', price: 59 },
  { sku: 'BG-002', name: 'Bel çantası', description: 'Kiçik, qara', price: 35 },
  { sku: 'SC-001', name: 'İpək şərf', description: '90x90 sm, çiçək naxışı', price: 28 },
  { sku: 'SN-001', name: 'İdman ayaqqabısı', description: '36-44 ölçülər, ağ', price: 119 },
] as const;

export const DEMO_FAQ = [
  {
    kind: 'delivery',
    title: 'Çatdırılma',
    body: 'Bakı daxili çatdırılma 5 AZN, sifariş 100 AZN-dən yuxarı olduqda pulsuzdur. Çatdırılma 1-2 iş günü.',
    keywords: ['çatdırılma', 'catdirilma', 'kuryer'],
  },
  { kind: 'policy', title: 'Qaytarma', body: 'Məhsulu 14 gün ərzində, etiketi çıxarılmamış halda qaytarmaq olar.', keywords: ['qaytarma', 'geri', 'dəyişmə'] },
  { kind: 'info', title: 'İş saatları', body: 'Hər gün 10:00-20:00. Bazar günü 11:00-18:00.', keywords: ['saat', 'iş vaxtı', 'açıqsınız'] },
  { kind: 'faq', title: 'Ölçülər', body: 'Paltarlar XS-XL ölçülərdə. Ölçü cədvəli profilin "Ölçülər" highlight-ındadır.', keywords: ['ölçü', 'olcu', 'size'] },
  { kind: 'faq', title: 'Ödəniş', body: 'Nağd (kuryerə) və kartla ödəmək olar.', keywords: ['ödəniş', 'odenis', 'kart'] },
] as const;

/** Posts: caption + the SKUs saved for it ([] = none) + state. */
export const DEMO_POSTS = [
  { mediaId: 'mock_media_1001', caption: 'Yeni yay donu ☀️ Qiymət və ölçülər üçün şərh yazın!', skus: ['DR-001'], state: 'assigned' },
  { mediaId: 'mock_media_1002', caption: 'Payız kolleksiyası: jean, köynək və gödəkçə 🍂', skus: ['JN-001', 'SH-001', 'JK-001'], state: 'assigned' },
  { mediaId: 'mock_media_1003', caption: 'Mağazamızdan bir kadr 📸 Bizi ziyarət edin!', skus: [], state: 'skipped' },
  { mediaId: 'mock_media_1004', caption: 'Çanta və aksesuarlar yenilənib 👜', skus: [], state: 'pending' },
] as const;

/** Creates the demo business (owner without a password: use the one-time link, see scripts/seed-mock.ts). */
export async function createDemoBusiness(ownerEmail: string): Promise<{ userId: string; workspaceId: string }> {
  const existing = await one<{ id: string; workspace_id: string }>(
    `SELECT u.id, m.workspace_id FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.email = $1`,
    [ownerEmail],
  );
  if (existing) return { userId: existing.id, workspaceId: existing.workspace_id };
  return tx(async (c) => {
    const u = (await c.query(`INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, '!', now()) RETURNING id`, [ownerEmail])).rows[0];
    const w = (await c.query(`INSERT INTO workspaces (name, monthly_reply_limit) VALUES ($1, 1000) RETURNING id`, [DEMO_BUSINESS])).rows[0];
    await c.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [w.id, u.id]);
    await c.query(`INSERT INTO assistants (workspace_id, enabled, business_name, knowledge) VALUES ($1, true, $2, $3)`, [
      w.id,
      DEMO_BUSINESS,
      'Qadın geyimi mağazası, Bakı. Çatdırılma və qaytarma qaydaları FAQ bölməsindədir.',
    ]);
    return { userId: u.id as string, workspaceId: w.id as string };
  });
}

/** Fills a workspace with the demo Instagram account, catalog, FAQ and posts. Returns the ids tests and the dashboard need. */
export async function seedDemoData(workspaceId: string) {
  // The simulated Instagram account. Its "token" is a placeholder: the mock provider never uses it.
  let channel = await one<{ id: string; external_id: string }>(`SELECT id, external_id FROM channels WHERE workspace_id = $1 AND type = 'instagram' LIMIT 1`, [
    workspaceId,
  ]);
  for (let attempt = 0; !channel; attempt++) {
    // Another demo workspace may already own the first id (an Instagram account id is unique): fall back to a random one.
    const igId = attempt === 0 ? DEMO_IG_ID : `${DEMO_IG_ID.slice(0, -6)}${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
    channel = await one(
      `INSERT INTO channels (workspace_id, type, external_id, display_name, access_token_enc, scopes)
       VALUES ($1, 'instagram', $2, $3, $4, '{instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments}')
       ON CONFLICT DO NOTHING RETURNING id, external_id`,
      [workspaceId, igId, DEMO_IG_NAME, encryptSecret('mock-token-not-a-secret')],
    );
  }

  const products: Record<string, string> = {};
  for (const p of DEMO_PRODUCTS) products[p.sku] = (await createProduct(workspaceId, p)).id;

  for (const f of DEMO_FAQ) {
    const has = await one(`SELECT 1 FROM knowledge_items WHERE workspace_id = $1 AND title = $2`, [workspaceId, f.title]);
    if (!has)
      await q(`INSERT INTO knowledge_items (workspace_id, kind, title, body, keywords) VALUES ($1, $2, $3, $4, $5)`, [
        workspaceId,
        f.kind,
        f.title,
        f.body,
        f.keywords,
      ]);
  }

  const posts: Record<string, string> = {};
  const base = Date.now();
  for (const [i, p] of DEMO_POSTS.entries()) {
    const posted = new Date(base - (DEMO_POSTS.length - i) * 86_400_000);
    await q(
      `INSERT INTO mock_ig_media (channel_id, media_id, caption, media_type, permalink, posted_at) VALUES ($1, $2, $3, 'IMAGE', $4, $5) ON CONFLICT DO NOTHING`,
      [channel.id, p.mediaId, p.caption, `https://www.instagram.com/p/${p.mediaId}/`, posted],
    );
    const row = (await one<{ id: string }>(
      `INSERT INTO ig_posts (workspace_id, channel_id, media_id, caption, media_type, permalink, posted_at, source, product_state)
       VALUES ($1, $2, $3, $4, 'IMAGE', $5, $6, 'mock', $7) ON CONFLICT (channel_id, media_id) DO UPDATE SET caption = ig_posts.caption RETURNING id`,
      [workspaceId, channel.id, p.mediaId, p.caption, `https://www.instagram.com/p/${p.mediaId}/`, posted, p.state],
    ))!;
    posts[p.mediaId] = row.id;
    if (p.skus.length) {
      await q(`DELETE FROM post_products WHERE post_id = $1`, [row.id]);
      for (const [pos, sku] of p.skus.entries())
        await q(`INSERT INTO post_products (post_id, product_id, workspace_id, position) VALUES ($1, $2, $3, $4)`, [row.id, products[sku], workspaceId, pos]);
    }
  }
  // These four exist already: only posts published after this point are "new".
  await markPostsBaseline(channel.id);
  return { channelId: channel.id, igId: channel.external_id, products, posts };
}
