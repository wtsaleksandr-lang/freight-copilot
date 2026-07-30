import { desc, eq, like, or, sql } from 'drizzle-orm';
import { createDbClient, getPostgresPool } from './client.js';
import { shipments } from './schema.js';
import { backfillStatusesSql, collapseMultiStatusSql } from './shipmentStatus.js';
import { recordShipmentCompanies } from './companies.js';

export type ShipmentRow = typeof shipments.$inferSelect;
export type NewShipment = typeof shipments.$inferInsert;

/**
 * Self-heal the additive FPOD columns (fpod / fpod_code) before the board
 * reads or writes them. The Replit deploy runs NO migration step (just
 * `pnpm install` + `tsx src/index.ts serve`), so a fresh Publish would ship
 * code that SELECTs/INSERTs `fpod` against a table that lacks the column —
 * 500-ing the whole shipment board. This creates the columns lazily on first
 * use, mirroring `ensureShipmentOperationTables()` in shipmentOperations.ts.
 *
 * Idempotent (ADD COLUMN IF NOT EXISTS), run-once-per-process (cached promise),
 * and deliberately NON-fatal: a fail-fast boot migration is exactly what takes
 * apps down on deploy, so a failure here logs loudly and lets the caller
 * proceed. On failure the cache is cleared so the next request retries the heal.
 */
let columnsReady: Promise<void> | null = null;
export function ensureShipmentColumns(): Promise<void> {
  if (columnsReady) return columnsReady;
  columnsReady = (async () => {
    const pool = getPostgresPool();
    await pool.query('ALTER TABLE shipments ADD COLUMN IF NOT EXISTS fpod text');
    await pool.query('ALTER TABLE shipments ADD COLUMN IF NOT EXISTS fpod_code text');
    // MULTI-STATUS: add the jsonb array column, then idempotently backfill it
    // from the legacy scalar `operational_status` (mapping legacy values to the
    // canonical set). Only untouched rows (null / '[]') that carry a non-empty
    // scalar are seeded, so this is safe to re-run every boot. A fresh Publish
    // heals + backfills automatically — no manual migration, no 500.
    await pool.query(
      "ALTER TABLE shipments ADD COLUMN IF NOT EXISTS operational_statuses jsonb DEFAULT '[]'::jsonb"
    );
    // STATUS ITEMS: additive jsonb column holding the AI's compact milestone
    // checklist (done/pending/na per key shipment task). Same self-heal pattern
    // as operational_statuses — a fresh Publish creates it lazily, no migration.
    await pool.query(
      "ALTER TABLE shipments ADD COLUMN IF NOT EXISTS status_items jsonb DEFAULT '[]'::jsonb"
    );
    // OPERATIONAL TRACKING columns (cut-off / SI / VGM / ETD / ETA / trucker / …).
    // Additive text columns the AI now populates and the grid renders. Self-heal
    // on boot like the others so a fresh Publish never 500s the board on a missing
    // column (they were declared in schema.ts but not self-healed).
    await pool.query(
      `ALTER TABLE shipments
         ADD COLUMN IF NOT EXISTS cut_off_date text,
         ADD COLUMN IF NOT EXISTS si_date text,
         ADD COLUMN IF NOT EXISTS sea_air_cargo text,
         ADD COLUMN IF NOT EXISTS vgm text,
         ADD COLUMN IF NOT EXISTS draft_date text,
         ADD COLUMN IF NOT EXISTS loading_date text,
         ADD COLUMN IF NOT EXISTS trucker text,
         ADD COLUMN IF NOT EXISTS etd text,
         ADD COLUMN IF NOT EXISTS eta text,
         ADD COLUMN IF NOT EXISTS bol_type text,
         ADD COLUMN IF NOT EXISTS quote_ref text,
         ADD COLUMN IF NOT EXISTS aes text,
         ADD COLUMN IF NOT EXISTS customs_cutoff_date text`
    );
    await pool.query(backfillStatusesSql());
    // Collapse any legacy multi-status rows to a single furthest-along status
    // so the row tint and the status icon always agree (no booking icon on a
    // loaded-green row). Idempotent — only rows needing it are touched.
    await pool.query(collapseMultiStatusSql());
  })().catch((error) => {
    // Never rethrow — must not crash boot or a request. Reset so a later
    // call can retry the heal (e.g. after a transient DB blip).
    columnsReady = null;
    console.error(
      '[db] ensureShipmentColumns failed — shipment board may be missing fpod/fpod_code columns until this heals:',
      error
    );
  });
  return columnsReady;
}

