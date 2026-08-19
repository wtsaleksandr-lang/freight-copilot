import { and, desc, eq, inArray, like, or, type SQL } from 'drizzle-orm';
import { createDbClient } from './client.js';
import { sheetUploads, sheetRates } from './schema.js';
import type { RateSheetResult } from '../llm/parseRateSheet.js';
import type { SheetReplyRow } from '../llm/generateReply.js';

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
}

function searchKeyFor(r: SheetUploadRowInput): string {
  return [r.pol, r.polCode, r.pod, r.podCode]
    .filter((s) => s != null && s !== '')
    .map((s) => String(s).toLowerCase())
    .join(' ');
}

/** Insert a new sheet_uploads row + its sheet_rates children. */
export async function saveSheetUpload(
  input: SheetUploadInput
): Promise<number> {
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
    })
    .returning({ id: sheetUploads.id });
  if (!upload) throw new Error('Failed to insert sheet_uploads row');
  if (input.rows.length > 0) {
    await db.insert(sheetRates).values(
      input.rows.map((r) => ({
        uploadId: upload.id,
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
