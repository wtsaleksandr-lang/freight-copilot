#!/usr/bin/env tsx
/**
 * Safe secret verification (Objective 15).
 *
 * Prints ONLY: provider name, storage source, status, updated timestamp, and the
 * ENCRYPTED length. It never prints, returns, or logs a key value or any part of
 * one. Safe to run in a shared terminal.
 *
 * Usage (on Replit, where DATABASE_URL + SECRETS_MASTER_KEY are set):
 *   pnpm tsx scripts/verifySecrets.ts
 */
import { getProviderStatuses, AI_PROVIDERS } from '../src/server/apiKeysService.js';
import { describeMasterKey } from '../src/server/secretsCrypto.js';
import { getDatabaseDiagnostics } from '../src/server/dbDiagnostics.js';
import { createDbClient, closeDbPool } from '../src/db/client.js';
import { apiKeys } from '../src/db/schema.js';

const STATE_LABEL: Record<string, string> = {
  stored_usable: 'stored & decryptable',
  env_fallback: 'environment fallback',
  stored_locked: 'stored but LOCKED',
  missing: 'missing',
};

async function main(): Promise<void> {
  // Encrypted lengths only — the ciphertext blob length, never the plaintext.
  const encryptedLength = new Map<string, number>();
  try {
    const db = createDbClient();
    const rows = await db.select().from(apiKeys);
    for (const row of rows) encryptedLength.set(row.provider, row.keyEncrypted.length);
  } catch {
    /* db unavailable — lengths omitted */
  }

  const [statuses, diagnostics] = await Promise.all([
    getProviderStatuses(),
    getDatabaseDiagnostics(),
  ]);
  const masterKey = describeMasterKey();

  console.log('=== SECRETS_MASTER_KEY ===');
  console.log(`configured: ${masterKey.configured} | source: ${masterKey.source} | production-safe: ${masterKey.productionSafe}`);
  console.log('(SESSION_SECRET is unrelated and not inspected here.)\n');

  console.log('=== Database ===');
  console.log(`connected: ${diagnostics.connected} | host category: ${diagnostics.hostCategory} | db name: ${diagnostics.databaseName ?? '(none)'} | fingerprint: ${diagnostics.fingerprint ?? '(n/a)'}`);
  console.log(`api_keys table exists: ${diagnostics.apiKeysTableExists} | database changed since init: ${diagnostics.databaseChanged}`);
  const counts = Object.entries(diagnostics.tableCounts).map(([t, n]) => `${t}=${n ?? 'missing'}`).join(', ');
  console.log(`row counts: ${counts}\n`);

  console.log('=== AI provider keys (NO VALUES) ===');
  console.log('provider   | source              | status                | updated              | enc.len');
  console.log('-----------+---------------------+-----------------------+----------------------+--------');
  for (const provider of AI_PROVIDERS) {
    const s = statuses.find((x) => x.provider === provider)!;
    const source = s.storedRow ? (s.hasEnv ? 'vault (+env)' : 'vault') : s.hasEnv ? 'environment' : '—';
    const updated = s.updatedAt ? s.updatedAt.slice(0, 19).replace('T', ' ') : '—';
    const encLen = encryptedLength.get(provider) ?? (s.storedRow ? '?' : '—');
    console.log(
      `${provider.padEnd(10)} | ${source.padEnd(19)} | ${(STATE_LABEL[s.state] ?? s.state).padEnd(21)} | ${String(updated).padEnd(20)} | ${encLen}`,
    );
  }
  console.log('\nNo key values were read or printed.');
}

main()
  .catch((err) => {
    console.error('verify failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