/**
 * Draft placeholder ref for a manually-added blank row. LoadMode NEVER mints
 * real ref numbers — a shipment's ref belongs to the company's own numbering
 * system (S00043252, …). It comes from the import (the sheet's File# column)
 * or is typed/edited inline by the user; a blank row starts with this obvious
 * placeholder so the user can immediately replace it with the real number.
 */
function draftRef(): string {
  return 'DRAFT-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

export async function listShipments(
  query?: string
): Promise<ShipmentRow[]> {
  await ensureShipmentColumns();
  const db = createDbClient();
  if (!query) {
    return db.select().from(shipments).orderBy(desc(shipments.createdAt));
  }
  const q = `%${query.toLowerCase()}%`;
  return db
    .select()
    .from(shipments)
    .where(
      or(
        like(sql`lower(${shipments.refId})`, q),
        like(sql`lower(${shipments.shipperName})`, q),
        like(sql`lower(${shipments.receiverName})`, q),
        like(sql`lower(${shipments.customerName})`, q),
        like(sql`lower(${shipments.pol})`, q),
        like(sql`lower(${shipments.pod})`, q),
        like(sql`lower(${shipments.fpod})`, q),
        like(sql`lower(${shipments.cargoName})`, q),
        like(sql`lower(${shipments.carrierPreference})`, q),
        like(sql`lower(${shipments.bookingRef})`, q),
        like(sql`lower(${shipments.fpol})`, q)
      )
    )
    .orderBy(desc(shipments.createdAt));
}

export async function createShipment(
  patch: Partial<NewShipment>
): Promise<ShipmentRow> {
  await ensureShipmentColumns();
  const db = createDbClient();
  // Never mint a company ref: use the caller-provided ref (import File# / typed),
  // else a clearly-temporary DRAFT placeholder the user edits inline.
  const refId = (patch.refId ?? '').trim() || draftRef();
  const now = new Date();
  const insert: NewShipment = {
    refId,
    createdAt: now,
    updatedAt: now,
    shipperName: patch.shipperName ?? null,
    receiverName: patch.receiverName ?? null,
    customerName: patch.customerName ?? null,
    loadingAddress: patch.loadingAddress ?? null,
    pol: patch.pol ?? null,
    polCode: patch.polCode ?? null,
    pod: patch.pod ?? null,
    podCode: patch.podCode ?? null,
    fpod: patch.fpod ?? null,
    fpodCode: patch.fpodCode ?? null,
    containerType: patch.containerType ?? null,
    containerQuantity: patch.containerQuantity ?? null,
    cargoType: patch.cargoType ?? null,
    cargoName: patch.cargoName ?? null,
    fpol: patch.fpol ?? null,
    fpolCode: patch.fpolCode ?? null,
    soldRate: patch.soldRate ?? null,
    soldCurrency: patch.soldCurrency ?? 'USD',
    soldBreakdownJson: patch.soldBreakdownJson ?? null,
    ourCost: patch.ourCost ?? null,
    ourCostCurrency: patch.ourCostCurrency ?? 'USD',
    costBreakdownJson: patch.costBreakdownJson ?? null,
    carrierPreference: patch.carrierPreference ?? null,
    bookingRef: patch.bookingRef ?? null,
    shipmentType: patch.shipmentType ?? null,
    operationalStatus: patch.operationalStatus ?? null,
    operationalStatuses: patch.operationalStatuses ?? [],
    notes: patch.notes ?? null,
    statusItems: patch.statusItems ?? [],
    cutOffDate: patch.cutOffDate ?? null,
    siDate: patch.siDate ?? null,
    seaAirCargo: patch.seaAirCargo ?? null,
    vgm: patch.vgm ?? null,
    draftDate: patch.draftDate ?? null,
    loadingDate: patch.loadingDate ?? null,
    trucker: patch.trucker ?? null,
    etd: patch.etd ?? null,
    eta: patch.eta ?? null,
    bolType: patch.bolType ?? null,
    quoteRef: patch.quoteRef ?? null,
    aes: patch.aes ?? null,
    customsCutoffDate: patch.customsCutoffDate ?? null,
    artifactsJson: patch.artifactsJson ?? null,
  };
  const [row] = await db.insert(shipments).values(insert).returning();
  if (!row) throw new Error('Insert returned no row');
  return row;
}

const EDITABLE_FIELDS = new Set<keyof ShipmentRow>([
  'shipperName',
  'receiverName',
  'customerName',
  'loadingAddress',
  'pol',
  'polCode',
  'pod',
  'podCode',
  'fpod',
  'fpodCode',
  'containerType',
  'containerQuantity',
  'cargoType',
  'cargoName',
  'fpol',
  'fpolCode',
  'soldRate',
  'soldCurrency',
  'ourCost',
  'ourCostCurrency',
  'carrierPreference',
  'bookingRef',
  'shipmentType',
  'operationalStatus',
  'operationalStatuses',
  'notes',
  'cutOffDate',
  'siDate',
  'seaAirCargo',
  'vgm',
  'draftDate',
  'loadingDate',
  'trucker',
  'etd',
  'eta',
  'bolType',
  'quoteRef',
  'aes',
  'customsCutoffDate',
  // The Created date is user-editable from the board (calendar on double-click).
  // It's a timestamp column (mode:'date'), so the incoming 'YYYY-MM-DD' string
  // is coerced to a Date in updateShipment before it reaches Drizzle.
  'createdAt',
]);

export async function updateShipment(
  refId: string,
  patch: Partial<ShipmentRow>
): Promise<ShipmentRow | null> {
  await ensureShipmentColumns();
  const db = createDbClient();
  const safe: Partial<NewShipment> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (EDITABLE_FIELDS.has(k as keyof ShipmentRow)) {
      // createdAt is a timestamp column — coerce an incoming date string
      // ('YYYY-MM-DD' from the board calendar) to a Date so Drizzle stores it.
      const coerced =
        k === 'createdAt' && typeof v === 'string' && v ? new Date(v) : v;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (safe as any)[k] = coerced;
    }
  }
  if (Object.keys(safe).length === 0) return getShipment(refId);
  safe.updatedAt = new Date();
  const [row] = await db
    .update(shipments)
    .set(safe)
    .where(eq(shipments.refId, refId))
    .returning();
  // Auto-add any changed customer/shipper/receiver name to the company
  // directory. Fire-and-forget + non-fatal — never blocks or 500s the save.
  recordShipmentCompanies(safe as Record<string, unknown>);
  return row ?? null;
}

