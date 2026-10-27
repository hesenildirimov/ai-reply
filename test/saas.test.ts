import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fake, igMessage, loginAs, resetDb, seedWorkspace, startFake, stopFake } from './helpers.js';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_REDIS_URL;

describe('P4 units', () => {
  it('blocks private, loopback, link-local and metadata addresses', async () => {
    const { isPrivateAddress, validateWebhookUrl } = await import('../src/webhooks.js');
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2a00:1450::1']) expect(isPrivateAddress(ip)).toBe(false);
    expect(validateWebhookUrl('http://example.com/x')).toBeNull(); // https only
    expect(validateWebhookUrl('https://169.254.169.254/latest')).toBeNull();
    expect(validateWebhookUrl('https://localhost/x')).toBeNull();
    expect(validateWebhookUrl('https://user:pw@example.com/')).toBeNull();
    expect(validateWebhookUrl('https://hooks.example.com/in')).toBe('https://hooks.example.com/in');
  });
  it('parses CSV with quotes and undoes the export injection guard', async () => {
    const { parseCsv, csvLine } = await import('../src/csv.js');
    expect(parseCsv('a,b\n"x, ""y""",\'=1+1\r\n\n')).toEqual([['a', 'b'], ['x, "y"', '=1+1']]);
    expect(csvLine(['=HYPERLINK("x")', 'ok'])).toBe('"\'=HYPERLINK(""x"")",ok\n');
    expect(() => parseCsv('a\n1\n2\n3', 2)).toThrow(/too many rows/);
  });
});

