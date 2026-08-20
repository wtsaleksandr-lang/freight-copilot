import { and, desc, eq, inArray, like, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { createDbClient, getPostgresPool } from './client.js';
import { sheetUploads, sheetRates } from './schema.js';
import type { RateSheetResult } from '../llm/parseRateSheet.js';
import type { SheetReplyRow } from '../llm/generateReply.js';
import {
  seedBuckets,
  moveCharge,
  bucketTotals,
  type PaymentBucketName,
  type PaymentBuckets,
  type PaymentBucketTotals,
} from './ratePaymentTerms.js';

export interface SheetUploadRowInput {
  carrierCode: string;
  pol: string;
  polCode?: string | null;
  pod: string;
  podCode?: string | null;
  containerType: string;
  transitDays?: number | null;
  detentionFreetimeDays?: number | null;
  demurrageFreetimeDays?: number | null;
  freightTotal: number;
  freightCurrency: string;
  freightCharges: Array<{ name: string; amount: number; currency: string }>;
  destinationTotal?: number | null;
  destinationCurrency?: string | null;
  destinationCharges: Array<{ name: string; amount: number; currency: string }>;
  validityFrom?: string | null;
  validityTo?: string | null;
  serviceName?: string | null;
  sourceFilename?: string | null;
  sourceUrl?: string | null;
  /** 'buy' (default) | 'sell'. Sell rows are our own quotes (margin included). */
  rateType?: 'buy' | 'sell';
  /** 'file' (default) | 'email_bcc'. */
  sourceType?: 'file' | 'email_bcc';
  /** Free-text remark surfaced in the spreadsheet (e.g. the SELL disclaimer). */
  sourceNote?: string | null;
}

export interface SheetUploadInput {
  refId: string;
  outputFolder: string;
  rows: SheetUploadRowInput[];
  rawResults: unknown;
  markupPct?: number;
  markupFlat?: number;
  documentType?: string | null;
  keptStorageKey?: string | null;
  keptBackend?: string | null;
  /** 'file' (default) | 'email_bcc'. */
  sourceType?: 'file' | 'email_bcc';
  /** RFC-822 Message-ID (email_bcc uploads only) — dedupe key. */
  sourceMessageId?: string | null;
}

/** Build the pre-lowered POL/POD search key from its four parts. */
function searchKeyForParts(
  pol: string | null,
  polCode: string | null,
  pod: string | null,
  podCode: string | null
): string {
  return [pol, polCode, pod, podCode]
    .filter((s) => s != null && s !== '')
    .map((s) => String(s).toLowerCase())
    .join(' ');
}

function searchKeyFor(r: SheetUploadRowInput): string {
  return searchKeyForParts(r.pol, r.polCode ?? null, r.pod, r.podCode ?? null);
}

/** Insert a new sheet_uploads row + its sheet_rates children. */
export async function saveSheetUpload(
  input: SheetUploadInput
): Promise<number> {
  // The additive sell/source columns are self-healed lazily; ensure they exist
  // before an insert that references them (email_bcc uploads always do).
  await ensureSheetUploadColumns();
  await ensureSheetRateColumns();
  const db = createDbClient();
  const [upload] = await db
    .insert(sheetUploads)
    .values({
      refId: input.refId,
      outputFolder: input.outputFolder,
      markupPct: input.markupPct ?? 0,
      markupFlat: input.markupFlat ?? 0,
      addExportDeclaration: false,
      exportDeclarationFee: 0,
      rawResultsJson: input.rawResults,
      documentType: input.documentType ?? null,
      keptStorageKey: input.keptStorageKey ?? null,
      keptBackend: input.keptBackend ?? null,
      sourceType: input.sourceType ?? 'file',
      sourceMessageId: input.sourceMessageId ?? null,
    })
    .returning({ id: sheetUploads.id });
  if (!upload) throw new Error('Failed to insert sheet_uploads row');
  if (input.rows.length > 0) {
    await db.insert(sheetRates).values(
      input.rows.map((r) => ({
        uploadId: upload.id,
        rateType: r.rateType ?? 'buy',
        sourceType: r.sourceType ?? 'file',
        sourceNote: r.sourceNote ?? null,
        carrierCode: r.carrierCode,
        pol: r.pol,
        polCode: r.polCode ?? null,
        pod: r.pod,
        podCode: r.podCode ?? null,
        containerType: r.containerType,
        transitDays: r.transitDays ?? null,
        detentionFreetimeDays: r.detentionFreetimeDays ?? null,
        demurrageFreetimeDays: r.demurrageFreetimeDays ?? null,
        freightTotal: r.freightTotal,
        freightCurrency: r.freightCurrency,
        freightCharges: r.freightCharges,
        destinationTotal: r.destinationTotal ?? null,
        destinationCurrency: r.destinationCurrency ?? null,
        destinationCharges: r.destinationCharges,
        validityFrom: r.validityFrom ?? null,
        validityTo: r.validityTo ?? null,
        serviceName: r.serviceName ?? null,
        sourceFilename: r.sourceFilename ?? null,
        sourceUrl: r.sourceUrl ?? null,
        searchKey: searchKeyFor(r),
      }))
    );
  }
  return upload.id;
}

/**
 * Update the saved email + markup for an upload. Called by /api/sheets/reply
 * so the most recent generated email survives across page reloads.
 */
export async function updateSheetUploadEmail(
  refId: string,
  patch: {
    generatedEmail?: string;
    markupPct?: number;
    markupFlat?: number;
    addExportDeclaration?: boolean;
    exportDeclarationFee?: number;
  }
): Promise<void> {
  const db = createDbClient();
  await db
    .update(sheetUploads)
    .set({
      ...(patch.generatedEmail !== undefined && {
        generatedEmail: patch.generatedEmail,
      }),
      ...(patch.markupPct !== undefined && { markupPct: patch.markupPct }),
      ...(patch.markupFlat !== undefined && { markupFlat: patch.markupFlat }),
      ...(patch.addExportDeclaration !== undefined && {
        addExportDeclaration: patch.addExportDeclaration,
      }),
      ...(patch.exportDeclarationFee !== undefined && {
        exportDeclarationFee: patch.exportDeclarationFee,
      }),
    })
    .where(eq(sheetUploads.refId, refId));
}

/**
 * Delete one sheet upload AND all of its saved rate rows. The child rates are
 * removed first, then the parent upload — the FK is ON DELETE CASCADE, but we
 * delete both explicitly so the behaviour is identical on any database and the
 * intent is obvious. Returns true when an upload row was actually removed.
 * Mirrors {@link deleteShipment} in shipmentBoard.ts.
 */
export async function deleteSheetUpload(refId: string): Promise<boolean> {
  const db = createDbClient();
  const [u] = await db
    .select({ id: sheetUploads.id })
    .from(sheetUploads)
    .where(eq(sheetUploads.refId, refId));
  if (!u) return false;
  await db.delete(sheetRates).where(eq(sheetRates.uploadId, u.id));
  const result = await db
    .delete(sheetUploads)
    .where(eq(sheetUploads.id, u.id));
  const r = result as unknown as {
    rowCount?: number | null;
    rowsAffected?: number;
  };
  const ra = r.rowCount ?? r.rowsAffected ?? 0;
  return ra > 0;
}

// ── Manual + AI correction of parsed rate rows ───────────────────────────────
// A saved upload owns many rate rows (one per lane × container). Corrections
// arrive in two shapes: targeted per-rate edits (inline cell edit, keyed by the
// rate's id) and field-level replacements across the upload (the plain-English
// AI-correction path — e.g. "POD should be Rotterdam not Antwerp" updates every
// rate whose POD currently reads Antwerp). Field types mirror the parseRateSheet
// zod primitives (string names/codes/currency, numeric freight_total).

/** One targeted edit to a single saved rate row (inline cell edit). */
const RatePatchSchema = z.object({
  id: z.number().int().positive(),
  carrierCode: z.string().trim().min(1).optional(),
  pol: z.string().trim().min(1).optional(),
  polCode: z.string().trim().nullable().optional(),
  pod: z.string().trim().min(1).optional(),
  podCode: z.string().trim().nullable().optional(),
  containerType: z.string().trim().min(1).optional(),
  freightTotal: z.number().finite().optional(),
  freightCurrency: z.string().trim().min(1).optional(),
  validityFrom: z.string().trim().nullable().optional(),
  validityTo: z.string().trim().nullable().optional(),
});

/**
 * One field-level replacement applied across the upload's rates. When `from`
 * is given only rates whose current value equals it (case-insensitive) are
 * changed; otherwise every rate in the upload is updated. Money (freightTotal)
 * is deliberately excluded — it is per-rate and only editable via `rates`.
 */
const FieldReplacementSchema = z.object({
  field: z.enum([
    'carrierCode',
    'pol',
    'polCode',
    'pod',
    'podCode',
    'containerType',
    'freightCurrency',
    'validityFrom',
    'validityTo',
  ]),
  to: z.union([z.string(), z.null()]),
  from: z.string().optional(),
});

export const SheetUploadPatchSchema = z
  .object({
    rates: z.array(RatePatchSchema).optional(),
    apply: z.array(FieldReplacementSchema).optional(),
  })
  .refine((p) => (p.rates?.length ?? 0) + (p.apply?.length ?? 0) > 0, {
    message: 'No edits supplied.',
  });
export type SheetUploadPatch = z.infer<typeof SheetUploadPatchSchema>;

const RATE_PATCH_FIELDS = [
  'carrierCode',
  'pol',
  'polCode',
  'pod',
  'podCode',
  'containerType',
  'freightTotal',
  'freightCurrency',
  'validityFrom',
  'validityTo',
] as const;
const LANE_FIELDS = new Set(['pol', 'polCode', 'pod', 'podCode']);

export interface SheetUploadUpdateResult {
  updated: number;
}

/**
 * Apply manual and/or AI corrections to a saved upload's rate rows. Returns the
 * number of rate rows changed, or null when the upload does not exist. Parallels
 * {@link updateSheetUploadEmail} but targets the child rate rows. The pre-lowered
 * `search_key` is recomputed whenever a POL/POD field changes so the spreadsheet
 * filters stay correct. Mirrors the shipments PATCH (updateShipment) in style.
 */
export async function updateSheetUpload(
  refId: string,
  patch: SheetUploadPatch
): Promise<SheetUploadUpdateResult | null> {
  const db = createDbClient();
  const [u] = await db
    .select({ id: sheetUploads.id })
    .from(sheetUploads)
    .where(eq(sheetUploads.refId, refId));
  if (!u) return null;

  // Load the upload's rates once so we can guard ownership and recompute keys.
  const owned = await db
    .select()
    .from(sheetRates)
    .where(eq(sheetRates.uploadId, u.id));
  const byId = new Map(owned.map((r) => [r.id, r]));
  let updated = 0;

  // 1) Targeted per-rate edits (inline cell edit). A rate not belonging to this
  //    upload is silently ignored — never edit another upload's rows.
  for (const rp of patch.rates ?? []) {
    const current = byId.get(rp.id);
    if (!current) continue;
    const set: Record<string, unknown> = {};
    for (const k of RATE_PATCH_FIELDS) {
      if (rp[k] !== undefined) set[k] = rp[k];
    }
    if (Object.keys(set).length === 0) continue;
    if (['pol', 'polCode', 'pod', 'podCode'].some((k) => k in set)) {
      set.searchKey = searchKeyForParts(
        (set.pol as string) ?? current.pol,
        (set.polCode as string | null) ?? current.polCode,
        (set.pod as string) ?? current.pod,
        (set.podCode as string | null) ?? current.podCode
      );
    }
    await db.update(sheetRates).set(set).where(eq(sheetRates.id, rp.id));
    updated++;
  }

  // 2) Field-level replacements across the upload (AI correction / bulk edit).
  for (const rep of patch.apply ?? []) {
    const targets = owned.filter((r) => {
      if (rep.from == null) return true;
      const cur = (r as unknown as Record<string, unknown>)[rep.field];
      return String(cur ?? '').toLowerCase() === rep.from.toLowerCase();
    });
    for (const t of targets) {
      const set: Record<string, unknown> = { [rep.field]: rep.to };
      if (LANE_FIELDS.has(rep.field)) {
        const merged = { ...t, [rep.field]: rep.to } as typeof t;
        set.searchKey = searchKeyForParts(
          merged.pol,
          merged.polCode,
          merged.pod,
          merged.podCode
        );
      }
      await db.update(sheetRates).set(set).where(eq(sheetRates.id, t.id));
      updated++;
    }
  }

  return { updated };
}

/**
 * Current aggregated field values for one upload, used by the AI-correction
 * preview to know what to change (and to disambiguate when a field holds
 * several distinct values across the upload's lanes). Returns null when the
 * upload does not exist.
 */
export interface SheetUploadCurrent {
  refId: string;
  carriers: string[];
  pols: string[];
  pods: string[];
  containerTypes: string[];
  validityFrom: string | null;
  validityTo: string | null;
  rateRowCount: number;
}

export async function getSheetUploadCurrent(
  refId: string
): Promise<SheetUploadCurrent | null> {
  const db = createDbClient();
  const [u] = await db
    .select({ id: sheetUploads.id, refId: sheetUploads.refId })
    .from(sheetUploads)
    .where(eq(sheetUploads.refId, refId));
  if (!u) return null;
  const rows = await db
    .select()
    .from(sheetRates)
    .where(eq(sheetRates.uploadId, u.id));
  const uniq = (xs: Array<string | null>): string[] =>
    Array.from(new Set(xs.filter((s): s is string => !!s)));
  return {
    refId: u.refId,
    carriers: uniq(rows.map((r) => r.carrierCode)),
    pols: uniq(rows.map((r) => r.pol)),
    pods: uniq(rows.map((r) => r.pod)),
    containerTypes: uniq(rows.map((r) => r.containerType)),
    validityFrom: rows.find((r) => r.validityFrom)?.validityFrom ?? null,
    validityTo: rows.find((r) => r.validityTo)?.validityTo ?? null,
    rateRowCount: rows.length,
  };
}

/**
 * Search uploads by free-text query against POL/POD names + codes. Empty
 * query returns the most recent uploads. Returns one row per upload with a
 * pre-aggregated summary (lanes + carriers + container types) so the
 * dashboard can render a search-result list quickly.
 */
export interface SheetUploadSummary {
  id: number;
  refId: string;
  createdAt: string;
  generatedEmail: string | null;
  outputFolder: string;
  carriers: string[];
  lanes: string[];
  containerTypes: string[];
  rateRowCount: number;
}

export async function searchSheetUploads(
  rawQuery: string,
  limit = 50
): Promise<SheetUploadSummary[]> {
  const db = createDbClient();
  const query = (rawQuery ?? '').trim().toLowerCase();

  // Get matching upload IDs first so we can aggregate.
  let uploadIds: number[];
  if (query.length === 0) {
    const recent = await db
      .select({ id: sheetUploads.id })
      .from(sheetUploads)
      .orderBy(desc(sheetUploads.createdAt))
      .limit(limit);
    uploadIds = recent.map((r) => r.id);
  } else {
    const pattern = `%${query}%`;
    const matched = await db
      .selectDistinct({ uploadId: sheetRates.uploadId })
      .from(sheetRates)
      .where(or(like(sheetRates.searchKey, pattern)))
      .limit(limit * 2);
    uploadIds = matched.map((m) => m.uploadId);
  }
  if (uploadIds.length === 0) return [];

  const uploads = await db
    .select()
    .from(sheetUploads)
    .orderBy(desc(sheetUploads.createdAt));
  const filtered = uploads.filter((u) => uploadIds.includes(u.id)).slice(0, limit);
  if (filtered.length === 0) return [];

  // Pull all rates for the filtered uploads.
  const allRates = await db.select().from(sheetRates);
  const ratesByUpload = new Map<number, typeof allRates>();
  for (const r of allRates) {
    const list = ratesByUpload.get(r.uploadId);
    if (list) list.push(r);
    else ratesByUpload.set(r.uploadId, [r]);
  }

  return filtered.map((u) => {
    const rates = ratesByUpload.get(u.id) ?? [];
    const carriers = Array.from(new Set(rates.map((r) => r.carrierCode))).sort();
    const lanes = Array.from(
      new Set(
        rates.map((r) => {
          const polLabel = r.polCode ? `${r.pol} (${r.polCode})` : r.pol;
          const podLabel = r.podCode ? `${r.pod} (${r.podCode})` : r.pod;
          return `${polLabel} → ${podLabel}`;
        })
      )
    );
    const containerTypes = Array.from(
      new Set(rates.map((r) => r.containerType))
    ).sort();
    return {
      id: u.id,
      refId: u.refId,
      createdAt: u.createdAt.toISOString(),
      generatedEmail: u.generatedEmail,
      outputFolder: u.outputFolder,
      carriers,
      lanes,
      containerTypes,
      rateRowCount: rates.length,
    };
  });
}

/**
 * Full payload for a single saved upload, in the same shape the dashboard
 * uses to render fresh parse results — so loading a saved quote and
 * loading a fresh one go through the same render path.
 */
export interface SheetUploadDetail {
  refId: string;
  outputFolder: string;
  createdAt: string;
  generatedEmail: string | null;
  markupPct: number;
  markupFlat: number;
  addExportDeclaration: boolean;
  exportDeclarationFee: number;
  /** The original /api/rates/parse-sheet response — same shape as the live one. */
  results: unknown;
}

export async function getSheetUploadDetail(
  refId: string
): Promise<SheetUploadDetail | null> {
  const db = createDbClient();
  const [u] = await db
    .select()
    .from(sheetUploads)
    .where(eq(sheetUploads.refId, refId));
  if (!u) return null;
  return {
    refId: u.refId,
    outputFolder: u.outputFolder,
    createdAt: u.createdAt.toISOString(),
    generatedEmail: u.generatedEmail,
    markupPct: u.markupPct,
    markupFlat: u.markupFlat,
    addExportDeclaration: u.addExportDeclaration,
    exportDeclarationFee: u.exportDeclarationFee,
    results: u.rawResultsJson,
  };
}

/** Map one free-text container type to a coarse bucket for lane matching. */
function laneContainerBucket(containerType: string): string | null {
  const s = (containerType || '').toLowerCase();
  const is40 = s.includes('40');
  const is20 = s.includes('20');
  const isHi =
    s.includes('hq') ||
    s.includes('hc') ||
    s.includes('high') ||
    s.includes('hi-cube') ||
    s.includes('highcube');
  if (is40 && isHi) return '40HQ';
  if (is40) return '40GP';
  if (is20) return '20GP';
  return null;
}

/**
 * Find saved rate rows for one lane, mapped to the SheetReplyRow shape the
 * deterministic email generator consumes. Matching is case-insensitive against
 * the pre-lowered `search_key` (which concatenates POL name + POL code + POD
 * name + POD code), so callers can pass either codes (preferred) or names for
 * `pol`/`pod`. When `container` is supplied the result is narrowed to the same
 * container bucket (20GP / 40GP / 40HQ) IF that yields any match; otherwise all
 * lane rows are returned so the user still sees the saved rates. Returns [] when
 * the lane has no saved rates.
 */
export async function findSheetRatesByLane(
  pol: string,
  pod: string,
  container?: string
): Promise<SheetReplyRow[]> {
  const origin = (pol ?? '').trim().toLowerCase();
  const dest = (pod ?? '').trim().toLowerCase();
  if (!origin || !dest) return [];

  const db = createDbClient();
  const found = await db
    .select()
    .from(sheetRates)
    .where(
      and(
        like(sheetRates.searchKey, `%${origin}%`),
        like(sheetRates.searchKey, `%${dest}%`)
      )
    );
  if (found.length === 0) return [];

  // Optional container narrowing — only if it keeps at least one row.
  let rows = found;
  const wantBucket = container ? laneContainerBucket(container) : null;
  if (wantBucket) {
    const narrowed = found.filter(
      (r) => laneContainerBucket(r.containerType) === wantBucket
    );
    if (narrowed.length > 0) rows = narrowed;
  }

  return rows.map(
    (r): SheetReplyRow => ({
      carrier: r.carrierCode,
      pol: r.pol,
      polCode: r.polCode,
      pod: r.pod,
      podCode: r.podCode,
      containerType: r.containerType,
      transitDays: r.transitDays,
      detentionFreetimeDays: r.detentionFreetimeDays,
      demurrageFreetimeDays: r.demurrageFreetimeDays,
      freightTotal: r.freightTotal,
      freightCurrency: r.freightCurrency,
      freightCharges: r.freightCharges ?? [],
      destinationTotal: r.destinationTotal,
      destinationCurrency: r.destinationCurrency,
      destinationCharges: r.destinationCharges ?? [],
      validityFrom: r.validityFrom,
      validityTo: r.validityTo,
      serviceName: r.serviceName,
    })
  );
}

/**
 * One flat "past quote" row for the filterable spreadsheet: every saved
 * lane × container rate, joined to its parent upload for the upload date +
 * source ref. This is the row shape the Past-quotes table renders and the
 * user filters by POL/POD, container type and ocean carrier.
 */
export interface SheetRateSpreadsheetRow {
  id: number;
  refId: string;
  carrierCode: string;
  pol: string;
  polCode: string | null;
  pod: string;
  podCode: string | null;
  containerType: string;
  transitDays: number | null;
  validityFrom: string | null;
  validityTo: string | null;
  freightTotal: number;
  freightCurrency: string;
  serviceName: string | null;
  sourceUrl: string | null;
  sourceFilename: string | null;
  /** 'buy' (default) | 'sell'. Drives the SELL badge in the spreadsheet. */
  rateType: string;
  /** Optional remark surfaced next to sell rows (the SELL disclaimer). */
  sourceNote: string | null;
  /** Parent upload's server timestamp (ISO) — when the file was dropped. */
  uploadedAt: string;
}

export interface SheetRatesQuery {
  /** Free-text POL/POD match against the pre-lowered search_key. */
  q?: string;
  /** Exact ocean-carrier code (single value — back-compat, e.g. MSK / MSC). */
  carrier?: string;
  /** Exact container type (single value — back-compat, e.g. 40HC / 20GP). */
  container?: string;
  /**
   * Excel-style multi-select filters. Within one list the match is OR (any of
   * the checked values); across the four lists it is AND. Empty/absent list ⇒
   * that column is unfiltered. `carriers`/`containers` are merged with the
   * legacy single `carrier`/`container` above.
   */
  carriers?: string[];
  containers?: string[];
  pols?: string[];
  pods?: string[];
  limit?: number;
}

export interface SheetRatesResult {
  rows: SheetRateSpreadsheetRow[];
  /** Distinct carrier codes across ALL saved rates (for the filter dropdown). */
  carriers: string[];
  /** Distinct container types across ALL saved rates (for the filter dropdown). */
  containerTypes: string[];
  /** Distinct POL names across ALL saved rates (for the POL header filter). */
  pols: string[];
  /** Distinct POD names across ALL saved rates (for the POD header filter). */
  pods: string[];
}

/**
 * Parse the raw `/api/sheets/rates` query params into a normalized
 * {@link SheetRatesQuery}. Each of carrier/container/pol/pod may arrive as a
 * comma-separated list (Excel multi-select); values are trimmed, empties
 * dropped and duplicates removed while preserving first-seen order. Pure — no
 * I/O — so the multi-value semantics can be unit-tested without a database.
 */
export function parseSheetRatesParams(raw: {
  q?: unknown;
  carrier?: unknown;
  container?: unknown;
  pol?: unknown;
  pod?: unknown;
  limit?: unknown;
}): SheetRatesQuery {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const list = (v: unknown): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of str(v).split(',')) {
      const t = part.trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
    return out;
  };
  const q: SheetRatesQuery = { q: str(raw.q).trim() };
  const carriers = list(raw.carrier);
  const containers = list(raw.container);
  const pols = list(raw.pol);
  const pods = list(raw.pod);
  if (carriers.length) q.carriers = carriers;
  if (containers.length) q.containers = containers;
  if (pols.length) q.pols = pols;
  if (pods.length) q.pods = pods;
  const lim = Number(raw.limit);
  if (Number.isFinite(lim) && lim > 0) q.limit = Math.floor(lim);
  return q;
}

