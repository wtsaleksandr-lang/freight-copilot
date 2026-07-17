import { and, asc, eq } from 'drizzle-orm';
import { createDbClient } from './client.js';
import { shipments } from './schema.js';
import { shipmentContainers, shipmentFollowUps } from './shipmentOperationsSchema.js';

export type ShipmentContainerInput = {
  containerNumber?: string | null;
  sealNumber?: string | null;
  vesselVoyage?: string | null;
  etd?: string | null;
  eta?: string | null;
  actualDeparture?: string | null;
  actualArrival?: string | null;
  lastFreeDay?: string | null;
  emptyReturnDate?: string | null;
  status?: string | null;
  notes?: string | null;
};

export type ShipmentFollowUpInput = {
  title: string;
  dueDate?: string | null;
  priority?: string | null;
  completed?: boolean;
  notes?: string | null;
};

export async function getShipmentOperations(refId: string) {
  const db = createDbClient();
  const [shipment] = await db.select({ refId: shipments.refId }).from(shipments).where(eq(shipments.refId, refId));
  if (!shipment) return null;
  const [containers, followUps] = await Promise.all([
    db.select().from(shipmentContainers).where(eq(shipmentContainers.shipmentRefId, refId)).orderBy(asc(shipmentContainers.sortOrder), asc(shipmentContainers.id)),
    db.select().from(shipmentFollowUps).where(eq(shipmentFollowUps.shipmentRefId, refId)).orderBy(asc(shipmentFollowUps.completed), asc(shipmentFollowUps.dueDate), asc(shipmentFollowUps.sortOrder), asc(shipmentFollowUps.id)),
  ]);
  return { refId, containers, followUps };
}

export async function replaceShipmentOperations(
  refId: string,
  containers: ShipmentContainerInput[],
  followUps: ShipmentFollowUpInput[]
) {
  const db = createDbClient();
  const [shipment] = await db.select({ refId: shipments.refId }).from(shipments).where(eq(shipments.refId, refId));
  if (!shipment) return null;
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.delete(shipmentContainers).where(eq(shipmentContainers.shipmentRefId, refId));
    await tx.delete(shipmentFollowUps).where(eq(shipmentFollowUps.shipmentRefId, refId));
    if (containers.length) {
      await tx.insert(shipmentContainers).values(containers.map((item, index) => ({
        shipmentRefId: refId,
        containerNumber: item.containerNumber?.trim() || null,
        sealNumber: item.sealNumber?.trim() || null,
        vesselVoyage: item.vesselVoyage?.trim() || null,
        etd: item.etd || null,
        eta: item.eta || null,
        actualDeparture: item.actualDeparture || null,
        actualArrival: item.actualArrival || null,
        lastFreeDay: item.lastFreeDay || null,
        emptyReturnDate: item.emptyReturnDate || null,
        status: item.status?.trim() || 'planned',
        notes: item.notes?.trim() || null,
        sortOrder: index,
        updatedAt: now,
      })));
    }
    if (followUps.length) {
      await tx.insert(shipmentFollowUps).values(followUps.map((item, index) => ({
        shipmentRefId: refId,
        title: item.title.trim(),
        dueDate: item.dueDate || null,
        priority: item.priority?.trim() || 'normal',
        completed: Boolean(item.completed),
        notes: item.notes?.trim() || null,
        sortOrder: index,
        updatedAt: now,
      })));
    }
    await tx.update(shipments).set({ updatedAt: now }).where(eq(shipments.refId, refId));
  });
  return getShipmentOperations(refId);
}

export async function listOpenFollowUps() {
  const db = createDbClient();
  return db
    .select({
      id: shipmentFollowUps.id,
      shipmentRefId: shipmentFollowUps.shipmentRefId,
      title: shipmentFollowUps.title,
      dueDate: shipmentFollowUps.dueDate,
      priority: shipmentFollowUps.priority,
      notes: shipmentFollowUps.notes,
    })
    .from(shipmentFollowUps)
    .where(and(eq(shipmentFollowUps.completed, false)))
    .orderBy(asc(shipmentFollowUps.dueDate), asc(shipmentFollowUps.sortOrder), asc(shipmentFollowUps.id));
}
