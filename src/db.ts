import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });

type Db = Pick<pg.Pool, 'query'>;

export async function q<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  return (await db.query<T>(text, params)).rows;
}

export async function one<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = [], db: Db = pool): Promise<T | undefined> {
  return (await q<T>(text, params, db))[0];
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const res = await fn(c);
    await c.query('COMMIT');
    return res;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
