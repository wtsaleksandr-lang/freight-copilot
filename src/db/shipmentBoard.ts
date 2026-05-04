import { desc, eq, like, or, sql } from 'drizzle-orm';
import { createDbClient } from './client.js';
import { shipments } from './schema.js';

export type ShipmentRow = typeof shipments.$inferSelect;
export type NewShipment = typeof shipments.$inferInsert;

/**
 * Allocate the next available ref-id in the S00001 / S00002 format.
 * Pulls the current max counter (everything after the leading "S") and
 * adds one. Pads to 5 digits but allows growth past 99999 naturally.
 */
async function nextRefId(): Promise<string> {
  const db = createDbClient();
  const all = await db.select({ refId: shipments.refId }).from(shipments);
  let max = 0;
  for (const r of all) {
    const m = /^S(\d+)$/i.exec(r.refId ?? '');
    if (m) {
      const n = parseInt(m[1]!, 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  const next = max + 1;
  return 'S' + String(next).padStart(5, '0');
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
  const refId = patch.refId ?? (await nextRefId());
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
  // libsql returns { rowsAffected }
  const ra =
    (result as unknown as { rowsAffected?: number }).rowsAffected ?? 0;
  return ra > 0;
}
