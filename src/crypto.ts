import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Two key sets, so one leaked key is not everything (audit H-1):
 * - content keys (ENCRYPTION_KEY): message text, summaries, notes, queued job payloads, webhook bodies -> "v1:" ciphertext;
 * - secret keys (SECRETS_ENCRYPTION_KEY): Meta channel tokens, webhook signing secrets, 2FA secrets, push subscriptions
 *   -> "s1:" ciphertext. Without SECRETS_ENCRYPTION_KEY (development) secrets fall back to the content key and are
 *   written as "v1:"; once it is set, maintenance moves them to "s1:".
 * Each set is [current, previous?]: *_PREVIOUS is only set during a key rotation.
 */
const load = (name: string) => {
  const list = [process.env[name], process.env[`${name}_PREVIOUS`]].filter(Boolean).map((k) => Buffer.from(k!, 'base64'));
  if (list.some((k) => k.length !== 32)) throw new Error(`${name} must be 32 bytes base64`);
  return list;
};
let keys: Buffer[] | undefined;
function getKeys(): Buffer[] {
  if (!keys) {
    keys = load('ENCRYPTION_KEY');
    if (keys[0]?.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes base64');
  }
  return keys;
}
let secretKeyList: Buffer[] | undefined;
/** The secret key set, or null when SECRETS_ENCRYPTION_KEY is not configured. */
function secretKeys(): Buffer[] | null {
  secretKeyList ??= load('SECRETS_ENCRYPTION_KEY');
  return secretKeyList.length ? secretKeyList : null;
}
export const secretsKeyConfigured = () => !!secretKeys();

let indexKeys: Buffer[] | undefined;
/** Keys for blind search indexes, derived from [current, previous?] encryption keys (never used for encryption). */
export function searchKeys(): Buffer[] {
  indexKeys ??= getKeys().map((k) => Buffer.from(hkdfSync('sha256', k, Buffer.alloc(0), 'ai-reply/search-index/v1', 32)));
  return indexKeys;
}

function seal(prefix: 'v1' | 's1', key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [prefix, iv, c.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join(':');
}

/** AES-256-GCM with the content key. Format: v1:<iv>:<tag>:<ciphertext> (base64url). */
export const encrypt = (plain: string): string => seal('v1', getKeys()[0]!, plain);

/** AES-256-GCM with the secrets key (s1:...), or the content key while none is configured. */
export function encryptSecret(plain: string): string {
  const sk = secretKeys();
  return sk ? seal('s1', sk[0]!, plain) : encrypt(plain);
}

/**
 * Decrypts with the key set the prefix names, current key first, then the previous one during a rotation.
 * stale = written under a previous key, or a secret still under the content key: re-encrypt it.
 */
export function decryptWithInfo(payload: string): { plain: string; stale: boolean } {
  const [v, iv, tag, ct] = payload.split(':');
  if ((v !== 'v1' && v !== 's1') || !iv || !tag || !ct) throw new Error('Unsupported ciphertext');
  const set = v === 's1' ? secretKeys() : getKeys();
  if (!set) throw new Error('Unable to decrypt (SECRETS_ENCRYPTION_KEY is not set)');
  for (const [i, key] of set.entries()) {
    try {
      const t = Buffer.from(tag, 'base64url');
      if (t.length !== 16) throw new Error('bad tag length'); // never accept truncated GCM tags
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
      d.setAuthTag(t);
      return { plain: Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'), stale: i > 0 };
    } catch {
      // try next key
    }
  }
  throw new Error(v === 's1' ? 'Unable to decrypt (wrong SECRETS_ENCRYPTION_KEY)' : 'Unable to decrypt (wrong ENCRYPTION_KEY)');
}

/** Like decryptWithInfo, for a secret column: also stale while it is still under the content key. */
export function decryptSecretWithInfo(payload: string): { plain: string; stale: boolean } {
  const r = decryptWithInfo(payload);
  return { plain: r.plain, stale: r.stale || (payload.startsWith('v1:') && !!secretKeys()) };
}

export const decrypt = (payload: string) => decryptWithInfo(payload).plain;

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const randomDigits = (n: number) => Array.from({ length: n }, () => randomInt(10)).join('');
export const sha256 = (s: string) => createHash('sha256').update(s).digest();
export const hmacSha256 = (key: string, data: string | Buffer) => createHmac('sha256', key).update(data).digest();

export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Verifies Meta's X-Hub-Signature-256 header over the raw request body. */
export function verifyMetaSignature(raw: Buffer | undefined, header: string | undefined, secrets: (string | undefined)[]): boolean {
  if (!raw || !header?.startsWith('sha256=')) return false;
  const sig = Buffer.from(header.slice(7), 'hex');
  return secrets.some((s) => s && safeEqual(sig, hmacSha256(s, raw)));
}

/** Parses and verifies a Meta `signed_request` (deauthorize / data deletion callbacks). */
export function parseSignedRequest(signedRequest: string, secrets: (string | undefined)[]): Record<string, unknown> | null {
  const [sigB64, payloadB64] = signedRequest.split('.');
  if (!sigB64 || !payloadB64) return null;
  const sig = Buffer.from(sigB64, 'base64url');
  if (!secrets.some((s) => s && safeEqual(sig, hmacSha256(s, payloadB64)))) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    return payload?.algorithm?.toUpperCase() === 'HMAC-SHA256' ? payload : null;
  } catch {
    return null;
  }
}
