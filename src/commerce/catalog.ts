import { one, q } from '../db.js';
import type { Card } from '../integrations/types.js';

export interface Product {
  id: string;
  seq: string;
  workspace_id: string;
  sku: string;
  name: string;
  description: string;
  price: string;
  currency: string;
  image_url: string;
  active: boolean;
}

/** Carousels hold 10 cards at most (Meta), and a post can therefore carry 10 products. */
export const MAX_PRODUCTS_PER_POST = 10;

/** "45.00" -> "45", "45.50" -> "45.50": prices are shown the way a shop writes them. */
export const formatPrice = (price: string | number) => {
  const n = Number(price);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};
export const priceLabel = (p: Pick<Product, 'price' | 'currency'>) => `${formatPrice(p.price)} ${p.currency}`;

export const listProducts = (workspaceId: string, opts: { activeOnly?: boolean } = {}) =>
  q<Product>(`SELECT * FROM products WHERE workspace_id = $1 ${opts.activeOnly ? 'AND active' : ''} ORDER BY name, id LIMIT 500`, [workspaceId]);

/** The price source of truth: always read from PostgreSQL at answer time, scoped to the business. */
export const productBySeq = (workspaceId: string, seq: string | number) =>
  one<Product>(`SELECT * FROM products WHERE workspace_id = $1 AND seq = $2`, [workspaceId, seq]);

export async function createProduct(
  workspaceId: string,
  p: { sku: string; name: string; description?: string; price: number; currency?: string; imageUrl?: string },
): Promise<Product> {
  return (await one<Product>(
    `INSERT INTO products (workspace_id, sku, name, description, price, currency, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workspace_id, sku) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, price = EXCLUDED.price,
       currency = EXCLUDED.currency, image_url = EXCLUDED.image_url, updated_at = now()
     RETURNING *`,
    [workspaceId, p.sku, p.name, p.description ?? '', p.price, p.currency ?? 'AZN', p.imageUrl ?? ''],
  ))!;
}

/** The predefined answer once a customer picked a product (price and description straight from the database row). */
export const productAnswer = (p: Pick<Product, 'name' | 'price' | 'currency' | 'description'>) =>
  `${p.name} — ${priceLabel(p)} 💰${p.description ? `\n${p.description}` : ''}\nSifariş vermək və ya sual vermək üçün bu söhbətə yazın 🙏`;

export const productUnavailableAnswer = () => 'Bağışlayın, bu məhsul artıq satışda deyil. Başqa məhsul haqqında soruşa bilərsiniz 🙏';

/** Callback payload of a card's button; resolved with the business id on the way back (productBySeq). */
export const PRODUCT_PAYLOAD = /^prod:(\d{1,18})$/;
export const productPayload = (p: Pick<Product, 'seq'>) => `prod:${p.seq}`;

export function productCard(p: Pick<Product, 'seq' | 'name' | 'description' | 'image_url'>): Card {
  return {
    title: p.name,
    subtitle: p.description || undefined,
    imageUrl: p.image_url || undefined,
    buttons: [{ type: 'postback', title: 'Qiyməti göstər', payload: productPayload(p) }],
  };
}

/** "Name price currency" lines the reply guard may treat as stated business facts (an AI follow-up quoting a catalog price). */
export async function catalogFacts(workspaceId: string): Promise<string> {
  const rows = await q<Pick<Product, 'name' | 'price' | 'currency'>>(
    `SELECT name, price, currency FROM products WHERE workspace_id = $1 AND active LIMIT 500`,
    [workspaceId],
  );
  return rows.map((p) => `${p.name} ${priceLabel(p)}`).join('\n');
}