/**
 * Filterable "spreadsheet of past quotes". Returns one row per saved
 * lane × container rate (joined to its upload for the drop date + source),
 * narrowed by any combination of POL/POD text, ocean carrier and container
 * type. Also returns the full distinct carrier + container facets so the UI
 * can populate its filter dropdowns regardless of the current filter.
 */
export async function searchSheetRates(
  query: SheetRatesQuery
): Promise<SheetRatesResult> {
  // Ensure the additive rate_type/source_note columns exist before we SELECT
  // them — a fresh DB that never ran the boot self-heal must not 500 here.
  await ensureSheetRateColumns();
  const db = createDbClient();
  const limit = query.limit && query.limit > 0 ? query.limit : 500;

  const conds: SQL[] = [];
  const q = (query.q ?? '').trim().toLowerCase();
  if (q) conds.push(like(sheetRates.searchKey, `%${q}%`));

  // Multi-select filters: OR within a column (inArray), AND across columns.
  // Merge the legacy single carrier/container into the multi-value lists.
  const uniq = (xs: string[]): string[] =>
    Array.from(new Set(xs.map((x) => x.trim()).filter(Boolean)));
  const carriers = uniq([
    ...(query.carrier ? [query.carrier] : []),
    ...(query.carriers ?? []),
  ]);
  if (carriers.length) conds.push(inArray(sheetRates.carrierCode, carriers));
  const containers = uniq([
    ...(query.container ? [query.container] : []),
    ...(query.containers ?? []),
  ]);
  if (containers.length)
    conds.push(inArray(sheetRates.containerType, containers));
  const pols = uniq(query.pols ?? []);
  if (pols.length) conds.push(inArray(sheetRates.pol, pols));
  const pods = uniq(query.pods ?? []);
  if (pods.length) conds.push(inArray(sheetRates.pod, pods));

  const base = db
    .select({
      id: sheetRates.id,
      refId: sheetUploads.refId,
      carrierCode: sheetRates.carrierCode,
      pol: sheetRates.pol,
      polCode: sheetRates.polCode,
      pod: sheetRates.pod,
      podCode: sheetRates.podCode,
      containerType: sheetRates.containerType,
      transitDays: sheetRates.transitDays,
      validityFrom: sheetRates.validityFrom,
      validityTo: sheetRates.validityTo,
      freightTotal: sheetRates.freightTotal,
      freightCurrency: sheetRates.freightCurrency,
      serviceName: sheetRates.serviceName,
      sourceUrl: sheetRates.sourceUrl,
      sourceFilename: sheetRates.sourceFilename,
      rateType: sheetRates.rateType,
      sourceNote: sheetRates.sourceNote,
      createdAt: sheetUploads.createdAt,
    })
    .from(sheetRates)
    .innerJoin(sheetUploads, eq(sheetRates.uploadId, sheetUploads.id));

  const found = await base
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(sheetUploads.createdAt), desc(sheetRates.id))
    .limit(limit);

  // Facets: distinct carriers + container types across ALL saved rates,
  // so the dropdowns stay fully populated even under a narrow filter.
  const carrierRows = await db
    .selectDistinct({ v: sheetRates.carrierCode })
    .from(sheetRates);
  const containerRows = await db
    .selectDistinct({ v: sheetRates.containerType })
    .from(sheetRates);
  const polRows = await db
    .selectDistinct({ v: sheetRates.pol })
    .from(sheetRates);
  const podRows = await db
    .selectDistinct({ v: sheetRates.pod })
    .from(sheetRates);
  const distinct = (
    rows: Array<{ v: string | null }>
  ): string[] =>
    rows
      .map((r) => r.v)
      .filter((v): v is string => !!v)
      .sort((a, b) => a.localeCompare(b));

  return {
    rows: found.map((r) => ({
      id: r.id,
      refId: r.refId,
      carrierCode: r.carrierCode,
      pol: r.pol,
      polCode: r.polCode,
      pod: r.pod,
      podCode: r.podCode,
      containerType: r.containerType,
      transitDays: r.transitDays,
      validityFrom: r.validityFrom,
      validityTo: r.validityTo,
      freightTotal: r.freightTotal,
      freightCurrency: r.freightCurrency,
      serviceName: r.serviceName,
      sourceUrl: r.sourceUrl,
      sourceFilename: r.sourceFilename,
      rateType: r.rateType ?? 'buy',
      sourceNote: r.sourceNote ?? null,
      uploadedAt: r.createdAt.toISOString(),
    })),
    carriers: distinct(carrierRows),
    containerTypes: distinct(containerRows),
    pols: distinct(polRows),
    pods: distinct(podRows),
  };
}

