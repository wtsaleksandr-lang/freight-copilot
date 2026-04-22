import { createClient } from '@libsql/client';

async function main() {
  const client = createClient({ url: 'file:./data/freight-copilot.db' });

  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  console.log('tables:', tables.rows.map((r) => r.name));

  const carriers = await client.execute('SELECT * FROM carriers');
  console.log('carriers:', carriers.rows);

  const sessions = await client.execute(
    'SELECT id, carrier_id, last_used_at, expires_at, length(storage_state) AS json_size FROM sessions'
  );
  console.log('sessions (metadata):', sessions.rows);

  // Parse the storage_state JSON and show a summary without leaking values
  const raw = await client.execute('SELECT storage_state FROM sessions LIMIT 1');
  const firstRow = raw.rows[0];
  if (firstRow) {
    const stateStr = firstRow.storage_state as string;
    const state = JSON.parse(stateStr);
    const cookies = state.cookies ?? [];
    const origins = state.origins ?? [];
    const maerskCookies = cookies.filter((c: { domain?: string }) =>
      c.domain?.includes('maersk')
    );
    console.log('session summary:');
    console.log('  total cookies:', cookies.length);
    console.log('  maersk-domain cookies:', maerskCookies.length);
    console.log('  origins with localStorage:', origins.length);
    console.log(
      '  cookie domains (unique):',
      Array.from(new Set(cookies.map((c: { domain?: string }) => c.domain))).sort()
    );
  }
}

main();
