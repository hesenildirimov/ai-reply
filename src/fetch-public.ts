import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { allowPrivate, isPrivateAddress, safeLookup } from './webhooks.js';

/**
 * Fetches a public web page for the knowledge base (a customer-supplied URL, so SSRF rules apply): http(s) only,
 * every resolved address checked at connect time (no LAN, cloud metadata or DNS rebinding), at most 3 redirects,
 * a size cap and a timeout. Returns the body as text with its content type.
 */
export async function fetchPublic(raw: string, maxBytes = 2 * 1024 * 1024, hops = 3): Promise<{ url: string; type: string; body: string }> {
  const u = URL.parse(raw);
  if (!u || !['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('invalid url');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate() && (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || (isIP(host) && isPrivateAddress(host))))
    throw new Error('blocked address');
  const mod = u.protocol === 'https:' ? https : http;
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = mod.get(
      u,
      { lookup: safeLookup, timeout: 15_000, headers: { 'user-agent': 'AI-Reply-Knowledge/1', accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' } },
      resolve,
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
  const status = res.statusCode ?? 0;
  if (status >= 300 && status < 400 && res.headers.location) {
    res.resume();
    if (hops <= 0) throw new Error('too many redirects');
    return fetchPublic(new URL(res.headers.location, u).toString(), maxBytes, hops - 1);
  }
  if (status < 200 || status >= 300) {
    res.resume();
    throw new Error(`HTTP ${status}`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of res) {
    size += (c as Buffer).length;
    if (size > maxBytes) {
      res.destroy();
      throw new Error('page too large');
    }
    chunks.push(c as Buffer);
  }
  return {
    url: u.toString(),
    type: String(res.headers['content-type'] ?? '')
      .split(';')[0]!
      .trim(),
    body: Buffer.concat(chunks).toString('utf8'),
  };
}