/**
 * Convert a parsed RateSheetResult into the row-shape that saveSheetUpload
 * expects. Used by the parse-sheet route to flatten lanes × container
 * types into searchable per-rate rows.
 */
export function ratesFromParsedResults(
  files: Array<{
    filename: string;
    parsed: RateSheetResult;
    sourceUrl: string | null;
  }>
): SheetUploadRowInput[] {
  const rows: SheetUploadRowInput[] = [];
  for (const f of files) {
    for (const lane of f.parsed.lanes) {
      for (const r of lane.rates_per_container) {
        rows.push({
          carrierCode: f.parsed.carrier_code || 'UNK',
          pol: lane.origin || '',
          polCode: lane.origin_code ?? null,
          pod: lane.destination || '',
          podCode: lane.destination_code ?? null,
          containerType: r.container_type,
          transitDays: lane.transit_days ?? null,
          detentionFreetimeDays: lane.detention_freetime_days ?? null,
          demurrageFreetimeDays: lane.demurrage_freetime_days ?? null,
          freightTotal: r.freight_total,
          freightCurrency: r.freight_currency,
          freightCharges: (r.freight_charges ?? []).map((c) => ({
            name: c.name,
            amount: c.amount,
            currency: c.currency,
          })),
          destinationTotal: r.destination_total ?? null,
          destinationCurrency: r.destination_currency ?? null,
          destinationCharges: (r.destination_charges ?? []).map((c) => ({
            name: c.name,
            amount: c.amount,
            currency: c.currency,
          })),
          validityFrom: f.parsed.validity_from ?? null,
          validityTo: f.parsed.validity_to ?? null,
          serviceName: lane.service_name ?? null,
          sourceFilename: f.filename,
          sourceUrl: f.sourceUrl,
        });
      }
    }
  }
  return rows;
}

