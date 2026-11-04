import pg from 'pg';

// Keep DATE columns as 'YYYY-MM-DD' strings so time zones never shift a visit to another day.
pg.types.setTypeParser(1082, (v) => v);
// NUMERIC -> number, BIGINT (counts, sums) -> number. Our values stay well inside 2^53.
pg.types.setTypeParser(1700, (v) => parseFloat(v));
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

export type Db = pg.Pool;
export type Client = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string): Db {
  const needsSsl = /sslmode=require/.test(connectionString);
  return new pg.Pool({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: 10,
  });
}

export async function tx<T>(db: Db, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
