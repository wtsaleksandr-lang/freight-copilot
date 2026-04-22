import { createDbClient } from './client.js';
import { carriers } from './schema.js';

async function main() {
  const db = createDbClient();

  await db
    .insert(carriers)
    .values({ code: 'MSK', name: 'Maersk' })
    .onConflictDoNothing({ target: carriers.code });

  const all = await db.select().from(carriers);
  console.log('[seed] carriers:', all);
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
