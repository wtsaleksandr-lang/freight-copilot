/**
 * Idempotent additive migration: the FPOD (Final Port of Delivery) columns
 * added to the shipments board. After the ocean discharge port (POD), cargo
 * sometimes moves by on-carriage (truck/rail) to a final inland terminal —
 * the FPOD. `fpod` is the terminal name, `fpod_code` its optional UN/LOCODE
 * (mirrors the pod/pod_code pairing).
 *
 * Safe to run repeatedly (ADD COLUMN IF NOT EXISTS) and on prod.
 *
 *   pnpm tsx scripts/migrateFpodColumns.ts
 */
import { getPostgresPool, closeDbPool } from '../src/db/client.js';

const COLUMNS: Array<[string, string]> = [
  ['fpod', 'text'],
  ['fpod_code', 'text'],
];

async function main(): Promise<void> {
  const pool = getPostgresPool();
  for (const [name, type] of COLUMNS) {
    const sql = `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS ${name} ${type}`;
    await pool.query(sql);
    console.log('applied:', sql);
  }
  await closeDbPool();
  console.log('fpod-columns migration complete');
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