/**
 * Rename a shipment's ref (the company's S-number). Used by inline editing of
 * the Ref cell and to replace a blank row's DRAFT placeholder. LoadMode does
 * not mint refs, so the user owns this value. Rejects empty / duplicate refs.
 * A ref that already has child rows (ops/follow-ups) can't be renamed here
 * (FK) — surfaced as a clear error rather than a crash.
 */
export async function renameRefId(
  oldRefId: string,
  newRefId: string
): Promise<{ ok: true; row: ShipmentRow } | { ok: false; error: string }> {
  const next = (newRefId ?? '').trim();
  if (!next) return { ok: false, error: 'Ref cannot be empty.' };
  if (next === oldRefId) {
    const row = await getShipment(oldRefId);
    return row ? { ok: true, row } : { ok: false, error: 'Shipment not found.' };
  }
  const existing = await getShipment(next);
  if (existing) return { ok: false, error: `Ref "${next}" already exists.` };
  const db = createDbClient();
  try {
    const [row] = await db
      .update(shipments)
      .set({ refId: next, updatedAt: new Date() })
      .where(eq(shipments.refId, oldRefId))
      .returning();
    return row ? { ok: true, row } : { ok: false, error: 'Shipment not found.' };
  } catch {
    return {
      ok: false,
      error:
        'Cannot change this ref — it already has tracking or follow-up records attached.',
    };
  }
}

/**
 * Pure fill-only patch: keep only keys whose incoming value is present AND
 * whose value on `existing` is empty (null / ''). Optionally gate keys through
 * an `isEditable` predicate. Guarantees a populated cell is NEVER overwritten —
 * this is the core "enrich only the missing cells, don't overwrite" rule, kept
 * pure so it can be unit-tested without a DB.
 */
export function fillOnlyPatch<T extends Record<string, unknown>>(
  existing: T,
  incoming: Partial<T>,
  isEditable?: (key: string) => boolean
): Partial<T> {
  const isEmpty = (v: unknown) => v == null || v === '';
  const patch: Partial<T> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (isEditable && !isEditable(k)) continue;
    if (v == null || v === '') continue; // nothing to contribute
    if (!isEmpty((existing as Record<string, unknown>)[k])) continue; // don't overwrite
    (patch as Record<string, unknown>)[k] = v;
  }
  return patch;
}

/**
 * Fill-only merge: enrich an existing shipment with parsed data WITHOUT
 * clobbering any cell the user (or a prior document) already populated. Only
 * columns that are currently null / empty-string are written; every populated
 * cell is left exactly as-is. Returns the refreshed row (or null if the ref
 * doesn't exist). This is the "add into the existing one, enrich only the
 * missing cells" primitive behind the drop-path dedup/merge flow.
 */
export async function mergeShipmentFillOnly(
  refId: string,
  fields: Partial<ShipmentRow>
): Promise<ShipmentRow | null> {
  const existing = await getShipment(refId);
  if (!existing) return null;
  const patch = fillOnlyPatch(
    existing as unknown as Record<string, unknown>,
    fields as Record<string, unknown>,
    (k) => EDITABLE_FIELDS.has(k as keyof ShipmentRow)
  );
  if (Object.keys(patch).length === 0) return existing;
  return updateShipment(refId, patch as Partial<ShipmentRow>);
}