// ── Prepaid / Collect payment-term buckets ───────────────────────────────────
// The rate-library analogue of the shipments Cost/Sell charge-move. See
// src/db/ratePaymentTerms.ts for the pure move + total logic; this layer adds
// the DB self-heal + read/write for the two additive jsonb columns.

/**
 * Self-heal the additive prepaid_charges / collect_charges columns on
 * sheet_rates before the payment-term route reads or writes them. The Replit
 * deploy runs NO migration step, so a fresh Publish would ship code that
 * SELECTs these columns against a table that lacks them. Idempotent
 * (ADD COLUMN IF NOT EXISTS), run-once-per-process (cached promise) and
 * deliberately NON-fatal — a fail-fast boot migration is what takes apps down
 * on deploy. Mirrors ensureShipmentColumns() in shipmentBoard.ts.
 */
let sheetRateColumnsReady: Promise<void> | null = null;
export function ensureSheetRateColumns(): Promise<void> {
  if (sheetRateColumnsReady) return sheetRateColumnsReady;
  sheetRateColumnsReady = (async () => {
    const pool = getPostgresPool();
    await pool.query(
      `ALTER TABLE sheet_rates
         ADD COLUMN IF NOT EXISTS prepaid_charges jsonb,
         ADD COLUMN IF NOT EXISTS collect_charges jsonb,
         ADD COLUMN IF NOT EXISTS rate_type text NOT NULL DEFAULT 'buy',
         ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'file',
         ADD COLUMN IF NOT EXISTS source_note text`
    );
  })().catch((error) => {
    sheetRateColumnsReady = null;
    console.error(
      '[db] ensureSheetRateColumns failed — Prepaid/Collect + sell/source columns may be missing until this heals:',
      error
    );
  });
  return sheetRateColumnsReady;
}

