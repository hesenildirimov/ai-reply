import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';

/** Programmable stand-in for Meta Graph + Anthropic APIs (both point at FAKE_PORT in vitest.config.ts). */
type Reply = { status?: number; json?: unknown; hang?: boolean; delayMs?: number; drop?: boolean; file?: { body: Buffer; type: string } };
type Handler = (body: any, path: string) => Reply | undefined;

export const fake = {
  calls: [] as { path: string; body: any; raw?: string; headers?: Record<string, unknown> }[],
  handler: (() => undefined) as Handler,
  reset() {
    this.calls = [];
    this.handler = () => undefined;
  },
  sends() {
    return this.calls.filter((c) => /\/messages$/.test(c.path) && !c.path.startsWith('/v1/'));
  },
  aiCalls() {
    return this.calls.filter((c) => c.path === '/v1/messages');
  },
};

export const aiText = (text: string) => ({
  json: {
    id: 'msg_t',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
  },
});

const defaults = (path: string, body: any): Reply => {
  if (path === '/v1/messages') return aiText('Salam! Bəli, var.');
  if (/\/messages$/.test(path))
    return { json: { recipient_id: body?.recipient?.id, message_id: `mid.${fake.calls.length}`, messages: [{ id: `wamid.${fake.calls.length}` }] } };
  return { json: { success: true } };
};

let server: Server | undefined;
export async function startFake(port = Number(process.env.FAKE_PORT ?? 4011)) {
  if (server) return;
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = new URL(req.url!, 'http://x').pathname;
      let body: any = raw;
      try {
        body = JSON.parse(raw);
      } catch {}
      fake.calls.push({ path, body, raw, headers: req.headers });
      const r = fake.handler(body, path) ?? defaults(path, body);
      if (r.hang) return; // simulate a timeout
      if (r.drop) return void req.socket.destroy(); // connection lost after the request left: outcome unknown
      const send = () => {
        if (r.file) {
          res.writeHead(r.status ?? 200, { 'content-type': r.file.type, 'content-length': r.file.body.length });
          return void res.end(r.file.body);
        }
        res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.json ?? {}));
      };
      if (r.delayMs)
        setTimeout(send, r.delayMs); // slow Meta / Claude
      else send();
    });
  });
  await new Promise<void>((ok) => server!.listen(port, '127.0.0.1', ok));
}
export const stopFake = () => new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()));

/** Fresh schema from all migrations (also proves migrations run on an empty database). */
export async function resetDb() {
  const { pool } = await import('../src/db.js');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of readdirSync('migrations')
    .filter((x) => x.endsWith('.sql'))
    .sort())
    await pool.query(readFileSync(`migrations/${f}`, 'utf8'));
  const { redis } = await import('../src/queue.js');
  await redis.flushdb();
}

/** Workspace + owner + active Instagram channel + enabled assistant. */
export async function seedWorkspace(name: string, igId: string) {
  const { one, q } = await import('../src/db.js');
  const { encrypt } = await import('../src/crypto.js');
  const { hash } = await import('@node-rs/argon2');
  const u = await one(`INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, $2, now()) RETURNING id`, [
    `${name}@test.az`,
    await hash('correct-horse-battery'),
  ]);
  const w = await one(`INSERT INTO workspaces (name, monthly_reply_limit) VALUES ($1, 100) RETURNING id`, [name]);
  await q(`INSERT INTO memberships VALUES ($1, $2, 'owner')`, [w.id, u.id]);
  await q(`INSERT INTO assistants (workspace_id, enabled, business_name, knowledge) VALUES ($1, true, $2, 'Don: 45 AZN')`, [w.id, name]);
  const ch = await one(
    `INSERT INTO channels (workspace_id, type, external_id, display_name, access_token_enc, scopes) VALUES ($1, 'instagram', $2, '@biz', $3, '{instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments}') RETURNING id`,
    [w.id, igId, encrypt('ig-token-SECRET')],
  );
  return { workspaceId: w.id as string, userId: u.id as string, channelId: ch.id as string, email: `${name}@test.az` };
}

