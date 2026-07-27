import { eq } from 'drizzle-orm';
import { createDbClient } from '../db/client.js';
import { shipments } from '../db/schema.js';
import {
  createShipment,
  getShipment,
  mergeShipmentFillOnly,
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
  };
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
  };

  const row = await createShipment({
    ...(opts.refId ? { refId: opts.refId } : {}),
    ...fields,
  });

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

  // Fill-only operational fields.
  await mergeShipmentFillOnly(refId, operationalFieldsFromBriefing(briefing));

  // Append notes (don't overwrite).
  if (briefing.notes && briefing.notes.trim().length > 0) {
    const merged = existing.notes
      ? `${existing.notes}\n\n${briefing.notes.trim()}`
      : briefing.notes.trim();
    const db = createDbClient();
    await db
      .update(shipments)
      .set({ notes: merged, updatedAt: new Date() })
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
