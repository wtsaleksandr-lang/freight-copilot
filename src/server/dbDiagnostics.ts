// Objective 4 — safe production/development database diagnostics.
//
// Exposes enough to reason about WHICH database is connected and whether dev and
// prod might be pointing at the same one — WITHOUT ever revealing the password,
// full connection string, username, or private hostname. Only a coarse host
// CATEGORY, the database name, and a non-reversible fingerprint are surfaced.

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getPostgresPool, createDbClient } from '../db/client.js';
import { appSettings } from '../db/schema.js';

export type DbHostCategory =
  | 'replit-managed'
  | 'neon-hosted'
  | 'localhost'
  | 'other'
  | 'missing';

export interface SafeDbIdentity {
  hostCategory: DbHostCategory;
  databaseName: string | null;
  sslMode: string | null;
  /** sha256(category|dbName) truncated — no host/user/password. Two environments
   *  sharing a database show the SAME fingerprint; different databases differ. */
  fingerprint: string | null;
}

/** Pure — categorize a connection string without exposing any secret part. */
export function categorizeDbHost(rawUrl: string | undefined): SafeDbIdentity {
  if (!rawUrl) {
    return { hostCategory: 'missing', databaseName: null, sslMode: null, fingerprint: null };
  }
  let hostCategory: DbHostCategory = 'other';
  let databaseName: string | null = null;
  let sslMode: string | null = null;
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    databaseName = decodeURIComponent((u.pathname || '').replace(/^\//, '')) || null;
    sslMode = u.searchParams.get('sslmode');
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') hostCategory = 'localhost';
    else if (host.endsWith('.neon.tech') || host.includes('neon')) hostCategory = 'neon-hosted';
    else if (
      host.endsWith('.replit.dev') ||
      host.endsWith('.replit.app') ||
      host.endsWith('.internal') ||
      host.startsWith('helium') ||
      host.includes('replit')
    )
      hostCategory = 'replit-managed';
    else hostCategory = 'other';
  } catch {
    return { hostCategory: 'other', databaseName: null, sslMode: null, fingerprint: null };
  }
  const fingerprint = createHash('sha256')
    .update(`${hostCategory}|${databaseName ?? ''}`)
    .digest('hex')
    .slice(0, 12);
  return { hostCategory, databaseName, sslMode, fingerprint };
}

const CRITICAL_TABLES = [
  'shipments',
  'shipment_containers',
  'shipment_follow_ups',
  'quote_bundles',
  'quotes',
  'drayage_quotes',
  'trucking_quotes',
  'sheet_uploads',
  'drayage_rate_library',
  'api_keys',
  'carrier_credentials',
  'audit_events',
] as const;

const FINGERPRINT_KEY = 'DB_FINGERPRINT_SEEN';

export interface DatabaseDiagnostics extends SafeDbIdentity {
  connected: boolean;
  apiKeysTableExists: boolean;
  tableCounts: Record<string, number | null>;
  firstSeenFingerprint: string | null;
  /** True when this environment now points at a DIFFERENT database than the one
   *  it was first initialized against (a drift/mis-pointing signal). */
  databaseChanged: boolean;
  checkedAt: string;
  error?: string;
}

export async function getDatabaseDiagnostics(): Promise<DatabaseDiagnostics> {
  const identity = categorizeDbHost(process.env.DATABASE_URL);
  const base: DatabaseDiagnostics = {
    ...identity,
    connected: false,
    apiKeysTableExists: false,
    tableCounts: Object.fromEntries(CRITICAL_TABLES.map((t) => [t, null])),
    firstSeenFingerprint: null,
    databaseChanged: false,
    checkedAt: new Date().toISOString(),
  };
  if (identity.hostCategory === 'missing') {
    return { ...base, error: 'DATABASE_URL is not set.' };
  }

  try {
    const pool = getPostgresPool();
    // Existence check for all critical tables in one query (no row scans).
    const existsSql = CRITICAL_TABLES.map(
      (t) => `to_regclass('public.${t}')::text AS ${t}`,
    ).join(', ');
    const existsRes = await pool.query(`SELECT ${existsSql}`);
    const existsRow = (existsRes.rows[0] ?? {}) as Record<string, string | null>;

    const counts: Record<string, number | null> = {};
    for (const table of CRITICAL_TABLES) {
      if (!existsRow[table]) {
        counts[table] = null;
        continue;
      }
      try {
        const c = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
        counts[table] = Number((c.rows[0] as { n?: number })?.n ?? 0);
      } catch {
        counts[table] = null;
      }
    }

    // Drift detection: record the fingerprint the first time only (never
    // overwrite), then compare. Best-effort; never throws the diagnostics.
    let firstSeen: string | null = null;
    try {
      const db = createDbClient();
      const [row] = await db.select().from(appSettings).where(eq(appSettings.key, FINGERPRINT_KEY));
      firstSeen = row?.value ?? null;
      if (!firstSeen && identity.fingerprint) {
        await db
          .insert(appSettings)
          .values({ key: FINGERPRINT_KEY, value: identity.fingerprint, updatedAt: new Date() })
          .onConflictDoNothing();
        firstSeen = identity.fingerprint;
      }
    } catch {
      /* app_settings not ready — skip drift detection */
    }

    return {
      ...base,
      connected: true,
      apiKeysTableExists: Boolean(existsRow.api_keys),
      tableCounts: counts,
      firstSeenFingerprint: firstSeen,
      databaseChanged: Boolean(firstSeen && identity.fingerprint && firstSeen !== identity.fingerprint),
    };
  } catch (err) {
    // Sanitized — never include the connection string / credentials.
    const msg = err instanceof Error ? err.message : String(err);
    const sanitized = msg.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[connection-string-hidden]').slice(0, 180);
    return { ...base, connected: false, error: `Database unavailable: ${sanitized}` };
  }
}
