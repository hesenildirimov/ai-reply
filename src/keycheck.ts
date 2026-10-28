import { config } from './config.js';
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

/**
 * Production web/worker must run as the least-privilege app_rw role: no superuser, no DDL, no role or database
 * creation, no server-side file/program access, and owning no tables (an owner can DROP them). Then a future SQL
 * injection stays a data bug instead of becoming command execution on the database server (COPY ... TO PROGRAM).
 * ALLOW_PRIVILEGED_DB=1 is an escape hatch for the switch-over only.
 */
export async function assertLeastPrivilege(): Promise<void> {
  if (!config.isProd || process.env.ALLOW_PRIVILEGED_DB === '1') return;
  if (await privilegedRole()) {
    console.error(
      'FATAL: DATABASE_URL uses a privileged role. Use the least-privilege app_rw role (docs/DEPLOY.md), or set ALLOW_PRIVILEGED_DB=1 while switching over.',
    );
    process.exit(1);
  }
}

/** True unless the connected role is plainly data-only (unknown counts as privileged). */
export async function privilegedRole(db?: Parameters<typeof one>[2]): Promise<boolean> {
  const r = await one<{ privileged: boolean }>(
    `SELECT r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls
         OR pg_has_role(current_user, 'pg_execute_server_program', 'MEMBER')
         OR pg_has_role(current_user, 'pg_write_server_files', 'MEMBER')
         OR pg_has_role(current_user, 'pg_read_server_files', 'MEMBER')
         OR EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tableowner = current_user) AS privileged
       FROM pg_roles r WHERE r.rolname = current_user`,
    [],
    db,
  );
  return r?.privileged !== false;
}
