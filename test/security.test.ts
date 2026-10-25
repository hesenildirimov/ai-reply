import { createHmac, randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
});

describe('crypto', async () => {
  const c = await import('../src/crypto.js');

  it('encrypts and decrypts, rejects tampering', () => {
    const enc = c.encrypt('secret-token');
    expect(enc).not.toContain('secret-token');
    expect(c.decrypt(enc)).toBe('secret-token');
    const parts = enc.split(':');
    parts[3] = Buffer.from('x').toString('base64url');
    expect(() => c.decrypt(parts.join(':'))).toThrow();
  });

  it('verifies Meta webhook signatures', () => {
    const body = Buffer.from('{"a":1}');
    const sig = 'sha256=' + createHmac('sha256', 'app-secret').update(body).digest('hex');
    expect(c.verifyMetaSignature(body, sig, ['app-secret'])).toBe(true);
    expect(c.verifyMetaSignature(body, sig, [undefined, 'other', 'app-secret'])).toBe(true);
    expect(c.verifyMetaSignature(body, sig, ['wrong'])).toBe(false);
    expect(c.verifyMetaSignature(Buffer.from('{"a":2}'), sig, ['app-secret'])).toBe(false);
    expect(c.verifyMetaSignature(body, undefined, ['app-secret'])).toBe(false);
  });

  it('parses signed_request only with a valid signature', () => {
    const payload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '123' })).toString('base64url');
    const sig = createHmac('sha256', 's3cret').update(payload).digest('base64url');
    expect(c.parseSignedRequest(`${sig}.${payload}`, ['s3cret'])?.user_id).toBe('123');
    expect(c.parseSignedRequest(`${sig}.${payload}`, ['nope'])).toBeNull();
    expect(c.parseSignedRequest('garbage', ['s3cret'])).toBeNull();
  });
});

describe('html', async () => {
  const { html, raw } = await import('../src/web/html.js');
  it('escapes interpolations', () => {
    expect(html`<p>${'<script>"x"</script>'}</p>`.value).toBe('<p>&lt;script&gt;&quot;x&quot;&lt;/script&gt;</p>');
    expect(html`${['<a>', raw('<b>')]}`.value).toBe('&lt;a&gt;<b>');
  });
});

describe('totp', async () => {
  const t = await import('../src/totp.js');
  it('matches RFC 6238 test vector and blocks replay', () => {
    const secret = t.base32Encode(Buffer.from('12345678901234567890'));
    expect(t.totpCode(secret, Math.floor(59 / 30))).toBe('287082'); // RFC 6238 SHA-1, T=59s (last 6 digits)
    const now = 1_700_000_000_000;
    const code = t.totpCode(secret, t.currentStep(now));
    const step = t.verifyTotp(secret, code, 0, now);
    expect(step).toBe(t.currentStep(now));
    expect(t.verifyTotp(secret, code, step!, now)).toBeNull();
    expect(t.verifyTotp(secret, '000000', 0, now)).toBeNull();
  });
});
