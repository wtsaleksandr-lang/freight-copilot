import { getPostgresPool } from './client.js';

/**
 * Saved company directory. Every distinct customer / shipper / receiver name
 * that has ever appeared on a shipment is recorded here once, so the board's
 * company cells can offer a type-ahead picker of previously-seen companies.
 *
 * Dedupe + search both key off `name_normalized`: the display `name` lowercased
 * with punctuation and whitespace stripped, so "A.P. Moller — Maersk",
 * "AP Moller Maersk" and "apmoller  maersk" all collapse to one row while the
 * first-seen display name is preserved. `roles` tracks which of
 * customer/shipper/receiver the company has appeared as (informational only).
 *
 * The table is declared in schema.ts (so Replit's drizzle-kit push recognizes
 * it and never proposes a DROP) AND self-healed at runtime here via
 * ensureCompaniesTable(), mirroring ensureEmailTemplateTable() /
 * ensureShipmentColumns() — the deploy runs NO migration step.
 */

export type CompanyRole = 'customer' | 'shipper' | 'receiver';

export interface CompanyRow {
  id: number;
  name: string;
}

/** Which shipment field maps to which directory role. */
export const COMPANY_ROLE_BY_FIELD: Record<string, CompanyRole> = {
  customerName: 'customer',
  shipperName: 'shipper',
  receiverName: 'receiver',
};

/**
 * Canonical dedupe/search key: lowercase, strip everything that isn't a letter
 * or digit (spaces, punctuation, dashes, ampersands, unicode separators). Pure
 * and DB-free so it can be unit-tested and reused for both dedupe and search.
 */
export function normalizeCompanyName(name: string): string {
  return (name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    // drop combining marks / accents (U+0300–U+036F)
    .replace(/[̀-ͯ]/g, '')
    // keep only a-z0-9 (this also strips spaces + all punctuation)
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Self-heal on first use — same pattern/guarantees as ensureEmailTemplateTable:
 * idempotent (IF NOT EXISTS), run-once-per-process (cached promise), and
 * NON-fatal (never rethrows, so a DB blip can't 500 boot or a shipment save).
 * On failure the cache clears so a later call retries.
 */
let tableReady: Promise<void> | null = null;
export function ensureCompaniesTable(): Promise<void> {
  if (tableReady) return tableReady;
  tableReady = (async () => {
    const pool = getPostgresPool();
    await pool.query(
      `CREATE TABLE IF NOT EXISTS companies (
         id serial PRIMARY KEY,
         name text NOT NULL,
         name_normalized text UNIQUE,
         roles jsonb DEFAULT '[]'::jsonb,
         created_at timestamptz NOT NULL DEFAULT NOW()
       )`
    );
  })().catch((error) => {
    tableReady = null;
    console.error(
      '[db] ensureCompaniesTable failed — company directory picker will be empty until this heals:',
      error
    );
  });
  return tableReady;
}

/**
 * Idempotent insert of one company keyed by its normalized name. A brand-new
 * name is inserted; a name that already exists is left as-is (its first-seen
 * display `name` is preserved) but its `roles` array gains the new role if
 * missing. Deliberately NON-fatal: any failure is swallowed so it can be called
 * fire-and-forget from the shipment-save path without ever blocking a save.
 * Blank / punctuation-only names are ignored.
 */
export async function upsertCompany(
  name: string,
  role?: CompanyRole | null
): Promise<void> {
  const display = (name ?? '').trim();
  const normalized = normalizeCompanyName(display);
  if (!display || !normalized) return;
  try {
    await ensureCompaniesTable();
    const roleArr = role ? JSON.stringify([role]) : '[]';
    await getPostgresPool().query(
      `INSERT INTO companies (name, name_normalized, roles)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (name_normalized) DO UPDATE
         SET roles = CASE
           WHEN $4::text IS NULL THEN companies.roles
           WHEN companies.roles @> $3::jsonb THEN companies.roles
           ELSE COALESCE(companies.roles, '[]'::jsonb) || $3::jsonb
         END`,
      [display, normalized, roleArr, role ?? null]
    );
  } catch (error) {
    console.error('[db] upsertCompany failed (non-fatal):', error);
  }
}

/**
 * Fire-and-forget: record the customer/shipper/receiver names on a shipment
 * (or patch) into the directory. Reads the three known fields off `fields`,
 * upserts each non-empty one under its role. Never awaited by the caller and
 * never throws — a directory write must not block or fail a shipment save.
 */
export function recordShipmentCompanies(
  fields: Record<string, unknown> | null | undefined
): void {
  if (!fields) return;
  for (const [field, role] of Object.entries(COMPANY_ROLE_BY_FIELD)) {
    const value = fields[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      void upsertCompany(value, role);
    }
  }
}

/**
 * Search the directory. `q` is normalized and matched as a substring against
 * name_normalized; exact-prefix matches sort first, then alphabetical. An empty
 * query returns the most recent companies (up to `limit`). Always returns an
 * array — on any DB error it returns [] so the picker degrades gracefully.
 */
export async function searchCompanies(
  q: string,
  limit = 12
): Promise<CompanyRow[]> {
  const normalized = normalizeCompanyName(q ?? '');
  if (!normalized) return listCompanies(limit);
  try {
    await ensureCompaniesTable();
    const { rows } = await getPostgresPool().query(
      `SELECT id, name FROM companies
        WHERE name_normalized LIKE $1
        ORDER BY (name_normalized LIKE $2) DESC, length(name), name
        LIMIT $3`,
      [`%${normalized}%`, `${normalized}%`, limit]
    );
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id: Number(r.id),
      name: String(r.name),
    }));
  } catch (error) {
    console.error('[db] searchCompanies failed:', error);
    return [];
  }
}

/** Most-recently-added companies (up to `limit`). Empty [] on any DB error. */
export async function listCompanies(limit = 12): Promise<CompanyRow[]> {
  try {
    await ensureCompaniesTable();
    const { rows } = await getPostgresPool().query(
      `SELECT id, name FROM companies ORDER BY created_at DESC, name LIMIT $1`,
      [limit]
    );
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id: Number(r.id),
      name: String(r.name),
    }));
  } catch (error) {
    console.error('[db] listCompanies failed:', error);
    return [];
  }
}
