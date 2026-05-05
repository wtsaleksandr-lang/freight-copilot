import { createDbClient } from './client.js';
import { sql } from 'drizzle-orm';
import { carriers, sessions } from './schema.js';

async function main() {
  const db = createDbClient();

  const tables = await db.execute(
    sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
  );
  console.log('tables:', tables.rows.map((r: any) => r.table_name));

  const carrierRows = await db.select().from(carriers);
  console.log('carriers:', carrierRows);

  const sessionRows = await db
    .select({
      id: sessions.id,
      carrierId: sessions.carrierId,
      lastUsedAt: sessions.lastUsedAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions);
  console.log('sessions (metadata):', sessionRows);

  const firstRaw = await db.select({ storageState: sessions.storageState }).from(sessions).limit(1);
  const firstRow = firstRaw[0];
  if (firstRow) {
    const state = firstRow.storageState as any;
    const cookies = state?.cookies ?? [];
    const origins = state?.origins ?? [];
    const maerskCookies = cookies.filter((c: { domain?: string }) =>
      c.domain?.includes('maersk'),
    );
    console.log('session summary:');
    console.log('  total cookies:', cookies.length);
    console.log('  maersk-domain cookies:', maerskCookies.length);
    console.log('  origins with localStorage:', origins.length);
    console.log(
      '  cookie domains (unique):',
      Array.from(new Set(cookies.map((c: { domain?: string }) => c.domain))).sort(),
    );
  }
}

main();