export const igMessage = (igId: string, from: string, mid: string, text: string) => ({
  object: 'instagram',
  entry: [{ id: igId, messaging: [{ sender: { id: from }, recipient: { id: igId }, message: { mid, text } }] }],
});

/** Runs migrations dir listing for the test that checks it. */
export const migrationFiles = () =>
  readdirSync('migrations')
    .filter((x) => x.endsWith('.sql'))
    .sort();

/** Inserts an automation (+ version row) directly. */
export async function createAutomation(workspaceId: string, trigger: string, config: unknown, status = 'active', name = trigger) {
  const { one, q } = await import('../src/db.js');
  const { configSchema } = await import('../src/automations/schema.js');
  const cfg = configSchema.parse(config);
  const a = await one(`INSERT INTO automations (workspace_id, name, trigger, status, config) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
    workspaceId,
    name,
    trigger,
    status,
    cfg,
  ]);
  await q(`INSERT INTO automation_versions (automation_id, version, config) VALUES ($1, 1, $2)`, [a.id, cfg]);
  return a.id as string;
}

/** Logs in through the real form (CSRF cookie + token); returns session cookie + CSRF token. */
export async function loginAs(app: import('fastify').FastifyInstance, email: string) {
  const page = await app.inject({ url: '/login' });
  const pre = page.cookies.find((c) => c.name === 'pcsrf')!;
  const token = /name="_csrf" value="([^"]+)"/.exec(page.body)![1]!;
  const res = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { origin: 'http://localhost:3000', cookie: `pcsrf=${pre.value}` },
    payload: { _csrf: token, email, password: 'correct-horse-battery' },
  });
  const cookie = `sid=${res.cookies.find((c) => c.name === 'sid')!.value}`;
  const csrf = /name="_csrf" value="([^"]+)"/.exec((await app.inject({ url: '/app/settings', headers: { cookie } })).body)![1]!;
  return { cookie, csrf, headers: { cookie, origin: 'http://localhost:3000' } };
}

/** Runs the webhook-intake jobs now (the worker does this in production): webhooks only enqueue. */
export async function drainInbound() {
  const { inboundQueue } = await import('../src/queue.js');
  const { runJob } = await import('../src/jobs.js');
  for (;;) {
    const jobs = (await inboundQueue.getJobs(['waiting', 'prioritized'])).filter((j) => j.data.kind === 'inbound');
    if (!jobs.length) return;
    for (const j of jobs.reverse()) {
      await runJob(j as never);
      await j.remove();
    }
  }
}

/** Minimal SMTP server that records mails (to, raw data with soft line breaks joined). Set SMTP_URL before importing src. */
export const mails: { to: string[]; data: string }[] = [];
let smtp: TcpServer | undefined;
export function startFakeSmtp(port: number) {
  smtp = createTcpServer((s) => {
    let buf = '';
    let inData = false;
    let to: string[] = [];
    s.write('220 fake\r\n');
    s.on('data', (d) => {
      buf += d.toString();
      for (;;) {
        const end = inData ? buf.indexOf('\r\n.\r\n') : buf.indexOf('\r\n');
        if (end < 0) return;
        if (inData) {
          mails.push({ to, data: buf.slice(0, end).replace(/=\r\n/g, '') });
          buf = buf.slice(end + 5);
          inData = false;
          to = [];
          s.write('250 ok\r\n');
          continue;
        }
        const line = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'RCPT') to.push(/<([^>]+)>/.exec(line)?.[1] ?? '');
        if (cmd === 'DATA') {
          inData = true;
          s.write('354 go\r\n');
        } else if (cmd === 'QUIT') s.end('221 bye\r\n');
        else s.write('250 ok\r\n');
      }
    });
  });
  return new Promise<void>((ok) => smtp!.listen(port, '127.0.0.1', ok));
}
export const stopFakeSmtp = () => new Promise<void>((ok) => (smtp ? smtp.close(() => ok()) : ok()));

/** Polls until cond() is true (async work such as background mails), or fails after ms. */
export async function until(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const t = Date.now();
  while (!(await cond())) {
    if (Date.now() - t > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
