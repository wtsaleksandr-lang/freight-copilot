import { eq } from 'drizzle-orm';
import { createDbClient } from '../db/client.js';
import { shipments } from '../db/schema.js';
import {
  createShipment,
  getShipment,
  mergeShipmentFillOnly,
  updateShipment,
  type ShipmentRow,
} from '../db/shipmentBoard.js';
import {
  detectMediaType,
  isMsgFile,
  type BriefingFile,
  type BriefingMediaType,
  type ShipmentBriefing,
} from '../llm/parseShipmentBriefing.js';
import { convertMsgToEmailText } from '../llm/msgToText.js';
import { recordShipmentCompanies } from '../db/companies.js';
import { toUsd, conversionAnnotation } from './fxRates.js';

/** Raw upload as received from the dashboard. */
export type RawIntakeFile = {
  filename?: string;
  contentBase64: string;
  mediaType?: BriefingMediaType;
};

type MoneyItem = {
  name: string;
  amount: number;
  currency: string;
  sourceFile: string | null;
  addedAt: string;
};

type Artifact = {
  filename: string;
  url: string;
  mediaType: string;
  addedAt: string;
};

/**
 * Resolve raw uploads into the media-typed shape the LLM/file-store use.
 * Mirrors the inline logic in the /api/shipments/parse route (msg decode,
 * text-vs-binary routing) so both the create and merge apply paths — and the
 * /parse-commit endpoint — share one implementation.
 */
export function buildBriefingFiles(files: RawIntakeFile[]): BriefingFile[] {
  return files.map((f) => {
    if (isMsgFile(f.filename)) {
      const buf = Buffer.from(f.contentBase64, 'base64');
      const ab = new ArrayBuffer(buf.byteLength);
      new Uint8Array(ab).set(buf);
      return {
        mediaType: 'text/plain' as BriefingMediaType,
        filename: f.filename,
        textContent: convertMsgToEmailText(ab),
      };
    }
    const inferred = f.mediaType ?? (f.filename ? detectMediaType(f.filename) : null);
    if (!inferred) {
      throw new Error(`Could not detect media type for ${f.filename ?? 'file'}`);
    }
    const isText =
      inferred === 'message/rfc822' ||
      inferred === 'text/html' ||
      inferred === 'text/plain';
    if (isText) {
      return {
        mediaType: inferred,
        filename: f.filename,
        textContent: Buffer.from(f.contentBase64, 'base64').toString('utf8'),
      };
    }
    return { mediaType: inferred, filename: f.filename, fileBase64: f.contentBase64 };
  });
}

/** Non-money operational fields extracted from a briefing. */
export function operationalFieldsFromBriefing(
  briefing: ShipmentBriefing
): Partial<ShipmentRow> {
  return {
    shipperName: briefing.shipper_name ?? null,
    receiverName: briefing.receiver_name ?? null,
    customerName: briefing.customer_name ?? null,
    loadingAddress: briefing.loading_address ?? null,
    fpol: briefing.fpol ?? null,
    fpolCode: briefing.fpol_code ?? null,
    pol: briefing.pol ?? null,
    polCode: briefing.pol_code ?? null,
    pod: briefing.pod ?? null,
    podCode: briefing.pod_code ?? null,
    fpod: briefing.fpod ?? null,
    fpodCode: briefing.fpod_code ?? null,
    containerType: briefing.container_type ?? null,
    containerQuantity: briefing.container_quantity ?? null,
    cargoType: briefing.cargo_type ?? null,
    cargoName: briefing.cargo_name ?? null,
    carrierPreference: briefing.carrier_preference ?? null,
    bookingRef: briefing.booking_ref ?? null,
    shipmentType: briefing.shipment_type ?? null,
    // Operational milestone dates + logistics fields → their grid columns. These
    // were extracted by the parser but only mapped on the drop-onto-existing-row
    // path; adding them here fixes the create-new-shipment + fill-only-merge
    // paths too (both flow through this mapper).
    cutOffDate: briefing.cut_off_date ?? null,
    siDate: briefing.si_date ?? null,
    seaAirCargo: briefing.sea_air_cargo ?? null,
    vgm: briefing.vgm ?? null,
    draftDate: briefing.draft_date ?? null,
    loadingDate: briefing.loading_date ?? null,
    trucker: briefing.trucker ?? null,
    etd: briefing.etd ?? null,
    eta: briefing.eta ?? null,
    bolType: briefing.bol_type ?? null,
    quoteRef: briefing.quote_ref ?? null,
    aes: briefing.aes ?? null,
    customsCutoffDate: briefing.customs_cutoff_date ?? null,
  };
}

