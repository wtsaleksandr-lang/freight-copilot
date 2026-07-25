/**
 * Idempotent migration: add ON UPDATE CASCADE to the foreign keys that point
 * shipment_containers / shipment_follow_ups at shipments(ref_id).
 *
 * Without it, once a shipment row has containers or follow-ups its ref_id can
 * never be renamed — which is exactly what every manual DRAFT-xxxx row needs to
 * do when it becomes a real S-number. This discovers the live FK constraint
 * (whatever Postgres auto-named it), drops it, and re-adds it with both
 * ON DELETE CASCADE and ON UPDATE CASCADE. Safe to run repeatedly and on prod.
 *
 *   pnpm tsx scripts/migrateRefIdCascade.ts
 */
import { getPostgresPool, closeDbPool } from '../src/db/client.js';

const TABLES = ['shipment_containers', 'shipment_follow_ups'] as const;

async function main(): Promise<void> {
  const pool = getPostgresPool();
  for (const table of TABLES) {
    // Table may not exist yet on a fresh DB (created lazily at runtime).
    const exists = await pool.query(`SELECT to_regclass($1) AS reg`, [table]);
    if (!exists.rows[0]?.reg) {
      console.log('skip (table absent):', table);
      continue;
    }
    // Find every FK on this table that references shipments, whatever it's named.
    const fks = await pool.query(
      `SELECT conname FROM pg_constraint
         WHERE conrelid = $1::regclass
           AND contype = 'f'
           AND confrelid = 'shipments'::regclass`,
      [table],
    );
    for (const { conname } of fks.rows as Array<{ conname: string }>) {
      await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS "${conname}"`);
      console.log('dropped FK:', table, conname);
    }
    const target = `${table}_shipment_ref_id_fkey`;
    await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS "${target}"`);
    await pool.query(
      `ALTER TABLE ${table}
         ADD CONSTRAINT "${target}"
         FOREIGN KEY (shipment_ref_id) REFERENCES shipments(ref_id)
         ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    console.log('added FK with ON UPDATE CASCADE:', table, target);
  }
  await closeDbPool();
  console.log('ref-id cascade migration complete');
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
