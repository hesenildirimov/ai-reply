import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pool, tx } from './db.js';

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