/**
 * Self-heal the additive source_type / source_message_id columns on
 * sheet_uploads. Same additive, Replit-publish-safe pattern as
 * {@link ensureSheetRateColumns}: idempotent (ADD COLUMN IF NOT EXISTS),
 * run-once-per-process, non-fatal. Declared in schema.ts too so drizzle-kit
 * never proposes a DROP. Enables the BCC-email ingest to tag synthetic uploads
 * and dedupe on the email Message-ID.
 */
let sheetUploadColumnsReady: Promise<void> | null = null;
export function ensureSheetUploadColumns(): Promise<void> {
  if (sheetUploadColumnsReady) return sheetUploadColumnsReady;
  sheetUploadColumnsReady = (async () => {
    const pool = getPostgresPool();
    await pool.query(
      `ALTER TABLE sheet_uploads
         ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'file',
         ADD COLUMN IF NOT EXISTS source_message_id text`
    );
  })().catch((error) => {
    sheetUploadColumnsReady = null;
    console.error(
      '[db] ensureSheetUploadColumns failed — source_type/source_message_id may be missing until this heals:',
      error
    );
  });
  return sheetUploadColumnsReady;
}

/**
 * Look up a saved upload by its ingested email Message-ID. Used by the
 * BCC-email ingest to skip a re-delivered copy of the same quote. Returns the
 * upload id + refId when one exists, else null. Best-effort: self-heals the
 * column first so a fresh database never throws "column does not exist".
 */