describe.skipIf(!enabled)('P4 SaaS features (integration)', () => {
  let db: typeof import('../src/db.js');
  let pipeline: typeof import('../src/pipeline.js');
  let app: import('fastify').FastifyInstance;
  let A: Awaited<ReturnType<typeof seedWorkspace>>;
  let B: Awaited<ReturnType<typeof seedWorkspace>>;
  let owner: Awaited<ReturnType<typeof loginAs>>;
  let n = 0;
  async function inbound(ig: string, from: string, text: string) {
    const { parseInstagramWebhook } = await import('../src/channels/instagram.js');
    const mid = `p4.${++n}`;
    for (const ev of parseInstagramWebhook(igMessage(ig, from, mid, text))) await pipeline.ingest(ev);
    return db.one(`SELECT m.id, m.conversation_id, c.contact_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.external_id = $1`, [mid]);
  }
  /** Adds a member with a known password and returns a logged-in session for them. */
  async function memberSession(email: string, role: string, workspaceId = A.workspaceId) {
    const { hash } = await import('@node-rs/argon2');
    const u = await db.one(`INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, $2, now()) RETURNING id`, [email, await hash('correct-horse-battery')]);
    await db.q(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)`, [workspaceId, u.id, role]);
    return { id: u.id as string, ...(await loginAs(app, email)) };
  }
  const post = (s: { headers: Record<string, string>; csrf: string }, url: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url, headers: s.headers, payload: { _csrf: s.csrf, ...payload } });

  beforeAll(async () => {
    await startFake();
    db = await import('../src/db.js');
    pipeline = await import('../src/pipeline.js');
    await resetDb();
    A = await seedWorkspace('pa', 'IGPA');
    B = await seedWorkspace('pb', 'IGPB');
    app = await (await import('../src/server.js')).buildServer();
    owner = await loginAs(app, A.email);
  });
  beforeEach(() => fake.reset());
  afterAll(async () => {
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
    await app.close();
    await stopFake();
    const { closeQueues, redis } = await import('../src/queue.js');
    const { closeRealtime } = await import('../src/realtime.js');
    closeRealtime();
    await closeQueues();
    redis.disconnect();
    await db.pool.end();
  });

  it('roles are enforced in the backend, not just hidden in the UI', async () => {
    const agent = await memberSession('agent@pa.az', 'agent');
    const analyst = await memberSession('analyst@pa.az', 'analyst');
    expect((await post(agent, '/app/team/invite', { email: 'x@pa.az', role: 'agent' })).statusCode).toBe(403);
    expect((await app.inject({ url: '/app/integrations', headers: agent.headers })).statusCode).toBe(403);
    expect((await app.inject({ url: '/app/contacts/export.csv', headers: agent.headers })).statusCode).toBe(403);
    expect((await app.inject({ url: '/app/contacts', headers: analyst.headers })).statusCode).toBe(403);
    expect((await app.inject({ url: '/app/audit', headers: analyst.headers })).statusCode).toBe(403);
    expect((await app.inject({ url: '/app/analytics', headers: analyst.headers })).statusCode).toBe(200);
    // Nav hides what the role can't use.
    const nav = (await app.inject({ url: '/app', headers: analyst.headers })).body;
    expect(nav).not.toContain('href="/app/team"');
    expect(nav).toContain('href="/app/analytics"');
  });

  it('owner invites; admins cannot create or demote admins; member limit is enforced; removal signs out', async () => {
    const res = await post(owner, '/app/team/invite', { email: 'new.admin@pa.az', role: 'admin' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('/set-password?token=');
    const admin = await db.one(`SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.email = 'new.admin@pa.az' AND m.role = 'admin'`);
    expect(admin).toBeTruthy();
    const adm = await memberSession('admin2@pa.az', 'admin');
    expect((await post(adm, '/app/team/invite', { email: 'third@pa.az', role: 'admin' })).headers.location).toContain('member_forbidden');
    expect((await post(adm, `/app/team/${admin.id}/role`, { role: 'agent' })).headers.location).toContain('member_forbidden');
    expect((await post(adm, `/app/team/${A.userId}/remove`)).headers.location).toContain('member_forbidden'); // the owner
    // Plan limit (override) checked server-side.
    const count = (await db.one(`SELECT count(*)::int AS n FROM memberships WHERE workspace_id = $1`, [A.workspaceId])).n;
    await db.q(`UPDATE workspaces SET limit_overrides = $2 WHERE id = $1`, [A.workspaceId, JSON.stringify({ members: count })]);
    expect((await post(owner, '/app/team/invite', { email: 'over@pa.az', role: 'agent' })).headers.location).toContain('member_limit');
    await db.q(`UPDATE workspaces SET limit_overrides = '{}' WHERE id = $1`, [A.workspaceId]);
    // Removing a member kills their sessions and unassigns their conversations.
    const ag = await memberSession('leaver@pa.az', 'agent');
    const conv = await inbound('IGPA', 'U-leave', 'Salam');
    await db.q(`UPDATE conversations SET assignee_user_id = $2 WHERE id = $1`, [conv.conversation_id, ag.id]);
    expect((await post(owner, `/app/team/${ag.id}/remove`)).headers.location).toContain('member_removed');
    expect((await app.inject({ url: '/app', headers: ag.headers })).headers.location).toBe('/login');
    expect((await db.one(`SELECT assignee_user_id FROM conversations WHERE id = $1`, [conv.conversation_id])).assignee_user_id).toBeNull();
    const actions = (await db.q(`SELECT action FROM audit_log WHERE workspace_id = $1 AND action LIKE 'member.%'`, [A.workspaceId])).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['member.invite', 'member.remove']));
    expect((await app.inject({ url: '/app/audit?g=member.', headers: owner.headers })).body).toContain('member.invite');
  });

  it('team pages cannot touch another workspace', async () => {
    expect((await post(owner, `/app/team/${B.userId}/remove`)).headers.location).toContain('member_forbidden');
    expect((await post(owner, `/app/team/${B.userId}/role`, { role: 'agent' })).headers.location).toContain('invalid');
    expect(await db.one(`SELECT 1 FROM memberships WHERE user_id = $1 AND role = 'owner'`, [B.userId])).toBeTruthy();
  });

  it('merges duplicate contacts; later messages from the merged identity land on the survivor', async () => {
    const c1 = await inbound('IGPA', 'U-m1', 'Salam');
    const c2 = await inbound('IGPA', 'U-m2', 'Salam yenə');
    const { addTags } = await import('../src/contacts.js');
    await addTags({ id: c2.contact_id, workspace_id: A.workspaceId }, ['vip']);
    await db.q(`UPDATE contacts SET fields = '{"olcu":"M","city":"Gəncə"}' WHERE id = $1`, [c2.contact_id]);
    await db.q(`UPDATE contacts SET fields = '{"city":"Bakı"}' WHERE id = $1`, [c1.contact_id]);
    // Cross-tenant merge refused.
    const b = await inbound('IGPB', 'U-bx', 'Salam');
    expect((await post(owner, `/app/contacts/${c1.contact_id}/merge`, { source: b.contact_id })).headers.location).toContain('merge_failed');
    expect((await post(owner, `/app/contacts/${c1.contact_id}/merge`, { source: c2.contact_id })).headers.location).toContain('m=merged');
    const t = await db.one(`SELECT fields FROM contacts WHERE id = $1`, [c1.contact_id]);
    expect(t.fields).toEqual({ olcu: 'M', city: 'Bakı' }); // survivor wins conflicts
    expect((await db.one(`SELECT contact_id FROM conversations WHERE id = $1`, [c2.conversation_id])).contact_id).toBe(c1.contact_id);
    expect((await db.one(`SELECT count(*)::int AS n FROM contact_tags WHERE contact_id = $1`, [c1.contact_id])).n).toBe(1);
    const again = await inbound('IGPA', 'U-m2', 'Bir sual də');
    expect(again.contact_id).toBe(c1.contact_id);
    expect((await app.inject({ url: `/app/contacts/${c2.contact_id}`, headers: owner.headers })).headers.location).toBe(`/app/contacts/${c1.contact_id}`);
    expect((await post(owner, `/app/contacts/${c1.contact_id}/merge`, { source: c2.contact_id })).headers.location).toContain('merge_failed'); // already merged
  });

  it('exports contacts as safe CSV and imports tags/fields only into own existing contacts', async () => {
    const c = await inbound('IGPA', 'U-csv', 'Salam');
    await db.q(`UPDATE contacts SET username = 'csv_user', display_name = '=cmd|calc' WHERE id = $1`, [c.contact_id]);
    const csv = await app.inject({ url: '/app/contacts/export.csv', headers: owner.headers });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain("'=cmd|calc");
    expect(csv.body).not.toContain('IGPB');
    const b = await inbound('IGPB', 'U-bcsv', 'Salam');
    const body = `id,username,tags,olcu,opted_out\n${c.contact_id},,yeni;sorğu,L,1\n${b.contact_id},,hack,,\n,nobody,x,,\n`;
    const res = await app.inject({ method: 'POST', url: '/app/contacts/import', headers: { ...owner.headers, 'content-type': 'text/csv', 'x-csrf-token': owner.csrf }, payload: body });
    expect(res.json()).toMatchObject({ ok: true, rows: 3, updated: 1, not_found: 2 });
    const row = await db.one(`SELECT fields, opted_out FROM contacts WHERE id = $1`, [c.contact_id]);
    expect(row).toMatchObject({ fields: { olcu: 'L' }, opted_out: true });
    expect((await db.one(`SELECT count(*)::int AS n FROM contact_tags WHERE contact_id = $1`, [b.contact_id])).n).toBe(0);
    // CSRF header required.
    const noCsrf = await app.inject({ method: 'POST', url: '/app/contacts/import', headers: { ...owner.headers, 'content-type': 'text/csv' }, payload: body });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('monthly automated-message limit stops the bot (no AI call) and is audited', async () => {
    await db.q(`UPDATE workspaces SET limit_overrides = '{"bot_messages_month": 0}' WHERE id = $1`, [A.workspaceId]);
    const m = await inbound('IGPA', 'U-lim', 'Qiymət neçədir?');
    await pipeline.processReply(m.conversation_id, m.id);
    expect(fake.aiCalls()).toHaveLength(0);
    expect(fake.sends()).toHaveLength(0);
    expect(await db.one(`SELECT 1 FROM audit_log WHERE workspace_id = $1 AND action = 'plan.limit_reached' AND meta->>'limit' = 'bot_messages_month'`, [A.workspaceId])).toBeTruthy();
    await db.q(`UPDATE workspaces SET limit_overrides = '{"contacts": 1}' WHERE id = $1`, [A.workspaceId]);
    const m2 = await inbound('IGPA', 'U-lim2', 'Salam');
    await pipeline.processReply(m2.conversation_id, m2.id);
    expect(fake.aiCalls()).toHaveLength(0);
    await db.q(`UPDATE workspaces SET limit_overrides = '{}' WHERE id = $1`, [A.workspaceId]);
  });

  it('webhooks: private URLs refused; deliveries are signed, retried on 5xx and not on 4xx', async () => {
    const refused = await post(owner, '/app/integrations', { name: 'x', url: 'http://127.0.0.1:4011/hook', events: 'message.received' });
    expect(refused.headers.location).toContain('webhook_url');
    process.env.WEBHOOK_ALLOW_PRIVATE = '1'; // local fake server only (ignored in production)
    const created = await post(owner, '/app/integrations', { name: 'CRM', url: 'http://127.0.0.1:4011/hook', events: ['message.received', 'contact.tag_added'] });
    const secret = /value="(whsec_[^"]+)"/.exec(created.body)![1]!;
    const hook = await db.one(`SELECT id, secret_enc FROM webhooks WHERE workspace_id = $1`, [A.workspaceId]);
    expect(hook.secret_enc).not.toContain(secret); // stored encrypted
    const m = await inbound('IGPA', 'U-wh', 'Webhook test');
    const d = await db.one(`SELECT id FROM webhook_deliveries WHERE webhook_id = $1 AND event = 'message.received' ORDER BY created_at DESC LIMIT 1`, [hook.id]);
    const { deliverWebhook } = await import('../src/webhooks.js');
    await deliverWebhook(d.id, 1, false);
    const call = fake.calls.find((c) => c.path === '/hook')!;
    expect(call.body).toMatchObject({ event: 'message.received', data: { conversation_id: m.conversation_id, text: 'Webhook test' } });
    const ts = String(call.headers!['x-aireply-timestamp']);
    expect(call.headers!['x-aireply-signature']).toBe(`sha256=${createHmac('sha256', secret).update(`${ts}.${call.raw}`).digest('hex')}`);
    expect((await db.one(`SELECT status FROM webhook_deliveries WHERE id = $1`, [d.id])).status).toBe('sent');
    // B's events never reach A's webhook.
    await inbound('IGPB', 'U-whb', 'B mesajı');
    expect((await db.one(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE workspace_id = $1`, [B.workspaceId])).n).toBe(0);
    // 503 → pending + throw (BullMQ retries); 400 → failed, no retry.
    const { emit } = await import('../src/webhooks.js');
    await emit(A.workspaceId, 'contact.tag_added', { contact_id: m.contact_id, tag: 'x' });
    const d2 = await db.one(`SELECT id FROM webhook_deliveries WHERE event = 'contact.tag_added' ORDER BY created_at DESC LIMIT 1`);
    fake.handler = (_b, p) => (p === '/hook' ? { status: 503 } : undefined);
    await expect(deliverWebhook(d2.id, 1, false)).rejects.toThrow('HTTP 503');
    expect((await db.one(`SELECT status, attempts FROM webhook_deliveries WHERE id = $1`, [d2.id]))).toMatchObject({ status: 'pending', attempts: 1 });
    fake.handler = (_b, p) => (p === '/hook' ? { status: 400 } : undefined);
    await deliverWebhook(d2.id, 2, false);
    expect((await db.one(`SELECT status, response_code FROM webhook_deliveries WHERE id = $1`, [d2.id]))).toMatchObject({ status: 'failed', response_code: 400 });
    expect((await db.one(`SELECT consecutive_failures FROM webhooks WHERE id = $1`, [hook.id])).consecutive_failures).toBe(1);
    // Another workspace can't manage this webhook.
    const bOwner = await loginAs(app, B.email);
    expect((await post(bOwner, `/app/integrations/${hook.id}/delete`)).statusCode).toBe(302);
    expect(await db.one(`SELECT 1 FROM webhooks WHERE id = $1`, [hook.id])).toBeTruthy();
  });

  it('settings show plan usage; onboarding can be dismissed', async () => {
    expect((await app.inject({ url: '/app/settings', headers: owner.headers })).body).toContain('Tarif və limitlər');
    expect((await app.inject({ url: '/app', headers: owner.headers })).body).toContain('Başlanğıc');
    await post(owner, '/app/onboarding/dismiss');
    expect((await app.inject({ url: '/app', headers: owner.headers })).body).not.toContain('Başlanğıc ·');
  });
});
