import { unzipSync } from 'fflate';
import { estimateTokens } from './aiconfig.js';
import { parseCsv } from './csv.js';
import { one, q, tx } from './db.js';
import { fetchPublic } from './fetch-public.js';
import { limitsOf } from './plans.js';
import { normalize } from './text.js';

/**
 * Knowledge sources: a file (PDF, Word, TXT/MD), a web page or a whole site, or a table (CSV/Excel) becomes knowledge
 * items the AI can use. The worker extracts the text (job 'knowledge_source'), cuts it into small pieces and stores them
 * with a full-text index; each reply fetches only the pieces that match the customer's question (sourceHits), so even
 * tens of MB of sources keep the prompt small. What counts against the plan (knowledge_mb) is the extracted text.
 */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // one file
const MAX_SITE_PAGES = 30;
const CHUNK = 1500; // characters per item: small pieces are found more precisely
const MAX_TABLE_ROWS = 5000;
// Source pieces per reply: the best few matches, ~800 tokens (a reply costs the same whatever the sources' size).
const SOURCE_TOKEN_BUDGET = 800;
const SOURCE_PIECES = 4;

export type SourceKind = 'file' | 'url' | 'site' | 'table';
export interface SourceRow {
  id: string;
  workspace_id: string;
  kind: SourceKind;
  name: string;
  url: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  error: string;
  bytes: number;
  items: number;
  created_at: Date;
}

interface Piece {
  kind: 'info' | 'product';
  title: string;
  body: string;
}

// ---------- usage against the plan ----------

/** Bytes of extracted text in the workspace's sources (excluding one being replaced) and the plan's limit (null = none). */
export async function sourceUsage(workspaceId: string, exceptId?: string): Promise<{ used: number; limit: number | null }> {
  const used = Number(
    (
      await one<{ n: string }>(
        `SELECT coalesce(sum(bytes), 0) AS n FROM knowledge_sources WHERE workspace_id = $1 AND status <> 'failed' AND id <> coalesce($2, '00000000-0000-0000-0000-000000000000'::uuid)`,
        [workspaceId, exceptId ?? null],
      )
    )?.n ?? 0,
  );
  const mb = (await limitsOf(workspaceId)).knowledge_mb;
  return { used, limit: mb === null ? null : mb * 1024 * 1024 };
}

// ---------- text extraction ----------

const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&amp;/g, '&');

/** Readable text of an HTML page (scripts, styles, navigation and footers dropped). */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const body = html
    .replace(/<(script|style|noscript|svg|template|nav|footer|head|iframe|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(p|div|section|article|li|ul|ol|h[1-6]|tr|table|br|hr|header|main|aside|blockquote|dd|dt)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' · ')
    .replace(/<[^>]+>/g, ' ');
  return { title, text: tidy(decodeEntities(body)) };
}

const tidy = (s: string) =>
  s
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim();

/** Files inside a zip (Word / Excel), refusing zip bombs: only the named entries, each at most 50 MB unpacked. */
function unzip(buf: Buffer, names: (n: string) => boolean): Record<string, string> {
  const files = unzipSync(new Uint8Array(buf), { filter: (f) => names(f.name) && f.originalSize < 50 * 1024 * 1024 });
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString('utf8')]));
}

function docxText(buf: Buffer): string {
  const xml = unzip(buf, (n) => n === 'word/document.xml')['word/document.xml'];
  if (!xml) throw new Error('not a Word document');
  const paragraphs = xml.split(/<\/w:p>/).map((p) => [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''));
  return tidy(decodeEntities(paragraphs.join('\n')));
}

const colIndex = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? 'A')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** First sheet of an .xlsx as rows of cell text. */
function xlsxRows(buf: Buffer): string[][] {
  const files = unzip(buf, (n) => n === 'xl/sharedStrings.xml' || n === 'xl/worksheets/sheet1.xml');
  const sheet = files['xl/worksheets/sheet1.xml'];
  if (!sheet) throw new Error('not an Excel file');
  const shared = [...(files['xl/sharedStrings.xml'] ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    decodeEntities([...m[1]!.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join('')),
  );
  const rows: string[][] = [];
  for (const r of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!;
      const inner = c[2] ?? '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? '';
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? '';
      const text =
        type === 's'
          ? (shared[Number(v)] ?? '')
          : type === 'inlineStr'
            ? decodeEntities(/<t(?:\s[^>]*)?>([^<]*)<\/t>/.exec(inner)?.[1] ?? '')
            : decodeEntities(v);
      row[ref ? colIndex(ref) : row.length] = text;
    }
    rows.push(Array.from(row, (x) => x ?? ''));
    if (rows.length > MAX_TABLE_ROWS) break;
  }
  return rows;
}

async function pdfText(buf: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  if (pdf.numPages > 500) throw new Error('too many pages');
  const { text } = await extractText(pdf, { mergePages: false });
  return tidy((text as string[]).join('\n\n'));
}

/** What an uploaded file is, by its bytes first (the name can lie), then by its extension. */
export function fileType(buf: Buffer, filename: string): 'pdf' | 'docx' | 'xlsx' | 'csv' | 'text' | null {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? '';
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b) return ext === 'xlsx' ? 'xlsx' : ext === 'docx' ? 'docx' : null;
  if (buf.includes(0)) return null; // other binary
  if (ext === 'csv') return 'csv';
  return ['txt', 'md', 'text', ''].includes(ext) ? 'text' : null;
}

