import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { loadEnv } from '../config.js';
import * as schema from './schema.js';

const { Pool } = pg;
let pool: pg.Pool | null = null;

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

export function getPostgresPool(): pg.Pool {
  if (pool) return pool;
  const env = loadEnv();
  pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: env.DATABASE_URL.includes('sslmode=disable') ? false : undefined,
  });
  pool.on('error', (error) => {
    console.error('[db] idle PostgreSQL client error:', error);
  });
  return pool;
}

export function createDbClient(): DbClient {
  return drizzle(getPostgresPool(), { schema });
}

export async function closeDbPool(): Promise<void> {
  if (!pool) return;
  const activePool = pool;
  pool = null;
  await activePool.end();
}
