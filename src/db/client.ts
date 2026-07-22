import { createRequire } from 'node:module';
import { drizzle } from 'drizzle-orm/node-postgres';
import { loadEnv } from '../config.js';
import * as schema from './schema.js';

type QueryResult = { rows: Array<Record<string, unknown>> };
type PoolLike = {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  on(event: 'error', listener: (error: Error) => void): void;
  end(): Promise<void>;
};
type PoolConstructor = new (options: Record<string, unknown>) => PoolLike;

const requireFromDrizzle = createRequire(import.meta.resolve('drizzle-orm/node-postgres'));
const { Pool } = requireFromDrizzle('pg') as { Pool: PoolConstructor };
let pool: PoolLike | null = null;

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

export function getPostgresPool(): PoolLike {
  if (pool) return pool;
  const env = loadEnv();
  pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: env.DATABASE_URL.includes('sslmode=disable') ? false : undefined,
  });
  pool.on('error', (error: Error) => {
    console.error('[db] idle PostgreSQL client error:', error);
  });
  return pool;
}

export function createDbClient(): DbClient {
  return drizzle(getPostgresPool() as never, { schema });
}

export async function closeDbPool(): Promise<void> {
  if (!pool) return;
  const activePool = pool;
  pool = null;
  await activePool.end();
}
