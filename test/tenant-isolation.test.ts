// Multi-tenant isolation crawler (security audit 2026-10). Tenant A (owner, most privileged) hits EVERY route with tenant B's ids.
// Pass criteria: no response contains B's marker, and a fingerprint of all of B's rows is unchanged.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAutomation, fake, igMessage, loginAs, resetDb, seedWorkspace, startFake, stopFake } from './helpers.js';

const MARK = 'BSECRET';
const ROUTES = `get /;get /admin;get /admin/w/:id;get /app;get /app/2fa;get /app/analytics;get /app/analytics/export.csv;get /app/assistant;get /app/audit;get /app/automations;get /app/automations/:id;get /app/automations/:id/media;get /app/automations/new;get /app/channels;get /app/contacts;get /app/contacts/:id;get /app/contacts/export.csv;get /app/inbox;get /app/inbox/:id;get /app/inbox/:id/part/:part;get /app/inbox/part/list;get /app/integrations;get /app/knowledge;get /app/knowledge/:id;get /app/media/:id/:i;get /app/saved-replies;get /app/settings;get /app/settings/export;get /app/team;get /app/test;get /data-deletion/status;post /admin/customers;post /admin/w/:id/delete;post /admin/w/:id/extend;post /admin/w/:id/link;post /admin/w/:id/plan;post /admin/w/:id/update;post /app/assistant/learn;post /app/automations/:id;post /app/automations/:id/delete;post /app/automations/:id/duplicate;post /app/automations/:id/status;post /app/automations/:id/test;post /app/channels/:id/disconnect;post /app/contacts/:id/fields;post /app/contacts/:id/flags;post /app/contacts/:id/merge;post /app/contacts/:id/tags;post /app/inbox/:id/ai;post /app/inbox/:id/assign;post /app/inbox/:id/delete;post /app/inbox/:id/note;post /app/inbox/:id/reply;post /app/inbox/:id/status;post /app/integrations/:id/delete;post /app/integrations/:id/rotate;post /app/integrations/:id/test;post /app/integrations/:id/toggle;post /app/knowledge/:id;post /app/knowledge/:id/delete;post /app/knowledge/:id/toggle;post /app/saved-replies/:id/delete;post /app/team/:id/link;post /app/team/:id/remove;post /app/team/:id/role`
  .split(';').map((r) => r.split(' ') as ['get' | 'post', string]);

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_REDIS_URL;

