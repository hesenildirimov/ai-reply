/**
 * Deterministic last check on AI text before it reaches a customer. The model is told to use only business facts,
 * but nothing guarantees it; this catches the two failures that cost money or enable fraud:
 * - an amount of money that appears nowhere in the business's own information;
 * - a link to a domain the business never mentioned (phishing via prompt injection).
 */
// Currencies customers in AZ/TR/RU/EN markets write, Latin and Cyrillic ("50 манат", "50 ман.", "$10", "10 USD-dir").
// After a number: codes, symbols and words; before a number only symbols and codes ("try 10" is not a price).
// Short words are whole words only ("10 man" yes, "10 mangal" no). Extend when a new market is added.
const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const CUR_AFTER = String.raw`(?:₼|\$|€|₺|₽|(?:azn|manat\p{L}*|man|usd|dollar\p{L}*|dolar\p{L}*|eur|euro\p{L}*|avro|tl|lira|try|rub|rubl\p{L}*|азн|манат\p{L}*|ман|руб\p{L}*|доллар\p{L}*|евро|лир\p{L}*)(?!\p{L}))`;
const CUR_BEFORE = String.raw`(?:₼|\$|€|₺|₽|(?:azn|usd|eur|rub|азн)(?!\p{L}))`;
const MONEY = new RegExp(String.raw`(?:${NUM}\s*${CUR_AFTER}|${CUR_BEFORE}\s*${NUM})`, 'giu');
const URLISH =
  /\b(?:https?:\/\/|www\.)([^\s/?#<>"']+)|\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:az|com|net|org|ru|tr|me|io|link|shop|store|site|online|xyz|top|info|biz|ly|gl|co))\b/giu;

const num = (s: string) => String(Number(s.replace(',', '.')));
// Short numbers only: long digit runs (phones, IBANs, card or order numbers) must not whitelist a price.
const numbersIn = (facts: string) => new Set([...facts.matchAll(/(?<![\d+])\d{1,6}(?:[.,]\d+)?(?!\d)/g)].map((m) => num(m[0])));
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
