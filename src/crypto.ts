import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

let keys: Buffer[] | undefined;
/** [current, previous?]. ENCRYPTION_KEY_PREVIOUS is only set during a key rotation. */
function getKeys(): Buffer[] {
  if (!keys) {
    keys = [process.env.ENCRYPTION_KEY, process.env.ENCRYPTION_KEY_PREVIOUS].filter(Boolean).map((k) => Buffer.from(k!, 'base64'));
    if (keys[0]?.length !== 32 || keys.some((k) => k.length !== 32)) throw new Error('ENCRYPTION_KEY must be 32 bytes base64');
  }
  return keys;
}
const getKey = () => getKeys()[0]!;

/** AES-256-GCM. Format: v1:<iv>:<tag>:<ciphertext> (base64url). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join(':');
}

/** Decrypts with the current key, falling back to the previous one during rotation. */
export function decryptWithInfo(payload: string): { plain: string; stale: boolean } {
  const [v, iv, tag, ct] = payload.split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported ciphertext');
  for (const [i, key] of getKeys().entries()) {
    try {
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return { plain: Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'), stale: i > 0 };
    } catch {
      // try next key
    }
  }
  throw new Error('Unable to decrypt (wrong ENCRYPTION_KEY)');
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
