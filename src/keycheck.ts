import { sha256 } from './crypto.js';
import { one, q } from './db.js';

const fp = (key: string) => sha256(`fingerprint:${key}`).toString('hex').slice(0, 24);

/**
 * Stops startup if ENCRYPTION_KEY differs from the key the stored secrets were encrypted with.
 * Rotation: set the new ENCRYPTION_KEY and the old one as ENCRYPTION_KEY_PREVIOUS; the worker re-encrypts
 * everything and then records the new fingerprint (finishKeyRotation). Remove ENCRYPTION_KEY_PREVIOUS afterwards.
 */
export async function assertEncryptionKey(): Promise<void> {
  const current = fp(process.env.ENCRYPTION_KEY ?? '');
  await q(`INSERT INTO app_meta (key, value) VALUES ('encryption_key_fp', $1) ON CONFLICT DO NOTHING`, [current]);
  const stored = (await one<{ value: string }>(`SELECT value FROM app_meta WHERE key = 'encryption_key_fp'`))?.value;
  const previous = process.env.ENCRYPTION_KEY_PREVIOUS ? fp(process.env.ENCRYPTION_KEY_PREVIOUS) : null;
  if (stored !== current && stored !== previous) {
    console.error('FATAL: ENCRYPTION_KEY does not match the key this database was set up with. Restore the original key from your backup.');
    process.exit(1);
  }
}

export async function finishKeyRotation(): Promise<void> {
  await q(`UPDATE app_meta SET value = $1 WHERE key = 'encryption_key_fp'`, [fp(process.env.ENCRYPTION_KEY ?? '')]);
}
