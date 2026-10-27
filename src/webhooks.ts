import { lookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { config } from './config.js';
import { decrypt, hmacSha256 } from './crypto.js';
import { one, q } from './db.js';
import { audit } from './events.js';
import { openText, sealText } from './messages.js';
import { queue } from './queue.js';

/**
 * Outgoing webhooks: the integration point for Google Sheets (via Apps Script / Make / Zapier), CRMs and custom
 * backends. Each delivery is signed (HMAC-SHA256 over "<timestamp>.<body>") and retried by the worker.
 */
export const WEBHOOK_EVENTS = {
  'message.received': 'Yeni gələn mesaj',
  'conversation.handoff': 'Söhbət operatora keçdi',
  'contact.tag_added': 'Kontakta tag əlavə olundu',
  'automation.run_finished': 'Avtomatlaşdırma icrası bitdi',
} as const;
export type WebhookEvent = keyof typeof WEBHOOK_EVENTS;

/** Payloads carry message text and contact names: stored encrypted until delivered (kept 14 days for retries). */
export const sealPayload = (payload: Record<string, unknown>) => ({ enc: sealText(JSON.stringify(payload)) });
const openPayload = (stored: { enc?: string } & Record<string, unknown>) => (typeof stored.enc === 'string' ? JSON.parse(openText(stored.enc)) : stored);

const ATTEMPTS = 6;
const DISABLE_AFTER = 50; // consecutive failed deliveries
const TIMEOUT_MS = 10_000;

/** Queues a signed delivery to every active webhook of the workspace subscribed to the event. Never throws. */
export async function emit(workspaceId: string, event: WebhookEvent, data: Record<string, unknown>): Promise<void> {
  try {
    const hooks = await q<{ id: string }>(`SELECT id FROM webhooks WHERE workspace_id = $1 AND active AND $2 = ANY(events)`, [workspaceId, event]);
    for (const h of hooks) {
      const payload = { event, created_at: new Date().toISOString(), data };
      const d = await one<{ id: string }>(`INSERT INTO webhook_deliveries (webhook_id, workspace_id, event, payload) VALUES ($1, $2, $3, $4) RETURNING id`, [
        h.id,
        workspaceId,
        event,
        sealPayload(payload),
      ]);
      await queue.add(
        'webhook',
        { kind: 'webhook', deliveryId: d!.id },
        { jobId: `wh-${d!.id}`, attempts: ATTEMPTS, backoff: { type: 'exponential', delay: 30_000 } },
      );
    }
  } catch {
    // Integrations must never break message handling.
  }
}

const V4_BLOCK = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  V4_BLOCK.addSubnet(net, bits, 'ipv4');
const V6_BLOCK = new BlockList();
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
] as const)
  V6_BLOCK.addSubnet(net, bits, 'ipv6');

/** IPv4 hidden inside an IPv6 address (::ffff:a.b.c.d / ::ffff:7f00:1 and their long forms), or null. */
function embeddedV4(ip6: string): string | null {
  const host = URL.parse(`http://[${ip6}]/`)?.hostname.slice(1, -1).toLowerCase(); // canonical compressed form
  const m = host && /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!m) return host?.startsWith('::ffff:') && isIP(host.slice(7)) === 4 ? host.slice(7) : null;
  const hi = parseInt(m[1]!, 16),
    lo = parseInt(m[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** Private, loopback, link-local, CGNAT, multicast and reserved ranges, including IPv4 embedded in IPv6 (SSRF protection). */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return V4_BLOCK.check(ip, 'ipv4');
  if (v === 6) {
    const v4 = embeddedV4(ip);
    return v4 ? V4_BLOCK.check(v4, 'ipv4') : V6_BLOCK.check(ip, 'ipv6');
  }
  return true; // not an IP address: refuse
}

const allowPrivate = () => !config.isProd && process.env.WEBHOOK_ALLOW_PRIVATE === '1'; // local testing only

/** Validates a webhook URL when it is saved (the address is checked again at connect time). */
export function validateWebhookUrl(raw: string): string | null {
  const u = URL.parse(raw);
  if (!u || u.username || u.password) return null;
  if (u.protocol !== 'https:' && !(allowPrivate() && u.protocol === 'http:')) return null;
  if (
    !allowPrivate() &&
    (u.hostname === 'localhost' ||
      u.hostname.endsWith('.local') ||
      u.hostname.endsWith('.internal') ||
      (isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(u.hostname.replace(/^\[|\]$/g, ''))))
  )
    return null;
  return u.toString();
}

// Resolves and checks every address at connect time, so DNS rebinding can't point an accepted host at the LAN.
const safeLookup: LookupFunction = (host, opts, cb) =>
  lookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err, '', 0);
    const list = (addrs as unknown as { address: string; family: number }[]) ?? [];
    const bad = !allowPrivate() && list.some((a) => isPrivateAddress(a.address));
    if (bad || !list.length) return cb(new Error('blocked address'), '', 0);
    if ((opts as { all?: boolean }).all) return (cb as unknown as (e: null, a: typeof list) => void)(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });

