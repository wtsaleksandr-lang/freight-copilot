import { desc, eq, like, or, sql } from 'drizzle-orm';
import { createDbClient } from './client.js';
import { shipments } from './schema.js';

export type ShipmentRow = typeof shipments.$inferSelect;
export type NewShipment = typeof shipments.$inferInsert;

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
    notes: patch.notes ?? null,
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
]);

export async function updateShipment(
  refId: string,
  patch: Partial<ShipmentRow>
): Promise<ShipmentRow | null> {
  const db = createDbClient();
  const safe: Partial<NewShipment> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (EDITABLE_FIELDS.has(k as keyof ShipmentRow)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (safe as any)[k] = v;
    }
  }
  if (Object.keys(safe).length === 0) return getShipment(refId);
  safe.updatedAt = new Date();
  const [row] = await db
    .update(shipments)
    .set(safe)
    .where(eq(shipments.refId, refId))
    .returning();
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

export async function getShipment(
  refId: string
): Promise<ShipmentRow | null> {
  const db = createDbClient();
  const [row] = await db
    .select()
    .from(shipments)
    .where(eq(shipments.refId, refId));
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