export async function findSheetUploadByMessageId(
  messageId: string
): Promise<{ id: number; refId: string } | null> {
  const key = (messageId ?? '').trim();
  if (!key) return null;
  await ensureSheetUploadColumns();
  const db = createDbClient();
  const [row] = await db
    .select({ id: sheetUploads.id, refId: sheetUploads.refId })
    .from(sheetUploads)
    .where(eq(sheetUploads.sourceMessageId, key))
    .limit(1);
  return row ?? null;
}

export interface RatePaymentTerms extends PaymentBuckets, PaymentBucketTotals {
  id: number;
  refId: string;
}

/**
 * Build the response payload for one rate row: its resolved Prepaid/Collect
 * buckets (seeded from freight/destination charges on first touch) plus each
 * bucket's recomputed total. Returns null when the rate does not exist.
 */
export async function getRatePaymentTerms(
  id: number
): Promise<RatePaymentTerms | null> {
  await ensureSheetRateColumns();
  const db = createDbClient();
  const [row] = await db
    .select({
      id: sheetRates.id,
      refId: sheetUploads.refId,
      freightCharges: sheetRates.freightCharges,
      destinationCharges: sheetRates.destinationCharges,
      prepaidCharges: sheetRates.prepaidCharges,
      collectCharges: sheetRates.collectCharges,
    })
    .from(sheetRates)
    .innerJoin(sheetUploads, eq(sheetRates.uploadId, sheetUploads.id))
    .where(eq(sheetRates.id, id));
  if (!row) return null;
  const buckets = seedBuckets({
    freightCharges: row.freightCharges,
    destinationCharges: row.destinationCharges,
    prepaidStored: row.prepaidCharges,
    collectStored: row.collectCharges,
  });
  return { id: row.id, refId: row.refId, ...buckets, ...bucketTotals(buckets) };
}

