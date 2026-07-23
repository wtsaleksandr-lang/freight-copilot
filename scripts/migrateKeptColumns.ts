/**
 * Idempotent additive migration for the kept-file storage optimization.
 * Adds document_type / kept_storage_key / kept_backend to sheet_uploads.
 * Safe to run repeatedly (ADD COLUMN IF NOT EXISTS) and on prod.
 *
 *   pnpm tsx scripts/migrateKeptColumns.ts
 */
import { getPostgresPool, closeDbPool } from '../src/db/client.js';

async function main(): Promise<void> {
  const pool = getPostgresPool();
  const statements = [
    'ALTER TABLE sheet_uploads ADD COLUMN IF NOT EXISTS document_type text',
    'ALTER TABLE sheet_uploads ADD COLUMN IF NOT EXISTS kept_storage_key text',
    'ALTER TABLE sheet_uploads ADD COLUMN IF NOT EXISTS kept_backend text',
  ];
  for (const sql of statements) {
    await pool.query(sql);
    console.log('applied:', sql);
  }
  await closeDbPool();
  console.log('kept-columns migration complete');
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
