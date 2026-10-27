import { createHmac } from 'node:crypto';
import { decrypt, decryptWithInfo, encrypt, searchKeys } from './crypto.js';
import { normalize } from './text.js';

/**
 * Message text at rest. Customer conversations are the most sensitive data we hold, so `messages.body` is stored
 * AES-256-GCM encrypted (enc = true) with the same key system as tokens (ENCRYPTION_KEY, rotation via
 * ENCRYPTION_KEY_PREVIOUS). A database dump, backup or read-only SQL access reveals no message text.
 *
 * Search uses a blind index: `search_tokens` holds keyed HMACs of each normalized word and of its first 3–6 letters,
 * so the inbox finds words and word beginnings ("çatdır" finds "Çatdırılma") without plaintext in the database.
 * Rows written before encryption (enc = false) are still read as plaintext and get sealed by maintenance.
 */

const MAX_TOKENS = 400;
const PREFIX_MIN = 3;
const PREFIX_MAX = 6;

const mac = (key: Buffer, term: string) => createHmac('sha256', key).update(term).digest('base64url').slice(0, 12);
const words = (text: string) =>
  normalize(text)
    .split(' ')
    .filter((w) => w && w.length <= 40);

/** Index terms of a text: each word and its 3..6-letter beginnings. */
export function indexTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const w of words(text)) {
    terms.add(w);
    for (let k = PREFIX_MIN; k <= Math.min(PREFIX_MAX, w.length - 1); k++) terms.add(w.slice(0, k));
    if (terms.size >= MAX_TOKENS) break;
  }
  return [...terms];
}

export interface Sealed {
  body: string;
  enc: true;
  search_tokens: string[];
}

/** Blind-index tokens of a text under the current key. */
export const searchTokensOf = (text: string) => indexTerms(text).map((t) => mac(searchKeys()[0]!, t));

/** Encrypted body + blind-index tokens for a new message row. */
export function sealBody(text: string): Sealed {
  return { body: encrypt(text), enc: true, search_tokens: searchTokensOf(text) };
}

/** Body of a media-only message (no caption); replaced by the media note (src/media.ts) once there is one. */
export const MEDIA_PLACEHOLDER = '[Customer sent an attachment (photo/voice/video/sticker) that cannot be viewed]';

/** A message as the AI and staff read it: the media note replaces the placeholder, or follows the caption. */
export const withNote = (body: string, note: string | null | undefined) => (!note ? body : body === MEDIA_PLACEHOLDER ? note : `${body}\n${note}`);

/** Opens body and media note of rows (`enc`, `media_text`) into `body`. */
export function openTurns<T extends { body: string; enc?: boolean | null; media_text?: string | null }>(rows: T[]): T[] {
  for (const r of rows) r.body = withNote(openBody(r), openText(r.media_text));
  return rows;
}

/** Plaintext of a stored message (legacy rows are plaintext). */
export const openBody = (row: { body: string; enc?: boolean | null }): string => (row.enc ? decrypt(row.body) : row.body);

/** Opens `body` in place on every row (rows must carry `enc`). */
export function openRows<T extends { body: string; enc?: boolean | null }>(rows: T[]): T[] {
  for (const r of rows) r.body = openBody(r);
  return rows;
}

/**
 * Tokens to search for, one group per query word (a message matches when it has a token from every group).
 * Words of 3+ letters match as word beginnings; groups hold one token per key so search works during key rotation.
 */
export function queryTokens(query: string): string[][] {
  return words(query)
    .slice(0, 8)
    .map((w) => (w.length < PREFIX_MIN ? w : w.slice(0, PREFIX_MAX)))
    .map((t) => searchKeys().map((k) => mac(k, t)));
}

/** Free text stored encrypted without a flag column (AI summaries, webhook payloads): `v1:` ciphertext or legacy plaintext. */
export const sealText = (s: string) => (s ? encrypt(s) : '');
export const openText = (s: string | null | undefined) => (s?.startsWith('v1:') ? decrypt(s) : (s ?? ''));

/** Re-seals a row under the current key during rotation; null when it is already current. */
export function resealIfStale(body: string): Sealed | null {
  const { plain, stale } = decryptWithInfo(body);
  return stale ? sealBody(plain) : null;
}
