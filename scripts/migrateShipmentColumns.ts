/**
 * Idempotent additive migration: the 12 operational-tracking columns added to
 * the shipments board so a company tracking sheet can be imported in full.
 * Safe to run repeatedly and on prod.
 *
 *   pnpm tsx scripts/migrateShipmentColumns.ts
 */
import { getPostgresPool, closeDbPool } from '../src/db/client.js';

const COLUMNS: Array<[string, string]> = [
  ['cut_off_date', 'text'],
  ['si_date', 'text'],
  ['sea_air_cargo', 'text'],
  ['vgm', 'text'],
  ['draft_date', 'text'],
  ['loading_date', 'text'],
  ['trucker', 'text'],
  ['etd', 'text'],
  ['eta', 'text'],
  ['bol_type', 'text'],
  ['quote_ref', 'text'],
  ['aes', 'text'],
];

async function main(): Promise<void> {
  const pool = getPostgresPool();
  for (const [name, type] of COLUMNS) {
    const sql = `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS ${name} ${type}`;
    await pool.query(sql);
    console.log('applied:', sql);
  }
  await closeDbPool();
  console.log('shipment-columns migration complete');
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
