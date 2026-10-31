// Knowledge sources: files (PDF, Word, TXT, CSV, Excel), pages and sites, Q&A, plan limits, retrieval.
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiText, fake, igMessage, loginAs, resetDb, seedWorkspace, startFake, stopFake } from './helpers.js';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_REDIS_URL;
process.env.WEBHOOK_ALLOW_PRIVATE = '1'; // the fake "website" runs on 127.0.0.1

// ---------- test files ----------
const docx = (paragraphs: string[]) =>
  Buffer.from(
    zipSync({
      'word/document.xml': strToU8(
        `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`,
      ),
    }),
  );
const xlsx = (rows: string[][]) => {
  const shared: string[] = [];
  const idx = (s: string) => (shared.includes(s) ? shared.indexOf(s) : shared.push(s) - 1);
  const sheet = rows
    .map((r, i) => `<row r="${i + 1}">${r.map((c, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="s"><v>${idx(c)}</v></c>`).join('')}</row>`)
    .join('');
  return Buffer.from(
    zipSync({
      'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${sheet}</sheetData></worksheet>`),
      'xl/sharedStrings.xml': strToU8(`<sst>${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`),
    }),
  );
};
/** A one-page PDF with a line of text (pdf.js tolerates the approximate xref). */
const pdf = (text: string) => {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
};

describe('extraction (unit)', async () => {
  const s = await import('../src/sources.js');
  it('recognises files by their bytes, not their name', () => {
    expect(s.fileType(pdf('x'), 'katalog.txt')).toBe('pdf');
    expect(s.fileType(docx(['x']), 'a.docx')).toBe('docx');
    expect(s.fileType(xlsx([['a']]), 'a.xlsx')).toBe('xlsx');
    expect(s.fileType(Buffer.from('a,b\n1,2'), 'a.csv')).toBe('csv');
    expect(s.fileType(Buffer.from('salam'), 'qeyd.txt')).toBe('text');
    expect(s.fileType(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]), 'virus.txt')).toBeNull();
    expect(s.fileType(Buffer.from('PK\u0003\u0004'), 'arxiv.zip')).toBeNull();
  });
  it('web pages become readable text without scripts, menus and footers', () => {
    const t = s.htmlToText(
      '<html><head><title>Çatdırılma &amp; ödəniş</title><script>alert(1)</script></head><body><nav>Menyu</nav><h1>Çatdırılma</h1><p>Bakı daxili 5&nbsp;AZN.</p><footer>© 2026</footer></body></html>',
    );
    expect(t.title).toBe('Çatdırılma & ödəniş');
    expect(t.text).toBe('Çatdırılma\nBakı daxili 5 AZN.');
  });
  it('long text is cut into pieces on paragraph boundaries; table rows become products', () => {
    const pieces = s.chunkText('Qaydalar', Array.from({ length: 30 }, (_, i) => `Bənd ${i}: ${'x'.repeat(100)}`).join('\n'));
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.body.length <= 1500)).toBe(true);
    expect(pieces[1]!.title).toBe('Qaydalar · 2');
    expect(
      s.tableRows([
        ['Məhsul', 'Qiymət', 'Ölçü'],
        ['Yay donu', '45 AZN', 'S-XL'],
        ['', '', ''],
      ]),
    ).toEqual([{ kind: 'product', title: 'Yay donu', body: 'Məhsul: Yay donu; Qiymət: 45 AZN; Ölçü: S-XL' }]);
  });
});