// ---------- pieces ----------

/** Cuts text into knowledge items of at most CHUNK characters, on paragraph and sentence boundaries. */
export function chunkText(name: string, text: string): Piece[] {
  const parts: string[] = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) parts.push(cur.trim());
    cur = '';
  };
  for (const para of text.split(/\n{1,}/)) {
    const sentences = para.length > CHUNK ? para.split(/(?<=[.!?])\s+/) : [para];
    for (let s of sentences) {
      while (s.length > CHUNK) {
        push();
        parts.push(s.slice(0, CHUNK));
        s = s.slice(CHUNK);
      }
      if (cur.length + s.length + 1 > CHUNK) push();
      cur += `${cur ? '\n' : ''}${s}`;
    }
  }
  push();
  return parts.map((body, i) => ({ kind: 'info', title: `${name}${parts.length > 1 ? ` · ${i + 1}` : ''}`.slice(0, 120), body }));
}

/** One item per table row: "Column: value; ..." under the row's first cell as its title. */
export function tableRows(rows: string[][]): Piece[] {
  const [head, ...data] = rows.filter((r) => r.some((c) => c?.trim()));
  if (!head) return [];
  return data.slice(0, MAX_TABLE_ROWS).flatMap((r) => {
    const cells = r.map((c) => (c ?? '').trim());
    const title = cells.find(Boolean);
    if (!title) return [];
    const body = cells
      .map((c, i) => (c ? `${(head[i] ?? '').trim() || `#${i + 1}`}: ${c}` : ''))
      .filter(Boolean)
      .join('; ')
      .slice(0, 3900);
    return [{ kind: 'product' as const, title: `${title}`.slice(0, 120), body: body || title }];
  });
}

// ---------- sites ----------

const sameSite = (a: URL, b: URL) => a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '');
const SKIP = /\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|docx?|xlsx?|css|js)(\?|$)/i;

