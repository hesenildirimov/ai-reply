// Usage: npm run seed:mock [-- owner@example.com]
// INTEGRATION_MODE=mock only. Creates the demo business ("Demo Butik") with a simulated Instagram account, a 12-product
// catalog, FAQ records and four sample posts, and prints a one-time link to set the owner's password.
import { createDemoBusiness, seedDemoData } from '../src/commerce/fixtures.js';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';
import { redis } from '../src/queue.js';
import { passwordLink } from '../src/web/public.js';

if (!config.mockMode) {
  console.error('seed:mock only runs with INTEGRATION_MODE=mock (it creates simulated accounts).');
  process.exit(1);
}
const email = (process.argv[2] ?? 'demo@aireply.local').trim().toLowerCase();
const { userId, workspaceId } = await createDemoBusiness(email);
const demo = await seedDemoData(workspaceId);
console.log(`Demo business ready for ${email}
  Simulated Instagram account: ${demo.igId}
  Products: ${Object.keys(demo.products).length}, posts: ${Object.keys(demo.posts).length}
Set the owner's password (72h, one-time):
${await passwordLink(userId, '72 hours')}

Start the app and the worker (both are needed): npm run dev  +  npm run dev:worker
Then open /app/dev (Simulyator).`);
await pool.end();
redis.disconnect();
