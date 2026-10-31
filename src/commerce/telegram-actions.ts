import { one, q } from '../db.js';
import { recordIntegrationEvent } from '../integrations/events.js';
import { tgAnswerCallback, tgEditKeyboard, tgSend } from '../telegram.js';
import { listProducts, type Product } from './catalog.js';
import { type PostRow, pickerKeyboard, postBySeq, selectedProductIds, setPostProducts, skipPost, togglePostProduct } from './posts.js';

const DATA = /^(pt|pd|pn):(\d{1,18})(?::(\d{1,18}))?$/;

interface CallbackQuery {
  id?: string;
  data?: string;
  message?: { message_id?: number | string; chat?: { id?: number | string } };
}

/**
 * A press on an inline-keyboard button of the new-post message (real webhook or mock simulator).
 *   pt:<post>:<product>  toggle a product in the draft selection
 *   pd:<post>            save (needs at least one product)
 *   pn:<post>            "this post has no product"
 * The post number is global, so the business is taken from the post and the pressing chat must be one of that business's
 * linked Telegram accounts: a button from another business's chat changes nothing.
 */
export async function handleCatalogCallback(cb: CallbackQuery): Promise<void> {
  const answer = (text?: string) => (cb.id ? tgAnswerCallback(cb.id, text).catch(() => {}) : undefined);
  const m = typeof cb.data === 'string' ? DATA.exec(cb.data) : null;
  const chat = cb.message?.chat?.id;
  if (!m || chat === undefined) return void (await answer());
  const [, action, postSeq, productSeq] = m;
  const post = await postBySeq(postSeq!);
  const linked =
    post && (await one(`SELECT 1 FROM notify_targets WHERE workspace_id = $1 AND kind = 'telegram' AND chat_id = $2`, [post.workspace_id, String(chat)]));
  if (!post || !linked) return void (await answer('Bu əməliyyat üçün icazə yoxdur'));
  await recordIntegrationEvent({
    workspaceId: post.workspace_id,
    provider: 'telegram',
    direction: 'in',
    kind: 'callback',
    status: 'RECEIVED',
    summary: `Düymə: ${action === 'pt' ? 'məhsul seçimi' : action === 'pd' ? 'yadda saxla' : 'məhsul yoxdur'} (${post.caption.slice(0, 60) || post.media_id})`,
    payload: { data: cb.data },
  });

  if (action === 'pt') {
    const product = await one<Product>(`SELECT * FROM products WHERE workspace_id = $1 AND seq = $2`, [post.workspace_id, productSeq]);
    if (!product) return void (await answer('Məhsul tapılmadı'));
    await togglePostProduct(post.workspace_id, post, product);
    await refreshKeyboard(post, String(chat), cb.message?.message_id);
    return void (await answer());
  }
  if (action === 'pn') {
    await skipPost(post.workspace_id, post.id);
    await answer('Yadda saxlanıldı');
    await tgSend(String(chat), '🚫 Bu postda məhsul yoxdur: şərhlərə kataloqdan cavab verilməyəcək.', {
      workspaceId: post.workspace_id,
      kind: 'post_products_saved',
    });
    return;
  }
  // pd: save the draft selection
  const selected = [...(await selectedProductIds(post.id))];
  if (!selected.length) return void (await answer('Ən azı bir məhsul seçin'));
  await setPostProducts(post.workspace_id, post.id, selected);
  const names = await q<{ name: string }>(`SELECT name FROM products WHERE id = ANY($1::uuid[]) AND workspace_id = $2 ORDER BY name`, [
    selected,
    post.workspace_id,
  ]);
  await answer('Yadda saxlanıldı');
  await tgSend(
    String(chat),
    `✅ Post üçün ${names.length} məhsul yadda saxlanıldı: ${names.map((n) => n.name).join(', ')}.\nİndi bu postun altında "Qiymət?" yazanlara avtomatik cavab gedəcək.`,
    {
      workspaceId: post.workspace_id,
      kind: 'post_products_saved',
    },
  );
}

async function refreshKeyboard(post: PostRow, chat: string, messageId: number | string | undefined) {
  if (messageId === undefined) return;
  const products = (await listProducts(post.workspace_id, { activeOnly: true })).slice(0, 10);
  const keyboard = pickerKeyboard(post, products, await selectedProductIds(post.id));
  await tgEditKeyboard(chat, String(messageId), keyboard).catch(() => {});
}
