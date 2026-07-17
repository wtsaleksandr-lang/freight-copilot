import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { loadEnv } from '../config.js';
import * as coreSchema from './schema.js';
import * as shipmentOperationsSchema from './shipmentOperationsSchema.js';

const schema = { ...coreSchema, ...shipmentOperationsSchema };

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

export function createDbClient(): DbClient {
  const env = loadEnv();
  const sql = neon(env.DATABASE_URL);
  return drizzle(sql, { schema });
}
