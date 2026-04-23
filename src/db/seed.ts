import { createDbClient } from './client.js';
import { carriers } from './schema.js';
import { listCarriers } from '../carriers/registry.js';

async function main() {
  const db = createDbClient();

  for (const c of listCarriers()) {
    await db
      .insert(carriers)
      .values({ code: c.code, name: c.name })
      .onConflictDoNothing({ target: carriers.code });
  }

  const all = await db.select().from(carriers);
  console.log('[seed] carriers in DB:');
  for (const row of all) {
    console.log(`  ${row.id.toString().padStart(2)}  ${row.code.padEnd(4)}  ${row.name}`);
  }
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