/**
 * Operational cut-off / milestone DATE fields where a NEWER document must WIN:
 * carriers re-issue revised booking confirmations, and a later doc's changed
 * cut-off / sailing date has to update the row rather than be silently ignored
 * by the fill-only merge. Everything NOT in this set (seaAirCargo, trucker,
 * bolType, quoteRef, aes, plus the identity/party/cargo fields) stays fill-only.
 */
export const NEWER_WINS_FIELDS = [
  'cutOffDate',
  'siDate',
  'vgm',
  'customsCutoffDate',
  'etd',
  'eta',
  'draftDate',
  'loadingDate',
] as const satisfies readonly (keyof ShipmentRow)[];

/** Human labels for the change-note appended when a tracked date is revised. */
const NEWER_WINS_NOTE_LABELS: Record<(typeof NEWER_WINS_FIELDS)[number], string> = {
  cutOffDate: 'Cargo cut-off',
  siDate: 'SI cut-off',
  vgm: 'VGM cut-off',
  customsCutoffDate: 'Customs cut-off',
  etd: 'ETD',
  eta: 'ETA',
  draftDate: 'Draft cut-off',
  loadingDate: 'Loading date',
};

/**
 * PURE newer-doc-wins decision. Given the stored row values and the incoming
 * operational fields, return the subset of NEWER_WINS_FIELDS to UPDATE — only
 * fields whose incoming value is non-null/non-empty (NEVER wipe an existing
 * date because a later doc omitted it) AND differs from the stored value. Kept
 * pure (no DB) so the rule is unit-testable in isolation. Fill-only fields are
 * handled separately by mergeShipmentFillOnly.
 */
export function newerWinsDatePatch(
  existing: Partial<ShipmentRow>,
  incoming: Partial<ShipmentRow>
): Partial<ShipmentRow> {
  const patch: Record<string, unknown> = {};
  for (const key of NEWER_WINS_FIELDS) {
    const next = (incoming as Record<string, unknown>)[key];
    if (next == null || next === '') continue; // never wipe an existing value
    const prev = (existing as Record<string, unknown>)[key] ?? null;
    if (next !== prev) patch[key] = next;
  }
  return patch as Partial<ShipmentRow>;
}

/**
 * Build a concise change-note for tracked dates that were actually REVISED on
 * re-drop (old value non-null → new different value). Returns null when the
 * patch only fills previously-empty cells (a first value isn't an "update").
 */
export function buildCutoffChangeNote(
  existing: Partial<ShipmentRow>,
  patch: Partial<ShipmentRow>
): string | null {
  const lines: string[] = [];
  for (const key of NEWER_WINS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const prev = (existing as Record<string, unknown>)[key];
    if (prev == null || prev === '') continue; // empty → filled, not a change
    const next = (patch as Record<string, unknown>)[key];
    lines.push(`${NEWER_WINS_NOTE_LABELS[key]} updated: ${String(prev)} → ${String(next)}`);
  }
  return lines.length > 0 ? lines.join('; ') : null;
}

export type StatusItem = { label: string; state: string; detail?: string | null };

