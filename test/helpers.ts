import { createServer, type Server } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';

/** Programmable stand-in for Meta Graph + Anthropic APIs (both point at FAKE_PORT in vitest.config.ts). */
type Reply = { status?: number; json?: unknown; hang?: boolean };
type Handler = (body: any, path: string) => Reply | undefined;

export const fake = {
  calls: [] as { path: string; body: any }[],
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
  json: { id: 'msg_t', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } },
});

const defaults = (path: string, body: any): Reply => {
  if (path === '/v1/messages') return aiText('Salam! Bəli, var.');
  if (/\/messages$/.test(path)) return { json: { recipient_id: body?.recipient?.id, message_id: `mid.${fake.calls.length}`, messages: [{ id: `wamid.${fake.calls.length}` }] } };
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
      fake.calls.push({ path, body });
      const r = fake.handler(body, path) ?? defaults(path, body);
      if (r.hang) return; // simulate a timeout / dropped connection
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json ?? {}));
    });
  });
  await new Promise<void>((ok) => server!.listen(port, '127.0.0.1', ok));
}
export const stopFake = () => new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()));

/** Fresh schema from all migrations (also proves migrations run on an empty database). */
export async function resetDb() {
  const { pool } = await import('../src/db.js');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of readdirSync('migrations').filter((x) => x.endsWith('.sql')).sort()) await pool.query(readFileSync(`migrations/${f}`, 'utf8'));
  const { redis } = await import('../src/queue.js');
  await redis.flushdb();
}

/** Workspace + owner + active Instagram channel + enabled assistant. */
export async function seedWorkspace(name: string, igId: string) {
  const { one, q } = await import('../src/db.js');
  const { encrypt } = await import('../src/crypto.js');
  const { hash } = await import('@node-rs/argon2');
  const u = await one(`INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, $2, now()) RETURNING id`, [`${name}@test.az`, await hash('correct-horse-battery')]);
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
export const migrationFiles = () => readdirSync('migrations').filter((x) => x.endsWith('.sql')).sort();
