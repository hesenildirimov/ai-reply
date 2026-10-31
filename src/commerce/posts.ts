import type { ChannelRow } from '../channels/types.js';
import { config } from '../config.js';
import { one, q, tx } from '../db.js';
import { recordIntegrationEvent } from '../integrations/events.js';
import { igListRecentMedia } from '../integrations/ig.js';
import type { InlineButton } from '../integrations/types.js';
import { tgSend } from '../telegram.js';
import { MAX_PRODUCTS_PER_POST, type Product, priceLabel } from './catalog.js';

export interface PostRow {
  id: string;
  seq: string;
  workspace_id: string;
  channel_id: string;
  media_id: string;
  caption: string;
  media_type: string;
  permalink: string;
  thumb_url: string;
  posted_at: Date | null;
  detected_at: Date;
  source: 'meta' | 'mock';
  product_state: 'pending' | 'assigned' | 'skipped';
}

const TG_PRODUCT_ROWS = 10; // keyboard rows; matches the carousel limit

const baselineKey = (channelId: string) => `posts_baseline:${channelId}`;
export const markPostsBaseline = (channelId: string) =>
  q(`INSERT INTO app_meta (key, value) VALUES ($1, 'done') ON CONFLICT (key) DO NOTHING`, [baselineKey(channelId)]);

/**
 * New-post detection for one account. Instagram has no "new post" webhook, so the account's recent posts are listed (by
 * the configured provider) and compared with what is stored. The first run for an account only records what already
 * exists (baseline): a business must not get an alert per old post. Every genuinely new post creates a row, a dashboard
 * event and a Telegram message with the product picker. Safe to repeat: a post is announced once.
 */
export async function detectNewPosts(ch: ChannelRow): Promise<PostRow[]> {
  const media = await igListRecentMedia(ch);
  const baselined = !!(await one(`SELECT 1 FROM app_meta WHERE key = $1`, [baselineKey(ch.id)]));
  const fresh: PostRow[] = [];
  // Oldest first, so several new posts are announced in the order they were published.
  for (const m of [...media].reverse()) {
    const row = await one<PostRow>(
      `INSERT INTO ig_posts (workspace_id, channel_id, media_id, caption, media_type, permalink, thumb_url, posted_at, source, product_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (channel_id, media_id) DO NOTHING RETURNING *`,
      [
        ch.workspace_id,
        ch.id,
        m.id,
        m.caption,
        m.mediaType,
        m.permalink,
        m.thumbUrl,
        m.timestamp ? new Date(m.timestamp) : null,
        config.mockMode ? 'mock' : 'meta',
        baselined ? 'pending' : 'skipped', // posts that existed before the first run are not waiting for anything
      ],
    );
    if (row && baselined) fresh.push(row);
  }
  if (!baselined) await markPostsBaseline(ch.id);
  for (const post of fresh) await announcePost(post);
  return fresh;
}

