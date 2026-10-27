import type { ReplyContext, Turn } from './ai.js';
import { aiConfig, estimateTokens } from './aiconfig.js';
import { normalize } from './text.js';
import { config } from './config.js';
import { one, q } from './db.js';
import { openRows, openText, sealText } from './messages.js';

export interface BuiltContext {
  history: Turn[];
  extra: ReplyContext;
  route: 'fast' | 'smart';
  /** Number of older messages not in history nor summary yet: when large, the caller queues a summary update. */
  unsummarized: number;
  /** Rough size for observability (chars/3.5); billing uses the API's own usage numbers. */
  estInputTokens: number;
}

const MIN_RECENT = 4;
const MAX_RECENT = 20;
const ALWAYS_KINDS = new Set(['forbidden', 'handoff', 'policy']); // rules the AI must always respect

const MAX_ITEMS = 8;

/**
 * Picks knowledge items relevant to the customer's text within a token budget. Keyword hits weigh most; shared words
 * are weighted by rarity (IDF) so words present in most items ("model", "qiymət") don't drag the whole catalogue in.
 */
export function selectKnowledge(items: { kind: string; title: string; body: string; keywords: string[] }[], query: string, budget: number): string {
  const nq = ` ${normalize(query)} `;
  const qWords = [...new Set(nq.trim().split(' ').filter((w) => w.length > 2))];
  const docs = items.map((it) => new Set(normalize(`${it.title} ${it.body}`).split(' ')));
  const hit = (words: Set<string>, w: string) => words.has(w) || [...words].some((x) => x.length > 4 && w.length > 4 && (x.startsWith(w) || w.startsWith(x)));
  const idf = new Map(qWords.map((w) => {
    const df = docs.filter((d) => hit(d, w)).length;
    return [w, df === 0 || df > Math.max(3, items.length * 0.3) ? 0 : Math.log(1 + items.length / df)];
  }));
  const scored = items.map((it, i) => {
    const kw = it.keywords.map(normalize).filter((k) => k && nq.includes(` ${k} `)).length;
    let overlap = 0;
    for (const w of qWords) if (hit(docs[i]!, w)) overlap += idf.get(w)!;
    return { it, score: ALWAYS_KINDS.has(it.kind) ? 1000 : kw * 10 + overlap };
  });
  const top = Math.max(...scored.filter((x) => x.score < 1000).map((x) => x.score), 0);
  const picked: string[] = [];
  let used = 0;
  let regular = 0;
  for (const { it, score } of scored.sort((a, b) => b.score - a.score)) {
    if (score <= 0) break;
    const always = score >= 1000;
    if (!always && (regular >= MAX_ITEMS || score < top * 0.5)) continue;
    const block = `[${it.kind}] ${it.title}: ${it.body}`;
    const t = estimateTokens(block);
    if (used + t > budget) continue;
    picked.push(block);
    used += t;
    if (!always) regular++;
  }
  return picked.join('\n');
}

/**
 * Small knowledge bases go whole into the cached prefix (cheapest on cache hits, nothing can be missed); larger ones
 * fall back to per-message retrieval so the prompt stays bounded however big the catalogue grows.
 */
export function planKnowledge(items: { kind: string; title: string; body: string; keywords: string[] }[], query: string): { pinned: string; knowledge: string } {
  const all = items.map((it) => `[${it.kind}] ${it.title}: ${it.body}`).join('\n');
  if (estimateTokens(all) <= aiConfig.limits.pinned_knowledge_token_budget) return { pinned: all, knowledge: '' };
  return { pinned: '', knowledge: selectKnowledge(items, query, aiConfig.limits.knowledge_token_budget) };
}

const COMPLEX = /(şikayət|sikayet|problem|qaytar|geri|refund|zəmanət|zemanet|sifariş|sifaris|order|ödəniş|odenis|kart|endirim|razılaş|niyə|niye|почему|жалоб|заказ)/i;