/** Normalise the AI's status_items into the stored shape (drop empties). */
export function statusItemsFromBriefing(briefing: ShipmentBriefing): StatusItem[] {
  return (briefing.status_items ?? [])
    .filter((s) => s && typeof s.label === 'string' && s.label.trim().length > 0)
    .map((s) => ({
      label: s.label.trim(),
      state: s.state === 'done' || s.state === 'na' ? s.state : 'pending',
      detail: s.detail ?? null,
    }));
}

/**
 * Merge a freshly-extracted status checklist into an existing one. Upsert by
 * (case-insensitive) label: a newer document's read of a milestone overrides
 * the prior state/detail for that label, while milestones only the older doc
 * knew about are retained. Order follows first-seen. Never invents items.
 */
export function mergeStatusItems(
  existing: StatusItem[] | null | undefined,
  incoming: StatusItem[]
): StatusItem[] {
  const out: StatusItem[] = (existing ?? []).map((s) => ({ ...s }));
  const indexByLabel = new Map<string, number>();
  out.forEach((s, i) => indexByLabel.set(s.label.toLowerCase(), i));
  for (const item of incoming) {
    const key = item.label.toLowerCase();
    const at = indexByLabel.get(key);
    if (at == null) {
      indexByLabel.set(key, out.length);
      out.push({ ...item });
    } else {
      out[at] = { ...item };
    }
  }
  return out;
}

function sourceFileLabel(files: RawIntakeFile[]): string | null {
  return files.map((f) => f.filename).filter(Boolean).join(', ') || null;
}

function stampItems(
  items: ShipmentBriefing['cost_items'],
  files: RawIntakeFile[],
  fxRates: Record<string, number>
): MoneyItem[] {
  const src = sourceFileLabel(files);
  const now = new Date().toISOString();
  return (items ?? [])
    .filter((c) => Number.isFinite(c.amount) && c.amount !== 0)
    .map((c) => {
      const conv = toUsd(c.amount, c.currency || 'USD', fxRates);
      const note = conversionAnnotation(conv);
      return {
        name: note ? `${c.name} ${note}` : c.name,
        amount: conv.amount,
        currency: 'USD',
        sourceFile: src,
        addedAt: now,
      };
    });
}

async function saveArtifacts(
  refId: string,
  files: RawIntakeFile[],
  briefingFiles: BriefingFile[],
  startIdx: number
): Promise<Artifact[]> {
  const { storeShipmentAttachment } = await import('./keptFileStore.js');
  const stamp = new Date().toISOString();
  const out: Artifact[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const safe = (f.filename ?? `file-${startIdx + i}`).replace(/[^a-z0-9._-]/gi, '_');
    const stored = await storeShipmentAttachment({
      refId,
      objectName: `${startIdx + i}-${safe}`,
      bytes: Buffer.from(f.contentBase64, 'base64'),
      contentType: briefingFiles[i]!.mediaType,
    });
    out.push({
      filename: f.filename ?? safe,
      url: stored.servedUrl,
      mediaType: briefingFiles[i]!.mediaType,
      addedAt: stamp,
    });
  }
  return out;
}

export type ApplyOptions = {
  briefing: ShipmentBriefing;
  files: RawIntakeFile[];
  fxRates?: Record<string, number>;
  ephemeral?: boolean;
  /** Force a specific ref on create (e.g. the doc quoted an S-number). */
  refId?: string;
};

/**
 * CREATE a brand-new shipment from a parsed briefing. Ports the create branch
 * of /api/shipments/parse: operational fields + stamped cost/sold breakdowns +
 * saved source files.
 */