export function signature(secret: string, timestamp: string, body: string) {
  return `sha256=${hmacSha256(secret, `${timestamp}.${body}`).toString('hex')}`;
}

function post(url: string, body: string, headers: Record<string, string>): Promise<number> {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method: 'POST',
        lookup: safeLookup,
        timeout: TIMEOUT_MS,
        headers: { 'content-type': 'application/json', 'user-agent': 'AI-Reply-Webhooks/1', ...headers },
      },
      (res) => {
        res.resume(); // body ignored; redirects are not followed
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Coarse, tenant-visible reason for a failed delivery. Raw socket errors ("connect ECONNREFUSED 1.2.3.4:443") would
 * let a tenant use webhooks to probe which hosts and ports are open.
 */
export function errorCategory(e: unknown): string {
  const msg = String((e as Error)?.message ?? '');
  const code = String((e as { code?: unknown })?.code ?? '');
  if (msg === 'timeout') return 'vaxt bitdi';
  if (msg === 'blocked address') return 'ünvan bloklanıb';
  if (/ENOTFOUND|EAI_AGAIN/.test(code + msg)) return 'domen tapılmadı';
  if (/CERT|SSL|TLS/i.test(code + msg)) return 'TLS xətası';
  return 'bağlantı alınmadı';
}

/** Worker entry: one attempt. Throws to let BullMQ retry; records the outcome either way. */
export async function deliverWebhook(deliveryId: string, attempt: number, final: boolean): Promise<void> {
  const d = await one(`SELECT d.*, w.url, w.secret_enc, w.active FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = $1`, [
    deliveryId,
  ]);
  if (d?.status !== 'pending' || !d.active) return;
  const body = JSON.stringify({ id: d.id, ...openPayload(d.payload) });
  const ts = String(Math.floor(Date.now() / 1000));
  let code = 0;
  let error = '';
  try {
    code = await post(d.url, body, {
      'x-aireply-event': d.event,
      'x-aireply-delivery': d.id,
      'x-aireply-timestamp': ts,
      'x-aireply-signature': signature(decrypt(d.secret_enc), ts, body),
    });
    if (code < 200 || code >= 300) error = `HTTP ${code}`;
  } catch (e) {
    error = errorCategory(e);
  }
  const permanent = code >= 400 && code < 500 && code !== 408 && code !== 429;
  const done = !error || permanent || final;
  const status = !error ? 'sent' : done ? 'failed' : 'pending';
  await q(
    `UPDATE webhook_deliveries SET attempts = $2, response_code = $3, error = $4, status = $5, delivered_at = CASE WHEN $5 = 'sent' THEN now() END WHERE id = $1`,
    [d.id, attempt, code || null, error, status],
  );
  if (status === 'sent') await q(`UPDATE webhooks SET consecutive_failures = 0, last_status = 'ok', last_delivery_at = now() WHERE id = $1`, [d.webhook_id]);
  if (status === 'failed') {
    const w = await one(
      `UPDATE webhooks SET consecutive_failures = consecutive_failures + 1, last_status = $2, last_delivery_at = now() WHERE id = $1 RETURNING consecutive_failures, workspace_id`,
      [d.webhook_id, error],
    );
    if (w && w.consecutive_failures >= DISABLE_AFTER) {
      await q(`UPDATE webhooks SET active = false WHERE id = $1`, [d.webhook_id]);
      await audit(w.workspace_id, null, 'webhook.disabled', 'webhook', d.webhook_id, { reason: `${DISABLE_AFTER} ardıcıl uğursuz çatdırılma` });
    }
  }
  if (status === 'pending') throw new Error(error); // BullMQ retries with backoff
}