/** Simple, short questions go to the fast model; anything long, multi-part or sensitive to the smart one. */
export function chooseRoute(latest: string, turns: number, knowledgeChars: number): 'fast' | 'smart' {
  if (config.AI_ROUTING === 'off') return 'smart';
  const questions = (latest.match(/\?/g) ?? []).length;
  return latest.length <= 160 && questions <= 1 && turns <= MAX_RECENT && knowledgeChars <= 2500 && !COMPLEX.test(latest) ? 'fast' : 'smart';
}

/**
 * Context for one reply: recent turns within the history budget (never fewer than MIN_RECENT), the rolling summary
 * of older turns, and only the knowledge items relevant to the latest messages.
 */
export async function buildContext(conversationId: string, workspaceId: string): Promise<BuiltContext> {
  const conv = await loadSummary(conversationId);
  const rows = openRows(await q<{ sender: string; body: string; enc: boolean; created_at: Date }>(
    `SELECT sender, body, enc, created_at FROM messages WHERE conversation_id = $1 AND status IN ('received', 'sent') AND created_at > coalesce($2, '-infinity'::timestamptz)
     ORDER BY created_at DESC LIMIT 60`,
    [conversationId, conv?.summary_upto ?? null],
  ));
  const budget = aiConfig.limits.history_token_budget;
  const recent: typeof rows = [];
  let used = 0;
  for (const m of rows) {
    const t = estimateTokens(m.body);
    if (recent.length >= MAX_RECENT || (recent.length >= MIN_RECENT && used + t > budget)) break;
    recent.push(m);
    used += t;
  }
  recent.reverse();
  const history: Turn[] = recent.map((m) => ({ role: m.sender === 'customer' ? 'user' : 'assistant', text: m.body }));
  const latestInbound = recent.filter((m) => m.sender === 'customer').slice(-3).map((m) => m.body).join(' ');
  // Stable order (by id) so the pinned block is byte-identical across conversations and stays cached.
  const items = await q(`SELECT kind, title, body, keywords FROM knowledge_items WHERE workspace_id = $1 AND active ORDER BY id LIMIT 500`, [workspaceId]);
  const { pinned, knowledge } = planKnowledge(items, latestInbound);
  const lastText = recent.at(-1)?.body ?? '';
  return {
    history,
    extra: { pinnedKnowledge: pinned || undefined, knowledge, summary: conv?.summary || undefined },
    route: chooseRoute(lastText, history.length, knowledge.length),
    unsummarized: rows.length - recent.length,
    estInputTokens: used + estimateTokens(pinned) + estimateTokens(knowledge) + estimateTokens(conv?.summary ?? ''),
  };
}

/** Rolling summary of older turns (stored encrypted: it is conversation content too). */
async function loadSummary(conversationId: string) {
  const row = await one<{ summary: string; summary_upto: Date | null }>(`SELECT summary, summary_upto FROM conversations WHERE id = $1`, [conversationId]);
  return row && { ...row, summary: openText(row.summary) };
}

/** Folds turns older than the newest MIN_RECENT*2 into the rolling summary (run by the worker, off the reply path). */
export async function updateSummary(conversationId: string, workspaceId: string): Promise<void> {
  const { summarizeTurns } = await import('./ai.js');
  const conv = await loadSummary(conversationId);
  const rows = openRows(await q<{ sender: string; body: string; enc: boolean; created_at: Date }>(
    `SELECT sender, body, enc, created_at FROM messages WHERE conversation_id = $1 AND status IN ('received', 'sent') AND created_at > coalesce($2, '-infinity'::timestamptz) ORDER BY created_at`,
    [conversationId, conv?.summary_upto ?? null],
  ));
  const older = rows.slice(0, Math.max(0, rows.length - MIN_RECENT * 2));
  if (older.length < aiConfig.limits.summary_after_messages / 2) return;
  const summary = await summarizeTurns(conv?.summary ?? '', older.map((m) => ({ role: m.sender === 'customer' ? 'user' : 'assistant', text: m.body })), { workspaceId, conversationId, purpose: 'summary' });
  if (summary) await q(`UPDATE conversations SET summary = $2, summary_upto = $3 WHERE id = $1`, [conversationId, sealText(summary), older.at(-1)!.created_at]);
}
