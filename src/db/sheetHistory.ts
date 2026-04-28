import { desc, eq, like, or } from 'drizzle-orm';
import { createDbClient } from './client.js';
import { sheetUploads, sheetRates } from './schema.js';
import type { RateSheetResult } from '../llm/parseRateSheet.js';

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

/**
 * Convert a parsed RateSheetResult into the row-shape that saveSheetUpload
 * expects. Used by the parse-sheet route to flatten lanes × container
 * types into searchable per-rate rows.
 */
export function ratesFromParsedResults(
  files: Array<{
    filename: string;
    parsed: RateSheetResult;
    sourceUrl: string;
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
