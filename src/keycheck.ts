import { config } from './config.js';
import { sha256 } from './crypto.js';
import { one, q } from './db.js';

/** Stops startup if ENCRYPTION_KEY differs from the one the stored tokens were encrypted with. */
export async function assertEncryptionKey(): Promise<void> {
  const fp = sha256(`fingerprint:${config.ENCRYPTION_KEY}`).toString('hex').slice(0, 24);
  await q(`INSERT INTO app_meta (key, value) VALUES ('encryption_key_fp', $1) ON CONFLICT DO NOTHING`, [fp]);
  const row = await one<{ value: string }>(`SELECT value FROM app_meta WHERE key = 'encryption_key_fp'`);
  if (row?.value !== fp) {
    console.error('FATAL: ENCRYPTION_KEY does not match the key this database was set up with. Restore the original key from your backup.');
    process.exit(1);
  }
}