/** Dashboard event + Telegram message with the product picker (one message per connected Telegram account). */
async function announcePost(post: PostRow): Promise<void> {
  await recordIntegrationEvent({
    workspaceId: post.workspace_id,
    provider: 'instagram',
    direction: 'in',
    kind: 'new_post',
    status: 'RECEIVED',
    summary: `Yeni post tapıldı: ${post.caption.slice(0, 120) || post.media_id}`,
    payload: { postId: post.id, mediaId: post.media_id },
    externalId: post.media_id,
  });
  const targets = await q<{ chat_id: string }>(`SELECT chat_id FROM notify_targets WHERE workspace_id = $1 AND kind = 'telegram'`, [post.workspace_id]);
  if (!targets.length) return;
  const products = await q<Product>(`SELECT * FROM products WHERE workspace_id = $1 AND active ORDER BY name, id LIMIT $2`, [
    post.workspace_id,
    TG_PRODUCT_ROWS,
  ]);
  const total = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM products WHERE workspace_id = $1 AND active`, [post.workspace_id]))!.n;
  const keyboard = pickerKeyboard(post, products, new Set());
  const text = pickerText(post, products.length, total);
  for (const t of targets) {
    await tgSend(t.chat_id, text, { workspaceId: post.workspace_id, keyboard, kind: 'new_post_picker' }).catch((e) =>
      console.error('new post telegram notification failed:', (e as Error).message),
    );
  }
}

export const pickerText = (post: Pick<PostRow, 'caption' | 'media_id'>, shown: number, total: number) =>
  `📸 Yeni post: ${post.caption.slice(0, 160) || post.media_id}\n\n${
    shown
      ? `Bu postda hansı məhsullar var? Seçib "Yadda saxla" basın.${total > shown ? `\nKataloqda ${total} məhsul var, burada ilk ${shown} göstərilir: qalanlarını paneldə (Postlar) seçin.` : ''}`
      : 'Kataloqda məhsul yoxdur: əvvəlcə paneldə məhsul əlavə edin.'
  }`;

/** Callback data (64 bytes max): pt:<post>:<product> toggles, pd:<post> saves, pn:<post> = no product. Numbers are the `seq` columns. */
export function pickerKeyboard(post: Pick<PostRow, 'seq'>, products: Product[], selected: Set<string>): InlineButton[][] {
  const rows: InlineButton[][] = products.map((p) => [
    { text: `${selected.has(p.id) ? '✅' : '⬜'} ${p.name} — ${priceLabel(p)}`, callbackData: `pt:${post.seq}:${p.seq}` },
  ]);
  rows.push([
    { text: '💾 Yadda saxla', callbackData: `pd:${post.seq}` },
    { text: '🚫 Məhsul yoxdur', callbackData: `pn:${post.seq}` },
  ]);
  return rows;
}

export const postBySeq = (seq: string | number) => one<PostRow>(`SELECT * FROM ig_posts WHERE seq = $1`, [seq]);
export const postById = (workspaceId: string, id: string) => one<PostRow>(`SELECT * FROM ig_posts WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
export const listPosts = (workspaceId: string, limit = 50) =>
  q<PostRow & { products: { id: string; name: string; price: string; currency: string }[] }>(
    `SELECT p.*, coalesce((SELECT json_agg(json_build_object('id', pr.id, 'name', pr.name, 'price', pr.price, 'currency', pr.currency) ORDER BY pp.position)
        FROM post_products pp JOIN products pr ON pr.id = pp.product_id WHERE pp.post_id = p.id), '[]') AS products
     FROM ig_posts p WHERE p.workspace_id = $1 ORDER BY p.detected_at DESC, p.seq DESC LIMIT $2`,
    [workspaceId, limit],
  );

export const selectedProductIds = async (postId: string) =>
  new Set((await q<{ product_id: string }>(`SELECT product_id FROM post_products WHERE post_id = $1`, [postId])).map((r) => r.product_id));

/** Active products of a post whose products were saved: what a comment under that post is answered from. */
export const productsOfPost = (workspaceId: string, channelId: string, mediaId: string) =>
  q<Product>(
    `SELECT pr.* FROM ig_posts p JOIN post_products pp ON pp.post_id = p.id JOIN products pr ON pr.id = pp.product_id
     WHERE p.workspace_id = $1 AND p.channel_id = $2 AND p.media_id = $3 AND p.product_state = 'assigned' AND pr.active
     ORDER BY pp.position, pr.name LIMIT ${MAX_PRODUCTS_PER_POST}`,
    [workspaceId, channelId, mediaId],
  );

export class PostProductError extends Error {}

/**
 * Saves the products of a post (replaces the previous selection). Products must belong to the same business (also
 * enforced by composite foreign keys). An empty list is refused: use skipPost for "this post has no product".
 */
export async function setPostProducts(workspaceId: string, postId: string, productIds: string[]): Promise<void> {
  const ids = [...new Set(productIds)];
  if (!ids.length) throw new PostProductError('empty');
  if (ids.length > MAX_PRODUCTS_PER_POST) throw new PostProductError('too_many');
  await tx(async (c) => {
    const post = (await c.query(`SELECT id FROM ig_posts WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, [postId, workspaceId])).rows[0];
    if (!post) throw new PostProductError('post');
    const ok = (await c.query(`SELECT id FROM products WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND active`, [workspaceId, ids])).rows.length;
    if (ok !== ids.length) throw new PostProductError('product');
    await c.query(`DELETE FROM post_products WHERE post_id = $1`, [postId]);
    for (const [i, id] of ids.entries()) {
      await c.query(`INSERT INTO post_products (post_id, product_id, workspace_id, position) VALUES ($1, $2, $3, $4)`, [postId, id, workspaceId, i]);
    }
    await c.query(`UPDATE ig_posts SET product_state = 'assigned' WHERE id = $1`, [postId]);
  });
}

/** "This post has no product": clears any selection; comments under it fall back to the usual handling. */
export async function skipPost(workspaceId: string, postId: string): Promise<boolean> {
  return tx(async (c) => {
    const post = (await c.query(`SELECT id FROM ig_posts WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, [postId, workspaceId])).rows[0];
    if (!post) return false;
    await c.query(`DELETE FROM post_products WHERE post_id = $1`, [postId]);
    await c.query(`UPDATE ig_posts SET product_state = 'skipped' WHERE id = $1`, [postId]);
    return true;
  });
}

/** Adds or removes one product in the post's draft selection (the Telegram picker); the state changes only on "Yadda saxla". */
export async function togglePostProduct(workspaceId: string, post: PostRow, product: Product): Promise<boolean> {
  return tx(async (c) => {
    await c.query(`SELECT 1 FROM ig_posts WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, [post.id, workspaceId]);
    const del = await c.query(`DELETE FROM post_products WHERE post_id = $1 AND product_id = $2 AND workspace_id = $3`, [post.id, product.id, workspaceId]);
    if (del.rowCount) return false;
    const n = (await c.query(`SELECT count(*)::int AS n FROM post_products WHERE post_id = $1`, [post.id])).rows[0].n as number;
    if (n >= MAX_PRODUCTS_PER_POST || !product.active) return false;
    await c.query(`INSERT INTO post_products (post_id, product_id, workspace_id, position) VALUES ($1, $2, $3, $4)`, [post.id, product.id, workspaceId, n]);
    return true;
  });
}

/** Posts still waiting for the business to pick products (dashboard notification). */
export const pendingPostCount = async (workspaceId: string) =>
  (await one<{ n: number }>(`SELECT count(*)::int AS n FROM ig_posts WHERE workspace_id = $1 AND product_state = 'pending'`, [workspaceId]))!.n;

/**
 * Worker job: new-post detection for every active Instagram account of a business that has a catalog (without products
 * there is nothing to attach a post to). Runs in mock mode and, in production, only once META_COMMERCE_VERIFIED=on.
 */
export async function sweepPosts(): Promise<number> {
  if (!config.commerceEnabled) return 0;
  const channels = await q<ChannelRow>(
    `SELECT c.* FROM channels c WHERE c.type = 'instagram' AND c.status = 'active' AND EXISTS (SELECT 1 FROM products p WHERE p.workspace_id = c.workspace_id AND p.active)`,
  );
  let found = 0;
  for (const ch of channels) {
    try {
      found += (await detectNewPosts(ch)).length;
    } catch (e) {
      console.error(`post detection failed for channel ${ch.id}:`, (e as Error).message);
    }
  }
  return found;
}
