/**
 * Deterministic last check on AI text before it reaches a customer. The model is told to use only business facts,
 * but nothing guarantees it; this catches the two failures that cost money or enable fraud:
 * - an amount of money that appears nowhere in the business's own information;
 * - a link to a domain the business never mentioned (phishing via prompt injection).
 */
const MONEY = /(?:(\d+(?:[.,]\d+)?)\s*(?:azn|₼|manat|man\b)|(?:₼|azn)\s*(\d+(?:[.,]\d+)?))/giu;
const URLISH =
  /\b(?:https?:\/\/|www\.)([^\s/?#<>"']+)|\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:az|com|net|org|ru|tr|me|io|link|shop|store|site|online|xyz|top|info|biz|ly|gl|co))\b/giu;

const num = (s: string) => String(Number(s.replace(',', '.')));
const numbersIn = (facts: string) => new Set([...facts.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => num(m[0])));
const domain = (h: string) =>
  h
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[.,;:!)]+$/, '');

export function checkReply(text: string, facts: string): { ok: true } | { ok: false; reason: 'unverified_price' | 'unverified_link'; detail: string } {
  const known = numbersIn(facts);
  for (const m of text.matchAll(MONEY)) {
    const n = m[1] ?? m[2];
    if (n && !known.has(num(n))) return { ok: false, reason: 'unverified_price', detail: m[0].trim() };
  }
  const factsLower = facts.toLowerCase();
  for (const m of text.matchAll(URLISH)) {
    const d = domain(m[1] ?? m[2] ?? '');
    if (d && !factsLower.includes(d)) return { ok: false, reason: 'unverified_link', detail: d };
  }
  return { ok: true };
}