export async function createFromBriefing(opts: ApplyOptions): Promise<ShipmentRow> {
  const { briefing, files, ephemeral } = opts;
  const fxRates = opts.fxRates ?? {};
  const briefingFiles = buildBriefingFiles(files);

  const stampedCosts = stampItems(briefing.cost_items, files, fxRates);
  const initialOurCost = stampedCosts.reduce((s, c) => s + (c.amount || 0), 0);
  const stampedSold = stampItems(briefing.sold_items, files, fxRates);
  const initialSoldFromItems = stampedSold.reduce((s, c) => s + (c.amount || 0), 0);
  const initialSoldRate =
    stampedSold.length > 0 ? initialSoldFromItems : (briefing.sold_rate ?? null);

  const fields = {
    ...operationalFieldsFromBriefing(briefing),
    soldRate: initialSoldRate,
    soldCurrency: 'USD',
    soldBreakdownJson: stampedSold.length > 0 ? stampedSold : null,
    ourCost: stampedCosts.length > 0 ? initialOurCost : null,
    ourCostCurrency: 'USD',
    costBreakdownJson: stampedCosts.length > 0 ? stampedCosts : null,
    notes: briefing.notes ?? null,
    statusItems: statusItemsFromBriefing(briefing),
  };

  const row = await createShipment({
    ...(opts.refId ? { refId: opts.refId } : {}),
    ...fields,
  });

  // Auto-add the customer/shipper/receiver names to the company directory
  // (fire-and-forget, non-fatal — never blocks the shipment create).
  recordShipmentCompanies(fields as Record<string, unknown>);

  if (!ephemeral && files.length > 0) {
    const artifacts = await saveArtifacts(row.refId, files, briefingFiles, 1);
    const db = createDbClient();
    await db
      .update(shipments)
      .set({ artifactsJson: artifacts, updatedAt: new Date() })
      .where(eq(shipments.refId, row.refId));
  }
  return (await getShipment(row.refId)) ?? row;
}

/**
 * MERGE a parsed briefing into an existing shipment, fill-only: never overwrite
 * a populated cell. Operational fields go through mergeShipmentFillOnly; notes
 * are appended; cost/sold line items are appended (total = sum of items, with a
 * "Previous adjustment" snapshot when a prior manual override existed); source
 * files are appended to artifactsJson.
 */