/**
 * Move one charge line from the `from` bucket into the other, persist BOTH
 * columns as the exact new arrays, and return the refreshed buckets + totals.
 * Returns null when the rate does not exist; throws 'invalid index' (caught by
 * the route → 400) when the index is out of range. Mirrors the shipments
 * op:'transfer' write, which persists both breakdown columns in one update.
 */
export async function moveRateChargeTerm(
  id: number,
  from: PaymentBucketName,
  index: number
): Promise<RatePaymentTerms | null> {
  await ensureSheetRateColumns();
  const db = createDbClient();
  const [row] = await db
    .select({
      id: sheetRates.id,
      refId: sheetUploads.refId,
      freightCharges: sheetRates.freightCharges,
      destinationCharges: sheetRates.destinationCharges,
      prepaidCharges: sheetRates.prepaidCharges,
      collectCharges: sheetRates.collectCharges,
    })
    .from(sheetRates)
    .innerJoin(sheetUploads, eq(sheetRates.uploadId, sheetUploads.id))
    .where(eq(sheetRates.id, id));
  if (!row) return null;
  const current = seedBuckets({
    freightCharges: row.freightCharges,
    destinationCharges: row.destinationCharges,
    prepaidStored: row.prepaidCharges,
    collectStored: row.collectCharges,
  });
  const next = moveCharge(current, from, index);
  // Persist BOTH buckets explicitly (never null) so the seed becomes durable
  // and subsequent reads are authoritative rather than re-derived.
  await db
    .update(sheetRates)
    .set({ prepaidCharges: next.prepaid, collectCharges: next.collect })
    .where(eq(sheetRates.id, id));
  return { id: row.id, refId: row.refId, ...next, ...bucketTotals(next) };
}