/** Pages of a site: its sitemap if it has one, otherwise the links on the start page (same site, at most 30). */
async function sitePages(start: URL): Promise<URL[]> {
  const found = new Map<string, URL>([[start.href.split('#')[0]!, start]]);
  const add = (href: string, base: URL) => {
    const u = URL.parse(href, base);
    if (!u || !['http:', 'https:'].includes(u.protocol) || !sameSite(u, start) || SKIP.test(u.pathname)) return;
    u.hash = '';
    if (found.size < MAX_SITE_PAGES) found.set(u.href, u);
  };
  const sitemap = await fetchPublic(/sitemap[^/]*\.xml$/i.test(start.pathname) ? start.href : new URL('/sitemap.xml', start).href).catch(() => null);
  if (sitemap && /<urlset|<sitemapindex/i.test(sitemap.body)) {
    found.clear();
    for (const m of sitemap.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) add(decodeEntities(m[1]!), start);
  } else {
    const page = await fetchPublic(start.href);
    for (const m of page.body.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#][^"']*)["']/gi)) add(decodeEntities(m[1]!), start);
  }
  return [...found.values()];
}

async function pageText(url: string): Promise<{ title: string; text: string }> {
  const page = await fetchPublic(url);
  if (page.type && !/html|text\/plain|xml/.test(page.type)) throw new Error('not a web page');
  return page.type === 'text/plain' ? { title: '', text: tidy(page.body) } : htmlToText(page.body);
}

// ---------- the job ----------

class SourceError extends Error {}
const fail = (m: string): never => {
  throw new SourceError(m);
};

async function extract(s: SourceRow): Promise<Piece[]> {
  if (s.kind === 'url') {
    const p = await pageText(s.url);
    return chunkText(p.title || s.name, p.text);
  }
  if (s.kind === 'site') {
    const pieces: Piece[] = [];
    for (const u of await sitePages(new URL(s.url))) {
      const p = await pageText(u.href).catch(() => null);
      if (p?.text) pieces.push(...chunkText(p.title || u.pathname, p.text));
    }
    return pieces;
  }
  const up = await one<{ filename: string; data: Buffer }>(`SELECT filename, data FROM knowledge_uploads WHERE source_id = $1`, [s.id]);
  if (!up) return fail('Fayl tapılmadı, yenidən yükləyin.');
  const type = fileType(up.data, up.filename);
  if (type === 'pdf') return chunkText(s.name, await pdfText(up.data));
  if (type === 'docx') return chunkText(s.name, docxText(up.data));
  if (type === 'text') return chunkText(s.name, tidy(up.data.toString('utf8')));
  if (type === 'csv') return tableRows(parseCsv(up.data.toString('utf8'), MAX_TABLE_ROWS));
  if (type === 'xlsx') return tableRows(xlsxRows(up.data));
  return fail('Bu fayl növü dəstəklənmir. PDF, Word (.docx), TXT, CSV və ya Excel (.xlsx) yükləyin.');
}

const MESSAGE: [RegExp, string][] = [
  [/blocked address|invalid url/, 'Bu ünvan açıla bilməz (yalnız açıq internet saytları).'],
  [/timeout|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|HTTP \d/, 'Sayt açılmadı. Linki yoxlayın və ya bir az sonra yenidən cəhd edin.'],
  [/too large|too many pages/, 'Fayl və ya səhifə çox böyükdür.'],
  [/password|encrypted/i, 'Faylı oxumaq mümkün olmadı (şifrəli və ya zədəli ola bilər).'],
];

/** Worker job: turns one source into knowledge items (re-runnable: a retry replaces what an earlier try wrote). */
export async function processSource(sourceId: string): Promise<void> {
  const s = await one<SourceRow>(
    `UPDATE knowledge_sources SET status = 'processing', updated_at = now() WHERE id = $1 AND status IN ('queued', 'processing') RETURNING *`,
    [sourceId],
  );
  if (!s) return;
  try {
    const pieces = (await withTimeout(extract(s), 5 * 60_000)).filter((p) => p.body.trim());
    if (!pieces.length) fail('Mətn tapılmadı (skan edilmiş PDF və ya boş səhifə ola bilər).');
    const bytes = pieces.reduce((n, p) => n + Buffer.byteLength(p.body), 0);
    const { used, limit } = await sourceUsage(s.workspace_id, s.id);
    if (limit !== null && used + bytes > limit)
      fail(`Tarifin bilik bazası limiti dolur: ${(bytes / 1048576).toFixed(1)} MB əlavə olunmalı idi, ${((limit - used) / 1048576).toFixed(1)} MB yer qalıb.`);
    await tx(async (c) => {
      await c.query(`DELETE FROM knowledge_items WHERE source_id = $1`, [s.id]);
      for (let i = 0; i < pieces.length; i += 200) {
        const batch = pieces.slice(i, i + 200);
        await c.query(
          `INSERT INTO knowledge_items (workspace_id, source_id, kind, title, body, search)
           SELECT $1, $2, x.kind, x.title, x.body, to_tsvector('simple', x.norm) FROM jsonb_to_recordset($3::jsonb) AS x(kind text, title text, body text, norm text)`,
          [s.workspace_id, s.id, JSON.stringify(batch.map((p) => ({ ...p, norm: normalize(`${p.title} ${p.body}`) })))],
        );
      }
      await c.query(`UPDATE knowledge_sources SET status = 'ready', error = '', bytes = $2, items = $3, updated_at = now() WHERE id = $1`, [
        s.id,
        bytes,
        pieces.length,
      ]);
      await c.query(`DELETE FROM knowledge_uploads WHERE source_id = $1`, [s.id]);
    });
  } catch (e) {
    const msg = e instanceof SourceError ? e.message : (MESSAGE.find(([re]) => re.test(String((e as Error).message)))?.[1] ?? 'Mənbəni oxumaq mümkün olmadı.');
    await q(`UPDATE knowledge_sources SET status = 'failed', error = $2, bytes = 0, items = 0, updated_at = now() WHERE id = $1`, [s.id, msg]);
    await q(`DELETE FROM knowledge_items WHERE source_id = $1`, [s.id]);
    await q(`DELETE FROM knowledge_uploads WHERE source_id = $1`, [s.id]);
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref())]);

// ---------- retrieval ----------

/**
 * Source pieces that match the customer's words (full-text search, prefix matches, best first) within a token budget.
 * Used next to planKnowledge for the hand-written items, which stay small enough to be scored in memory.
 */
export async function sourceHits(workspaceId: string, query: string, budget = SOURCE_TOKEN_BUDGET): Promise<string> {
  const words = [
    ...new Set(
      normalize(query)
        .split(' ')
        .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
        .filter((w) => w.length > 2),
    ),
  ].slice(-16);
  if (!words.length) return '';
  const tsq = words.map((w) => `${w}:*`).join(' | ');
  const rows = await q<{ kind: string; title: string; body: string }>(
    `SELECT kind, title, body FROM knowledge_items
     WHERE workspace_id = $1 AND active AND source_id IS NOT NULL AND search @@ to_tsquery('simple', $2)
     ORDER BY ts_rank(search, to_tsquery('simple', $2)) DESC LIMIT ${SOURCE_PIECES}`,
    [workspaceId, tsq],
  );
  const out: string[] = [];
  let used = 0;
  for (const r of rows) {
    const block = `[${r.kind}] ${r.title}: ${r.body}`;
    const t = estimateTokens(block);
    if (used + t > budget) continue;
    out.push(block);
    used += t;
  }
  return out.join('\n');
}
