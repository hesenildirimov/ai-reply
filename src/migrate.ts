import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// Migrations need DDL rights; the web/worker DATABASE_URL is the least-privilege app_rw role (docs/DEPLOY.md).
// config.ts reads process.env when it loads, so db.js is imported after the swap.
if (process.env.MIGRATE_DATABASE_URL) process.env.DATABASE_URL = process.env.MIGRATE_DATABASE_URL;
const { pool, tx } = await import('./db.js');

const dir = path.resolve('migrations');

await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));

for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
  if (done.has(file)) continue;
  const sql = await readFile(path.join(dir, file), 'utf8');
  await tx(async (c) => {
    await c.query(sql);
    await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
  });
  console.log(`applied ${file}`);
}
await pool.end();