describe.skipIf(!enabled)('multi-tenant isolation (every route)', () => {
  let db: typeof import('../src/db.js');
  let app: import('fastify').FastifyInstance;
  let A: Awaited<ReturnType<typeof seedWorkspace>>;
  let B: Awaited<ReturnType<typeof seedWorkspace>>;
  const bIds: Record<string, string> = {};

  /** md5 over every row that belongs to B (all tables with workspace_id, plus B's users). */
  async function fingerprintB() {
    const tables = await db.q(`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'workspace_id' ORDER BY 1`);
    const out: Record<string, string> = {};
    for (const { table_name: t } of tables) {
      if (t === 'audit_log') continue; // A's own actions may audit with A's id only; checked separately
      out[t] = (await db.one(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x WHERE workspace_id = $1`, [B.workspaceId])).h;
    }
    for (const t of ['contact_tags', 'automation_versions', 'knowledge_history', 'conversation_notes']) {
      out[t] = (await db.one(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`)).h;
    }
    out.users = (await db.one(`SELECT md5(string_agg(u::text, '|' ORDER BY u.id)) AS h FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.workspace_id = $1`, [B.workspaceId])).h;
    return out;
  }

  beforeAll(async () => {
    await startFake();
    db = await import('../src/db.js');
    await resetDb();
    A = await seedWorkspace('ta', 'IGTA');
    B = await seedWorkspace('tb', 'IGTB');
    const pipeline = await import('../src/pipeline.js');
    const { parseInstagramWebhook } = await import('../src/channels/instagram.js');
    for (const ev of parseInstagramWebhook(igMessage('IGTB', 'UB', 'mid.b1', `${MARK} message body`))) await pipeline.ingest(ev);
    const m = await db.one(`SELECT m.id, m.conversation_id, c.contact_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.external_id = 'mid.b1'`);
    await db.q(`UPDATE contacts SET display_name = $2, fields = '{"secret":"${MARK}"}' WHERE id = $1`, [m.contact_id, `${MARK} contact`]);
    await db.q(`UPDATE messages SET media = '[{"type":"image","id":"wamedia1"}]' WHERE id = $1`, [m.id]);
    const tag = await db.one(`INSERT INTO tags (workspace_id, name) VALUES ($1, $2) RETURNING id`, [B.workspaceId, `${MARK}tag`]);
    await db.q(`INSERT INTO contact_tags VALUES ($1, $2)`, [m.contact_id, tag.id]);
    const note = await db.one(`INSERT INTO conversation_notes (workspace_id, conversation_id, user_id, body) VALUES ($1, $2, $3, $4) RETURNING id`, [B.workspaceId, m.conversation_id, B.userId, `${MARK} note`]);
    const sr = await db.one(`INSERT INTO saved_replies (workspace_id, title, body) VALUES ($1, $2, $3) RETURNING id`, [B.workspaceId, `${MARK} sr`, `${MARK} saved`]);
    const auto = await createAutomation(B.workspaceId, 'dm_keyword', { match: { mode: 'any', keywords: ['x'] }, steps: [{ type: 'message', text: `${MARK} flow` }] }, 'active', `${MARK} automation`);
    const kb = await db.one(`INSERT INTO knowledge_items (workspace_id, kind, title, body) VALUES ($1, 'price', $2, $3) RETURNING id`, [B.workspaceId, `${MARK} kb`, `${MARK} price 99 AZN`]);
    const { encrypt } = await import('../src/crypto.js');
    const wh = await db.one(`INSERT INTO webhooks (workspace_id, name, url, secret_enc, events) VALUES ($1, $2, 'https://b.example.com/h', $3, '{message.received}') RETURNING id`, [B.workspaceId, `${MARK} hook`, encrypt('whsec_b')]);
    const { hash } = await import('@node-rs/argon2');
    const agent = await db.one(`INSERT INTO users (email, password_hash, email_verified_at) VALUES ('agent-b@tb.az', $1, now()) RETURNING id`, [await hash('x-very-long-password')]);
    await db.q(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'agent')`, [B.workspaceId, agent.id]);
    await db.q(`INSERT INTO links (code, workspace_id, automation_id, url) VALUES ('bcode1', $1, $2, 'https://b.example.com/landing')`, [B.workspaceId, auto]);
    Object.assign(bIds, { conv: m.conversation_id, msg: m.id, contact: m.contact_id, note: note.id, sr: sr.id, auto, kb: kb.id, wh: wh.id, user: agent.id, owner: B.userId, ws: B.workspaceId, channel: B.channelId });
    app = await (await import('../src/server.js')).buildServer();
  });
  afterAll(async () => {
    await app.close();
    await stopFake();
    const { queue, redis } = await import('../src/queue.js');
    (await import('../src/realtime.js')).closeRealtime();
    await queue.close();
    redis.disconnect();
    await db.pool.end();
  });

  it('unauthenticated requests never reach data (every /app and /admin route)', async () => {
    const leaks: string[] = [];
    for (const [method, route] of ROUTES.filter(([, r]) => r.startsWith('/app') || r.startsWith('/admin'))) {
      const url = route.replace(':id', bIds.conv!).replace(':part', 'thread').replace(':i', '0').replace(':code', 'bcode1');
      const res = await app.inject({ method: method.toUpperCase() as 'GET', url, headers: { origin: 'http://localhost:3000' }, payload: method === 'post' ? {} : undefined });
      if (res.body.includes(MARK) || (res.statusCode >= 200 && res.statusCode < 300)) leaks.push(`${method} ${url} -> ${res.statusCode}`);
    }
    expect(leaks).toEqual([]);
  });

  it('tenant A owner, with B ids on every route: no B data returned, no B data changed', async () => {
    const s = await loginAs(app, A.email);
    const before = await fingerprintB();
    const leaks: string[] = [];
    let requests = 0;
    const idKinds = ['conv', 'msg', 'contact', 'note', 'sr', 'auto', 'kb', 'wh', 'user', 'owner', 'ws', 'channel'];
    for (const [method, route] of ROUTES) {
      const variants = route.includes(':id') ? idKinds.map((k) => route.replace(':id', bIds[k]!)) : [route];
      for (const v of variants) {
        for (const part of route.includes(':part') ? ['thread', 'pane', 'profile'] : ['']) {
          const url = v.replace(':part', part).replace(':i', '0').replace(':code', 'bcode1') + (route.endsWith('/list') || route === '/app/inbox' ? '?f=all&q=message%20body' : '');
          const payload = method === 'post' ? {
            _csrf: s.csrf, add: 'pwn', remove: `${MARK}tag`, key: 'secret', value: 'pwn', delete: '1', opted_out: '1', blocked: '1', body: 'pwn', text: 'pwn', status: 'closed',
            user_id: 'me', role: 'analyst', source: bIds.contact, action: 'pause', name: 'pwn', kind: 'faq', title: 'pwn', keywords: '', nonce: 'n1',
            config: '{}', priority: '0', channel_id: bIds.channel, url: 'https://x.example.com', events: 'message.received', plan_id: bIds.ws,
          } : undefined;
          const res = await app.inject({ method: method.toUpperCase() as 'GET', url, headers: { ...s.headers, accept: 'text/html' }, payload });
          requests++;
          if (res.body.includes(MARK)) leaks.push(`${method} ${url} -> ${res.statusCode} contains marker`);
          if (res.statusCode === 403 && /CSRF/.test(res.body)) leaks.push(`${method} ${url}: CSRF rejected (test setup)`);
        }
      }
    }
    // Filters that take B's ids must not reveal B's data either.
    for (const url of [`/app/inbox?f=all&tag=${bIds.contact}`, `/app/analytics?automation=${bIds.auto}`, `/app/analytics/export.csv?type=conversations&automation=${bIds.auto}`, `/app/contacts?q=contact`, `/app/contacts/export.csv?q=contact`]) {
      const res = await app.inject({ url, headers: s.headers });
      requests++;
      if (res.body.includes(MARK)) leaks.push(`GET ${url} contains marker`);
    }
    const after = await fingerprintB();
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    console.log(`AUDIT tenant crawler: ${requests} requests as tenant A; changed B tables: ${JSON.stringify(changed)}`);
    expect(leaks).toEqual([]);
    expect(changed).toEqual([]);
  });

  it('B link redirect /r/:code is public by design (only resolves the stored URL)', async () => {
    const res = await app.inject({ url: '/r/bcode1' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://b.example.com/landing');
  });
});
