import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { healthSignal } from './alerts.js';
import { config } from './config.js';
import { pool } from './db.js';
import { drainOutbox } from './inbound.js';
import { type Data, runJob } from './jobs.js';
import { assertEncryptionKey, assertLeastPrivilege } from './keycheck.js';
import { closeQueues, INBOUND_QUEUE, QUEUE, queue, redis } from './queue.js';

await assertEncryptionKey();
await assertLeastPrivilege();

// Two pools of slots: webhook intake (short DB work) never waits behind AI replies (seconds each).
// Sizes come from scripts/loadtest.ts measurements; see README "Capacity".
const connection = () => new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const workers = [
  new Worker<Data>(INBOUND_QUEUE, runJob, { connection: connection(), concurrency: config.INBOUND_CONCURRENCY }),
  new Worker<Data>(QUEUE, runJob, { connection: connection(), concurrency: config.WORKER_CONCURRENCY }),
];
for (const w of workers)
  w.on('failed', (job, err) => {
    console.error(`job ${job?.name} ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message);
    // Out of retries (or not retryable): the work is lost unless someone looks. Admins hear about a burst of these.
    if (!job || job.attemptsMade >= (job.opts.attempts ?? 1) || err.name === 'UnrecoverableError')
      void healthSignal('job_dead', `${job?.name}: ${err.message}`.slice(0, 200));
  });
await queue.upsertJobScheduler('maintenance', { every: 3600_000 }, { name: 'maintenance', data: { kind: 'maintenance' } as never });
await queue.upsertJobScheduler('sweep', { every: 300_000 }, { name: 'sweep', data: { kind: 'sweep' } });

// Webhooks that arrived while Redis was unreachable wait in Postgres; move them into the queue.
let draining = false;
const outbox = setInterval(async () => {
  if (draining) return;
  draining = true;
  try {
    while ((await drainOutbox()) > 0);
  } catch (e) {
    console.error('outbox drain failed:', (e as Error).message);
  } finally {
    draining = false;
  }
}, 5000);
console.log(`worker started (inbound ${config.INBOUND_CONCURRENCY}, messages ${config.WORKER_CONCURRENCY} slots)`);

const close = async () => {
  clearInterval(outbox);
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled([closeQueues(), pool.end()]);
  redis.disconnect();
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