describe.skipIf(!enabled)('knowledge sources (integration)', () => {
  let db: typeof import('../src/db.js');
  let sources: typeof import('../src/sources.js');
  let app: import('fastify').FastifyInstance;
  let ws: Awaited<ReturnType<typeof seedWorkspace>>;
  let owner: Awaited<ReturnType<typeof loginAs>>;
  const SITE = 'http://127.0.0.1:4011';

  const upload = (name: string, body: Buffer, who = owner) =>
    app.inject({
      method: 'POST',
      url: `/app/knowledge/sources/file?name=${encodeURIComponent(name)}`,
      headers: { ...who.headers, 'content-type': 'application/octet-stream', 'x-csrf-token': who.csrf },
      payload: body,
    });
  /** Runs the queued job like the worker would, returns the source row. */
  const processLatest = async () => {
    const s = await db.one(`SELECT id FROM knowledge_sources WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`, [ws.workspaceId]);
    await sources.processSource(s.id);
    return db.one(`SELECT * FROM knowledge_sources WHERE id = $1`, [s.id]);
  };
  const addUrl = (url: string, mode: 'url' | 'site') =>
    app.inject({ method: 'POST', url: '/app/knowledge/sources/url', headers: owner.headers, payload: { _csrf: owner.csrf, url, mode } });

  beforeAll(async () => {
    await startFake();
    db = await import('../src/db.js');
    sources = await import('../src/sources.js');
    await resetDb();
    ws = await seedWorkspace('src', 'IGSRC');
    app = await (await import('../src/server.js')).buildServer();
    owner = await loginAs(app, ws.email);
    fake.handler = (_b, path) => {
      const page = (title: string, body: string) => ({
        file: { type: 'text/html; charset=utf-8', body: Buffer.from(`<html><head><title>${title}</title></head><body>${body}</body></html>`) },
      });
      if (path === '/shop/delivery') return page('Çatdırılma', '<p>Gəncəyə çatdırılma 3 gün, 8 AZN.</p>');
      if (path === '/sitemap.xml')
        return {
          file: {
            type: 'application/xml',
            body: Buffer.from(`<urlset><url><loc>${SITE}/shop/delivery</loc></url><url><loc>${SITE}/shop/returns</loc></url></urlset>`),
          },
        };
      if (path === '/shop/returns') return page('Qaytarma', '<p>Qaytarma 14 gün ərzində mümkündür.</p>');
      return undefined;
    };
  });
  afterAll(async () => {
    await app.close();
    await stopFake();
    const { closeQueues, redis } = await import('../src/queue.js');
    (await import('../src/realtime.js')).closeRealtime();
    await closeQueues();
    redis.disconnect();
    await db.pool.end();
  });

  it('PDF, Word, TXT, CSV and Excel files become searchable pieces', async () => {
    for (const [name, body] of [
      ['qaydalar.pdf', pdf('Qaytarma qaydasi: etiketi qopmamis mehsul 14 gun erzinde')],
      ['haqqimizda.docx', docx(['Gül Butik 2015-ci ildən fəaliyyət göstərir.', 'Mağazamız Nizami küçəsindədir.'])],
      ['qeyd.txt', Buffer.from('İş saatları: hər gün 10:00-20:00.')],
      ['kataloq.csv', Buffer.from('Məhsul,Qiymət,Ölçü\nPayız pencəyi,79 AZN,S-XL\nYay donu,45 AZN,S-L\n')],
      [
        'aksesuar.xlsx',
        xlsx([
          ['Məhsul', 'Qiymət'],
          ['Dəri kəmər', '25 AZN'],
        ]),
      ],
    ] as const) {
      const r = await upload(name, body);
      expect(r.json(), name).toEqual({ ok: true });
      const s = await processLatest();
      expect(s, name).toMatchObject({ status: 'ready', error: '' });
      expect(s.items, name).toBeGreaterThan(0);
    }
    expect((await db.one(`SELECT count(*)::int AS n FROM knowledge_uploads`)).n).toBe(0); // file bytes are not kept
    const csv = await db.one(`SELECT kind FROM knowledge_sources WHERE name = 'kataloq.csv'`);
    expect(csv.kind).toBe('table');
    expect(await db.q(`SELECT kind, title, body FROM knowledge_items WHERE source_id IS NOT NULL AND title = 'Payız pencəyi'`)).toEqual([
      { kind: 'product', title: 'Payız pencəyi', body: 'Məhsul: Payız pencəyi; Qiymət: 79 AZN; Ölçü: S-XL' },
    ]);

    // The AI gets only the matching pieces, and Azerbaijani letters do not matter ("pencek" finds "pencəyi").
    expect(await sources.sourceHits(ws.workspaceId, 'payiz pencek nece?')).toContain('Payız pencəyi');
    expect(await sources.sourceHits(ws.workspaceId, 'qaytarma necə olur')).toContain('14 gun');
    expect(await sources.sourceHits(ws.workspaceId, 'kəmər var?')).toContain('Dəri kəmər');
    expect(await sources.sourceHits(ws.workspaceId, 'salam')).toBe('');
    const { knowledgeFor } = await import('../src/context.js');
    expect((await knowledgeFor(ws.workspaceId, 'Nizami küçəsi harada?')).knowledge).toContain('Nizami küçəsindədir');
  });

  it('a price that is only in a source passes the price check (the model saw that piece)', async () => {
    const { parseInstagramWebhook } = await import('../src/channels/instagram.js');
    const pipeline = await import('../src/pipeline.js');
    const site = fake.handler;
    fake.calls = [];
    fake.handler = (b, path) => (path === '/v1/messages' ? aiText('Payız pencəyi 79 AZN-dir, S-XL ölçülər var 🙂') : site(b, path));
    try {
      for (const ev of parseInstagramWebhook(igMessage('IGSRC', 'U-src', 'src.1', 'Payız pencəyi neçəyədir?'))) await pipeline.ingest(ev);
      const m = await db.one(`SELECT id, conversation_id FROM messages WHERE external_id = 'src.1'`);
      await pipeline.processReply(m.conversation_id, m.id);
      expect(JSON.stringify(fake.aiCalls()[0]!.body.system)).toContain('Payız pencəyi');
      expect(fake.sends().map((c) => c.body.message.text)).toEqual(['Payız pencəyi 79 AZN-dir, S-XL ölçülər var 🙂']);
    } finally {
      fake.handler = site;
    }
  });

  it('a simple question that matches a big catalogue stays on the fast model; at most 4 pieces go to the AI', async () => {
    const { buildContext } = await import('../src/context.js');
    const { parseInstagramWebhook } = await import('../src/channels/instagram.js');
    const pipeline = await import('../src/pipeline.js');
    // A large catalogue: many rows that all match "don", each ~870 characters, so 3 pieces (~2 600 characters,
    // more than the routing threshold of 2 500) fit the 800-token source budget whichever rows rank first.
    const rows = Array.from({ length: 40 }, (_, i) => `Yay donu model ${i},${40 + i} AZN,S-XL,${'uzun təsvir '.repeat(65)}`).join('\n');
    await upload('boyuk-kataloq.csv', Buffer.from(`Məhsul,Qiymət,Ölçü,Təsvir\n${rows}\n`));
    expect(await processLatest()).toMatchObject({ status: 'ready' });
    for (const ev of parseInstagramWebhook(igMessage('IGSRC', 'U-route', 'route.1', 'don var?'))) await pipeline.ingest(ev);
    const m = await db.one(`SELECT conversation_id FROM messages WHERE external_id = 'route.1'`);
    const ctx = await buildContext(m.conversation_id, ws.workspaceId);
    expect(ctx.extra.knowledge).toContain('Yay donu model');
    expect(ctx.extra.knowledge!.split('\n').filter((l) => l.startsWith('[product]')).length).toBeLessThanOrEqual(4);
    expect(ctx.extra.knowledge!.length).toBeGreaterThan(2500); // would have pushed the reply to the smart model
    expect(ctx.route).toBe('fast');
  });

  it('a page or a whole site (sitemap) is read; private addresses are refused', async () => {
    await addUrl(`${SITE}/shop/delivery`, 'url');
    expect(await processLatest()).toMatchObject({ status: 'ready', kind: 'url' });
    await addUrl(`${SITE}/`, 'site');
    const site = await processLatest();
    expect(site).toMatchObject({ status: 'ready', kind: 'site' });
    expect(site.items).toBe(2);
    expect(await sources.sourceHits(ws.workspaceId, 'Gəncəyə çatdırılma')).toContain('8 AZN');

    process.env.WEBHOOK_ALLOW_PRIVATE = '';
    try {
      await addUrl('http://169.254.169.254/latest/meta-data/', 'url');
      expect(await processLatest()).toMatchObject({ status: 'failed', error: expect.stringContaining('açıq internet') });
    } finally {
      process.env.WEBHOOK_ALLOW_PRIVATE = '1';
    }
    expect((await addUrl('javascript:alert(1)', 'url')).headers.location).toContain('source_bad_url');
  });

  it('files that are not documents, and the plan’s MB limit', async () => {
    await upload('setup.exe', Buffer.from([0x4d, 0x5a, 0, 0, 1]));
    expect(await processLatest()).toMatchObject({ status: 'failed', error: expect.stringContaining('dəstəklənmir') });

    // Plan override: almost no room left -> the next source fails with a clear message, nothing is stored.
    await db.q(`UPDATE workspaces SET limit_overrides = '{"knowledge_mb": 0.0001}' WHERE id = $1`, [ws.workspaceId]);
    const before = (await db.one(`SELECT count(*)::int AS n FROM knowledge_items WHERE source_id IS NOT NULL`)).n;
    const r = await upload('boyuk.txt', Buffer.from('a '.repeat(5000)));
    // already over the limit: refused at upload time
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('limiti dolub');
    await db.q(`UPDATE workspaces SET limit_overrides = '{}' WHERE id = $1`, [ws.workspaceId]);
    expect((await db.one(`SELECT count(*)::int AS n FROM knowledge_items WHERE source_id IS NOT NULL`)).n).toBe(before);

    const used = (await sources.sourceUsage(ws.workspaceId)).used;
    await db.q(`UPDATE workspaces SET limit_overrides = $2 WHERE id = $1`, [ws.workspaceId, JSON.stringify({ knowledge_mb: (used + 100) / 1048576 })]);
    await upload('boyuk.txt', Buffer.from('salam '.repeat(1000)));
    expect(await processLatest()).toMatchObject({ status: 'failed', error: expect.stringContaining('limiti dolur') });
    await db.q(`UPDATE workspaces SET limit_overrides = '{}' WHERE id = $1`, [ws.workspaceId]);
  });

  it('the knowledge page shows sources and usage; Q&A adds an item; deleting a source deletes its pieces', async () => {
    await db.q(`UPDATE workspaces SET plan_id = (SELECT id FROM plans WHERE name = 'Biznes') WHERE id = $1`, [ws.workspaceId]);
    const page = await app.inject({ url: '/app/knowledge', headers: owner.headers });
    expect(page.body).toContain('Mənbələr');
    expect(page.body).toContain('kataloq.csv');
    expect(page.body).toMatch(/\d+ KB \/ 20\.0 MB/); // Biznes plan: 20 MB
    expect(page.body).not.toContain('Payız pencəyi'); // source pieces are not listed as hand-written items

    await app.inject({
      method: 'POST',
      url: '/app/knowledge/qa',
      headers: owner.headers,
      payload: { _csrf: owner.csrf, question: 'Kartla ödəniş olar?', answer: 'Bəli, kartla və nağd.' },
    });
    expect(await db.one(`SELECT kind, body FROM knowledge_items WHERE title = 'Kartla ödəniş olar?'`)).toEqual({ kind: 'faq', body: 'Bəli, kartla və nağd.' });

    const s = await db.one(`SELECT id FROM knowledge_sources WHERE name = 'kataloq.csv'`);
    await app.inject({ method: 'POST', url: `/app/knowledge/sources/${s.id}/delete`, headers: owner.headers, payload: { _csrf: owner.csrf } });
    expect((await db.one(`SELECT count(*)::int AS n FROM knowledge_items WHERE source_id = $1`, [s.id])).n).toBe(0);
    expect(await sources.sourceHits(ws.workspaceId, 'payız pencəyi')).toBe('');
  });

  it('only people who may edit the assistant can add sources', async () => {
    const { hash } = await import('@node-rs/argon2');
    const u = await db.one(`INSERT INTO users (email, password_hash, email_verified_at) VALUES ('agent@src.az', $1, now()) RETURNING id`, [
      await hash('correct-horse-battery'),
    ]);
    await db.q(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'agent')`, [ws.workspaceId, u.id]);
    const agent = await loginAs(app, 'agent@src.az');
    expect((await upload('x.txt', Buffer.from('x'), agent)).statusCode).toBe(403);
  });
});
