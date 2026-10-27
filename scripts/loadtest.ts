/**
 * End-to-end load test: N businesses, their customers writing at once, the real web server and worker processes,
 * against a fake Meta Graph + Claude API with realistic latency.
 *
 *   LOADTEST_DATABASE_URL=postgres://... LOADTEST_REDIS_URL=redis://... npx tsx scripts/loadtest.ts \
 *     --businesses 500 --customers 4 --turns 2 --window 30 --workers 1 --concurrency 25 --inbound 50 --ai-ms 2500 --meta-ms 300
 *
 * DESTRUCTIVE: the database schema is dropped and Redis flushed. Point it only at disposable services.
 *
 * Measures: webhook ack latency, reply latency (webhook accepted -> send API called, minus the debounce), throughput,
 * queue depth, DB connections, and correctness: every customer answered exactly once per turn, no conversation
 * wrongly paused by Instagram echoes (the fake sends one per DM, ~30% of them before the send API has answered).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({
  options: {
    businesses: { type: 'string', default: '100' },
    customers: { type: 'string', default: '4' }, // per business
    turns: { type: 'string', default: '2' }, // messages per customer, each waits for the previous reply
    window: { type: 'string', default: '30' }, // seconds over which first messages are spread
    workers: { type: 'string', default: '1' }, // worker processes
    concurrency: { type: 'string', default: '25' },
    inbound: { type: 'string', default: '50' },
    pool: { type: 'string', default: '20' },
    'ai-ms': { type: 'string', default: '2500' }, // mean Claude latency
    'meta-ms': { type: 'string', default: '300' }, // Graph API latency
    debounce: { type: 'string', default: '2000' },
    timeout: { type: 'string', default: '300' }, // seconds to wait for all replies
    label: { type: 'string', default: '' },
  },
});
const N = Number(a.businesses), C = Number(a.customers), T = Number(a.turns), WINDOW = Number(a.window) * 1000;
const AI_MS = Number(a['ai-ms']), META_MS = Number(a['meta-ms']), DEBOUNCE = Number(a.debounce);
const DB = process.env.LOADTEST_DATABASE_URL, REDIS = process.env.LOADTEST_REDIS_URL;
if (!DB || !REDIS) throw new Error('Set LOADTEST_DATABASE_URL and LOADTEST_REDIS_URL (disposable services: schema is dropped)');

const WEB_PORT = 3999, FAKE_PORT = 4012, SECRET = 'loadtest-meta-secret';
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  NODE_ENV: 'development', LOG_LEVEL: 'warn', PORT: String(WEB_PORT), APP_URL: `http://127.0.0.1:${WEB_PORT}`,
  DATABASE_URL: DB, REDIS_URL: REDIS, ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  META_APP_SECRET: SECRET, IG_APP_SECRET: SECRET, META_GRAPH_BASE: FAKE, IG_GRAPH_BASE: FAKE, IG_API_BASE: FAKE,
  ANTHROPIC_BASE_URL: FAKE, ANTHROPIC_API_KEY: 'load', ANTHROPIC_AUTH_TOKEN: '', AI_DEBOUNCE_MS: String(DEBOUNCE),
  AI_WORKSPACE_RPM: '600', WORKER_CONCURRENCY: a.concurrency!, INBOUND_CONCURRENCY: a.inbound!, DB_POOL_MAX: a.pool!,
};
Object.assign(process.env, env);

const pctl = (xs: number[], p: number) => (xs.length ? [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]! : NaN);
const stats = (xs: number[]) => ({ n: xs.length, p50: pctl(xs, 50), p95: pctl(xs, 95), p99: pctl(xs, 99), max: xs.length ? Math.max(...xs) : NaN });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (mean: number) => Math.round(mean * (0.6 + Math.random() * 0.8));
const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

// ---------- Fake Meta + Claude ----------
const replies = new Map<string, number[]>(); // recipient -> send-API call times
let midSeq = 0;
const postWebhook = (path: string, body: string) =>
  fetch(`http://127.0.0.1:${WEB_PORT}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body });
const igEcho = (igId: string, to: string, mid: string, text: string) =>
  JSON.stringify({ object: 'instagram', entry: [{ id: igId, time: Date.now(), messaging: [{ sender: { id: igId }, recipient: { id: to }, timestamp: Date.now(), message: { mid, text, is_echo: true } }] }] });

const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const path = new URL(req.url!, 'http://x').pathname;
    let body: any = {};
    try { body = JSON.parse(raw); } catch {}
    const json = (data: unknown, ms: number) => setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); }, ms);
    if (path === '/v1/messages') {
      return json({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Salam! Bəli, var, 45 AZN.' }], usage: { input_tokens: 1500, output_tokens: 30, cache_read_input_tokens: 1200, cache_creation_input_tokens: 0 } }, jitter(AI_MS));
    }
    const m = /\/([^/]+)\/messages$/.exec(path);
    if (m && req.method === 'POST') {
      if (body.status === 'read') return json({ success: true }, jitter(META_MS)); // WhatsApp read receipt
      const to = String(body.recipient?.id ?? body.to ?? '');
      replies.set(to, [...(replies.get(to) ?? []), Date.now()]);
      const mid = `mid.${++midSeq}.${randomBytes(4).toString('hex')}`;
      if (body.recipient) {
        // Instagram: echo of our own DM. Sometimes Meta's echo overtakes the send API response (issue #6).
        const early = Math.random() < 0.3;
        const echo = () => postWebhook('/webhooks/instagram', igEcho(m[1]!, to, mid, body.message?.text ?? '')).catch(() => {});
        if (early) void echo();
        else setTimeout(echo, META_MS + Math.random() * 1500);
        return json({ recipient_id: to, message_id: mid }, jitter(META_MS));
      }
      return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.${mid}` }] }, jitter(META_MS));
    }
    return json({}, jitter(META_MS)); // profile lookups etc.
  });
});

// ---------- Setup ----------
// Only modules that exist in every version, so the same script can measure an older checkout (before/after).
const { pool, q } = await import('../src/db.js');
const { encrypt } = await import('../src/crypto.js');
const { Queue } = await import('bullmq');
const { Redis } = await import('ioredis');
const redis = new Redis(REDIS, { maxRetriesPerRequest: null });
const queue = new Queue('messages', { connection: redis });
const inboundQueue = new Queue('inbound', { connection: redis });
const closeQueues = () => Promise.allSettled([queue.close(), inboundQueue.close()]);

await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
for (const f of readdirSync('migrations').filter((x) => x.endsWith('.sql')).sort()) await pool.query(readFileSync(`migrations/${f}`, 'utf8'));
await redis.flushdb();

const token = encrypt('fake-token');
const ws = await q<{ id: string; i: number }>(
  `INSERT INTO workspaces (name, monthly_reply_limit) SELECT 'Biznes ' || i, 1000000 FROM generate_series(1, $1) i RETURNING id, (regexp_replace(name, '\\D', '', 'g'))::int AS i`,
  [N],
);
await q(`INSERT INTO assistants (workspace_id, enabled, business_name, knowledge) SELECT id, true, name, 'Don: 45 AZN. Çanta: 30 AZN. Çatdırılma 3 AZN.' FROM workspaces`);
// Half Instagram, half WhatsApp.
await q(
  `INSERT INTO channels (workspace_id, type, external_id, display_name, access_token_enc, scopes)
   SELECT w.id, CASE WHEN i % 2 = 0 THEN 'instagram' ELSE 'whatsapp' END, 'CH' || i, 'Biznes ' || i, $1,
          '{instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments}'
   FROM (SELECT id, (regexp_replace(name, '\\D', '', 'g'))::int AS i FROM workspaces) w`,
  [token],
);

const procs: ChildProcess[] = [];
const start = (file: string, tag: string) => {
  // LOADTEST_PROFILE=<dir>: V8 CPU profile of each worker process (open in Chrome DevTools).
  const prof = process.env.LOADTEST_PROFILE && tag.startsWith('worker') ? ['--cpu-prof', `--cpu-prof-dir=${process.env.LOADTEST_PROFILE}`] : [];
  const p = spawn(process.execPath, [...prof, '--import', 'tsx', file], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  p.stderr!.on('data', (d) => { const s = String(d); if (!/ExperimentalWarning|DeprecationWarning/.test(s)) errors.push(`[${tag}] ${s.trim().slice(0, 300)}`); });
  procs.push(p);
};
const errors: string[] = [];
await new Promise<void>((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));
start('src/server.ts', 'web');
for (let i = 0; i < Number(a.workers); i++) start('src/worker.ts', `worker${i}`);
for (let i = 0; i < 100; i++) {
  if (await fetch(`http://127.0.0.1:${WEB_PORT}/readyz`).then((r) => r.ok, () => false)) break;
  await sleep(200);
}
await sleep(1500); // workers connect

// ---------- Traffic ----------
const acks: number[] = [], ackErrors: Record<string, number> = {};
const sentAt = new Map<string, number[]>(); // recipient -> webhook accepted times
const igMsg = (igId: string, from: string, mid: string, text: string) =>
  JSON.stringify({ object: 'instagram', entry: [{ id: igId, time: Date.now(), messaging: [{ sender: { id: from }, recipient: { id: igId }, timestamp: Date.now(), message: { mid, text } }] }] });
const waMsg = (pn: string, from: string, mid: string, text: string) =>
  JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { metadata: { phone_number_id: pn }, contacts: [{ wa_id: from, profile: { name: 'Müştəri' } }], messages: [{ from, id: mid, type: 'text', text: { body: text } }] } }] }] });

async function customer(b: { i: number }, c: number) {
  const ig = b.i % 2 === 0;
  const user = `${ig ? 'IGU' : '99450'}${b.i}x${c}`;
  await sleep(Math.random() * WINDOW);
  for (let t = 0; t < T; t++) {
    const mid = `${ig ? 'm' : 'wamid'}.${b.i}.${c}.${t}`;
    const body = ig ? igMsg(`CH${b.i}`, user, mid, `Don neçəyədir? (${t})`) : waMsg(`CH${b.i}`, user, mid, `Çatdırılma var? (${t})`);
    const t0 = Date.now();
    const res = await postWebhook(ig ? '/webhooks/instagram' : '/webhooks/whatsapp', body).catch((e) => ({ status: `ERR ${(e as Error).message}` }) as const);
    acks.push(Date.now() - t0);
    if (res.status !== 200) ackErrors[String(res.status)] = (ackErrors[String(res.status)] ?? 0) + 1;
    sentAt.set(user, [...(sentAt.get(user) ?? []), Date.now()]);
    // Next turn after our reply arrives (a real customer reads it first), or give up after 60 s.
    for (let w = 0; w < 600 && (replies.get(user)?.length ?? 0) <= t; w++) await sleep(100);
    await sleep(500 + Math.random() * 1500);
  }
}

const samples: { t: number; waiting: number; active: number; delayed: number; inbound: number; db: number }[] = [];
const t0 = Date.now();
let running = true;
const sampler = (async () => {
  while (running) {
    const [m, i, conns] = await Promise.all([
      queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized'),
      inboundQueue.getJobCounts('waiting', 'active', 'prioritized'),
      q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`),
    ]);
    samples.push({ t: Date.now() - t0, waiting: (m.waiting ?? 0) + (m.prioritized ?? 0), active: m.active ?? 0, delayed: m.delayed ?? 0, inbound: (i.waiting ?? 0) + (i.active ?? 0) + (i.prioritized ?? 0), db: conns[0]!.n });
    await sleep(1000);
  }
})();

await Promise.race([
  Promise.all(ws.flatMap((b) => Array.from({ length: C }, (_, c) => customer(b, c)))),
  sleep(Number(a.timeout) * 1000),
]);
await sleep(3000); // late echoes
running = false;
await sampler;
const elapsed = (Date.now() - t0) / 1000;

// ---------- Results ----------
const replyLat: number[] = [];
let answered = 0, duplicates = 0;
for (const [user, sends] of sentAt) {
  const got = replies.get(user) ?? [];
  answered += Math.min(got.length, sends.length);
  duplicates += Math.max(0, got.length - sends.length);
  for (const [k, g] of got.slice(0, sends.length).entries()) replyLat.push(g - sends[k]! - DEBOUNCE);
}
const [db] = await q(`SELECT
  (SELECT count(*)::int FROM messages WHERE direction = 'in') AS inbound,
  (SELECT count(*)::int FROM messages WHERE direction = 'out' AND sender = 'ai' AND status = 'sent') AS ai_sent,
  (SELECT count(*)::int FROM messages WHERE direction = 'out' AND sender = 'human') AS taken_for_staff,
  (SELECT count(*)::int FROM messages WHERE direction = 'out' AND status <> 'sent') AS not_sent,
  (SELECT count(*)::int FROM conversations WHERE ai_paused_until > now()) AS wrongly_paused,
  (SELECT count(*)::int FROM conversations WHERE needs_human) AS handed_off`);
const failed = (await queue.getJobCounts('failed')).failed! + (await inboundQueue.getJobCounts('failed')).failed!;
const expected = N * C * T;
const result = {
  label: a.label || `${N} biz × ${C} cust × ${T} turns`,
  config: { businesses: N, customers: N * C, messages: expected, workers: Number(a.workers), concurrency: Number(a.concurrency), inbound: Number(a.inbound), pool: Number(a.pool), aiMs: AI_MS, metaMs: META_MS, debounceMs: DEBOUNCE },
  elapsedS: Math.round(elapsed),
  webhookAckMs: stats(acks),
  webhookErrors: ackErrors,
  replyLatencyMs: stats(replyLat),
  answered: `${answered}/${expected}`,
  duplicates,
  throughputRepliesPerS: Math.round((answered / elapsed) * 10) / 10,
  peak: { aiQueueWaiting: Math.max(0, ...samples.map((s) => s.waiting)), aiActive: Math.max(0, ...samples.map((s) => s.active)), inboundBacklog: Math.max(0, ...samples.map((s) => s.inbound)), dbConnections: Math.max(0, ...samples.map((s) => s.db)) },
  db, failedJobs: failed,
  processErrors: errors.length,
};
console.log(JSON.stringify(result, null, 2));
if (errors.length) console.error(errors.slice(0, 10).join('\n'));

for (const p of procs) p.kill('SIGTERM');
await sleep(1000);
fake.close();
await closeQueues();
redis.disconnect();
await pool.end();
process.exit(0);
