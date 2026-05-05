import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { loadEnv } from '../config.js';
import * as schema from './schema.js';

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

export function createDbClient(): DbClient {
  const env = loadEnv();
  const client = createClient({ url: `file:${env.DATABASE_FILE}` });
  return drizzle(client, { schema });
}