export async function getShipment(
  refId: string
): Promise<ShipmentRow | null> {
  await ensureShipmentColumns();
  const db = createDbClient();
  const [row] = await db
    .select()
    .from(shipments)
    .where(eq(shipments.refId, refId));
  return row ?? null;
}

/**
 * Columns the shipment-intake MERGE path (mergeFromBriefing) can mutate:
 * fill-only operational fields, appended notes, the milestone checklist, the
 * cost/sold breakdown + totals, and the appended source-file list. The "undo
 * import" revert snapshots exactly these columns BEFORE a merge and restores
 * them verbatim afterwards — nothing is recomputed. Keep this list in sync with
 * mergeFromBriefing.
 */
export const MERGE_MUTABLE_COLUMNS = [
  // Fill-only operational fields (mergeShipmentFillOnly).
  'shipperName',
  'receiverName',
  'customerName',
  'loadingAddress',
  'fpol',
  'fpolCode',
  'pol',
  'polCode',
  'pod',
  'podCode',
  'fpod',
  'fpodCode',
  'containerType',
  'containerQuantity',
  'cargoType',
  'cargoName',
  'carrierPreference',
  'bookingRef',
  'shipmentType',
  // Operational milestone dates + logistics fields. The intake merge writes
  // these two ways: fill-only for the label-ish fields, and NEWER-DOC-WINS
  // overwrite for the cut-off/milestone DATE fields (a revised confirmation
  // must update a changed date). Snapshot them so an "undo import" reverts
  // both a fill AND an overwrite.
  'cutOffDate',
  'siDate',
  'seaAirCargo',
  'vgm',
  'customsCutoffDate',
  'draftDate',
  'loadingDate',
  'trucker',
  'etd',
  'eta',
  'bolType',
  'quoteRef',
  'aes',
  // Appended free-text notes + AI milestone checklist.
  'notes',
  'statusItems',
  // Cost side (breakdown items + total + currency).
  'costBreakdownJson',
  'ourCost',
  'ourCostCurrency',
  // Sold side.
  'soldBreakdownJson',
  'soldRate',
  'soldCurrency',
  // Appended source files.
  'artifactsJson',
] as const satisfies readonly (keyof ShipmentRow)[];

/** Snapshot of the mutable columns captured before an intake merge. */
export type MergePreState = Partial<
  Pick<ShipmentRow, (typeof MERGE_MUTABLE_COLUMNS)[number]>
>;

/**
 * Capture the pre-merge value of every column the intake merge can touch, so a
 * single "undo import" can restore the row exactly. Missing values are stored
 * as null (not omitted) so the restore is a faithful overwrite.
 */
export function snapshotMergePreState(row: ShipmentRow): MergePreState {
  const out: Record<string, unknown> = {};
  for (const col of MERGE_MUTABLE_COLUMNS) {
    out[col] = (row as Record<string, unknown>)[col] ?? null;
  }
  return out as MergePreState;
}

/**
 * Restore a shipment's mutable columns to a previously captured snapshot
 * (the "undo import" for a MERGE). Writes ONLY the snapshotted columns via a
 * direct db.update — this bypasses updateShipment's EDITABLE_FIELDS filter,
 * which excludes the jsonb breakdown/checklist/artifact columns. Recomputes
 * nothing: totals and breakdowns are restored verbatim.
 */
export async function restoreShipmentSnapshot(
  refId: string,
  preState: MergePreState
): Promise<ShipmentRow | null> {
  await ensureShipmentColumns();
  const db = createDbClient();
  const set: Record<string, unknown> = {};
  for (const col of MERGE_MUTABLE_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(preState, col)) {
      set[col] = (preState as Record<string, unknown>)[col] ?? null;
    }
  }
  if (Object.keys(set).length === 0) return getShipment(refId);
  set.updatedAt = new Date();
  const [row] = await db
    .update(shipments)
    .set(set)
    .where(eq(shipments.refId, refId))
    .returning();
  return row ?? null;
}

export async function deleteShipment(refId: string): Promise<boolean> {
  const db = createDbClient();
  const result = await db
    .delete(shipments)
    .where(eq(shipments.refId, refId));
  // node-postgres returns { rowCount }; keep rowsAffected as a fallback so the
  // boolean is truthful on a successful delete (it was always false before).
  const r = result as unknown as { rowCount?: number | null; rowsAffected?: number };
  const ra = r.rowCount ?? r.rowsAffected ?? 0;
  return ra > 0;
}