export async function mergeFromBriefing(
  opts: ApplyOptions & { refId: string }
): Promise<ShipmentRow | null> {
  const { briefing, files, refId, ephemeral } = opts;
  const fxRates = opts.fxRates ?? {};
  const existing = await getShipment(refId);
  if (!existing) return null;
  const briefingFiles = buildBriefingFiles(files);

  // Operational fields split into two merge policies:
  //  • Fill-only (identity/party/cargo + label-ish logistics fields): never
  //    overwrite a populated cell.
  //  • Newer-doc-wins (cut-off / milestone DATE fields): a revised confirmation
  //    must UPDATE a changed date. See NEWER_WINS_FIELDS.
  const opFields = operationalFieldsFromBriefing(briefing);
  const newerWinsSet = new Set<string>(NEWER_WINS_FIELDS);
  const fillOnlyFields: Record<string, unknown> = {};
  const newerWinsIncoming: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opFields)) {
    if (newerWinsSet.has(k)) newerWinsIncoming[k] = v;
    else fillOnlyFields[k] = v;
  }
  await mergeShipmentFillOnly(refId, fillOnlyFields as Partial<ShipmentRow>);

  // Newer-doc-wins: overwrite tracked date fields when the new doc gives a
  // non-null value that differs from what's stored (never wipes on omission).
  const datePatch = newerWinsDatePatch(existing, newerWinsIncoming as Partial<ShipmentRow>);
  if (Object.keys(datePatch).length > 0) {
    await updateShipment(refId, datePatch);
  }

  // Auto-add any company names seen in this briefing to the directory, even
  // when fill-only skips writing them to an already-populated cell — a NEW
  // company should still be captured. Fire-and-forget, non-fatal.
  recordShipmentCompanies(opFields as Record<string, unknown>);

  // Append notes (don't overwrite) — the doc's own notes plus a concise
  // change-note for any tracked cut-off date that was actually REVISED.
  const changeNote = buildCutoffChangeNote(existing, datePatch);
  const noteParts: string[] = [];
  if (briefing.notes && briefing.notes.trim().length > 0) {
    noteParts.push(briefing.notes.trim());
  }
  if (changeNote) noteParts.push(changeNote);
  if (noteParts.length > 0) {
    const addition = noteParts.join('\n');
    const merged = existing.notes ? `${existing.notes}\n\n${addition}` : addition;
    const db = createDbClient();
    await db
      .update(shipments)
      .set({ notes: merged, updatedAt: new Date() })
      .where(eq(shipments.refId, refId));
  }

  // Status checklist: upsert by label (newer doc's read of a milestone wins).
  const newStatusItems = statusItemsFromBriefing(briefing);
  if (newStatusItems.length > 0) {
    const merged = mergeStatusItems(existing.statusItems, newStatusItems);
    const db = createDbClient();
    await db
      .update(shipments)
      .set({ statusItems: merged, updatedAt: new Date() })
      .where(eq(shipments.refId, refId));
  }

  // Cost breakdown: append, preserving any prior manual override as a snapshot.
  const newCostItems = stampItems(briefing.cost_items, files, fxRates);
  if (newCostItems.length > 0) {
    const prior = (existing.costBreakdownJson ?? []).slice();
    const oldSum = prior.reduce((s, c) => s + (c.amount || 0), 0);
    const oldTotal = typeof existing.ourCost === 'number' ? existing.ourCost : oldSum;
    const orphan = oldTotal - oldSum;
    let breakdown = prior;
    if (breakdown.length > 0 && Math.abs(orphan) > 0.005) {
      breakdown = [
        ...breakdown,
        {
          name: 'Previous adjustment',
          amount: Math.round(orphan * 100) / 100,
          currency: existing.ourCostCurrency || 'USD',
          sourceFile: 'reconciled',
          addedAt: new Date().toISOString(),
        },
      ];
    }
    breakdown = [...breakdown, ...newCostItems];
    const total = breakdown.reduce((s, c) => s + (c.amount || 0), 0);
    const db = createDbClient();
    await db
      .update(shipments)
      .set({
        costBreakdownJson: breakdown,
        ourCost: total,
        ourCostCurrency: 'USD',
        updatedAt: new Date(),
      })
      .where(eq(shipments.refId, refId));
  }

  // Sold breakdown: same invariant.
  const newSoldItems = stampItems(briefing.sold_items, files, fxRates);
  if (newSoldItems.length > 0) {
    const prior = (existing.soldBreakdownJson ?? []).slice();
    const oldSum = prior.reduce((s, c) => s + (c.amount || 0), 0);
    const oldTotal = typeof existing.soldRate === 'number' ? existing.soldRate : oldSum;
    const orphan = oldTotal - oldSum;
    let breakdown = prior;
    if (breakdown.length > 0 && Math.abs(orphan) > 0.005) {
      breakdown = [
        ...breakdown,
        {
          name: 'Previous adjustment',
          amount: Math.round(orphan * 100) / 100,
          currency: existing.soldCurrency || 'USD',
          sourceFile: 'reconciled',
          addedAt: new Date().toISOString(),
        },
      ];
    }
    breakdown = [...breakdown, ...newSoldItems];
    const total = breakdown.reduce((s, c) => s + (c.amount || 0), 0);
    const db = createDbClient();
    await db
      .update(shipments)
      .set({
        soldBreakdownJson: breakdown,
        soldRate: total,
        soldCurrency: 'USD',
        updatedAt: new Date(),
      })
      .where(eq(shipments.refId, refId));
  }

  // Append source files.
  if (!ephemeral && files.length > 0) {
    const startIdx = (existing.artifactsJson?.length ?? 0) + 1;
    const newArtifacts = await saveArtifacts(refId, files, briefingFiles, startIdx);
    const all = [...(existing.artifactsJson ?? []), ...newArtifacts];
    const db = createDbClient();
    await db
      .update(shipments)
      .set({ artifactsJson: all, updatedAt: new Date() })
      .where(eq(shipments.refId, refId));
  }

  return getShipment(refId);
}
