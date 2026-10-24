// Usage: npm run create-admin -- you@example.com
// Creates (or promotes) an admin with its own demo workspace and prints a one-time password link.
import { z } from 'zod';
import { config } from './config.js';
import { one, pool, tx } from './db.js';
import { redis } from './queue.js';
import { passwordLink } from './web/public.js';

const email = z.email().safeParse(process.argv[2]?.trim().toLowerCase());
if (!email.success) {
  console.error('Usage: npm run create-admin -- you@example.com');
  process.exit(1);
}

let user = await one<{ id: string }>('SELECT id FROM users WHERE email = $1', [email.data]);
if (user) {
  await pool.query('UPDATE users SET is_admin = true WHERE id = $1', [user.id]);
} else {
  user = await tx(async (c) => {
    const u = (await c.query(`INSERT INTO users (email, password_hash, is_admin) VALUES ($1, '!', true) RETURNING id`, [email.data])).rows[0];
    const w = (await c.query(`INSERT INTO workspaces (name, monthly_reply_limit) VALUES ('Demo', $1) RETURNING id`, [config.DEFAULT_REPLY_LIMIT])).rows[0];
    await c.query(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [w.id, u.id]);
    await c.query(`INSERT INTO assistants (workspace_id, business_name) VALUES ($1, 'Demo')`, [w.id]);
    return u;
  });
}
console.log(`Admin: ${email.data}\nSet your password (72h, one-time):\n${await passwordLink(user!.id, '72 hours')}`);
await pool.end();
redis.disconnect();
