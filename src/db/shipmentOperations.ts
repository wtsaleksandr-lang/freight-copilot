import { neon } from '@neondatabase/serverless';
import { loadEnv } from '../config.js';

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

type ContainerRow = ShipmentContainerInput & {
  id: number;
  shipmentRefId: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type FollowUpRow = ShipmentFollowUpInput & {
  id: number;
  shipmentRefId: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

const sql = neon(loadEnv().DATABASE_URL);
let tablesReady: Promise<void> | null = null;

function ensureTables(): Promise<void> {
  if (tablesReady) return tablesReady;
  tablesReady = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS shipment_containers (
        id SERIAL PRIMARY KEY,
        shipment_ref_id TEXT NOT NULL REFERENCES shipments(ref_id) ON DELETE CASCADE,
        container_number TEXT,
        seal_number TEXT,
        vessel_voyage TEXT,
        etd TEXT,
        eta TEXT,
        actual_departure TEXT,
        actual_arrival TEXT,
        last_free_day TEXT,
        empty_return_date TEXT,
        status TEXT NOT NULL DEFAULT 'planned',
        notes TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`;
    await sql`
      CREATE TABLE IF NOT EXISTS shipment_follow_ups (
        id SERIAL PRIMARY KEY,
        shipment_ref_id TEXT NOT NULL REFERENCES shipments(ref_id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        due_date TEXT,
        priority TEXT NOT NULL DEFAULT 'normal',
        completed BOOLEAN NOT NULL DEFAULT FALSE,
        notes TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )`;
    await sql`CREATE INDEX IF NOT EXISTS shipment_containers_ref_idx ON shipment_containers(shipment_ref_id)`;
    await sql`CREATE INDEX IF NOT EXISTS shipment_follow_ups_ref_idx ON shipment_follow_ups(shipment_ref_id)`;
    await sql`CREATE INDEX IF NOT EXISTS shipment_follow_ups_open_idx ON shipment_follow_ups(completed, due_date)`;
  })().catch((error) => {
    tablesReady = null;
    throw error;
  });
  return tablesReady;
}

function mapContainer(row: Record<string, unknown>): ContainerRow {
  return {
    id: Number(row.id),
    shipmentRefId: String(row.shipment_ref_id),
    containerNumber: row.container_number == null ? null : String(row.container_number),
    sealNumber: row.seal_number == null ? null : String(row.seal_number),
    vesselVoyage: row.vessel_voyage == null ? null : String(row.vessel_voyage),
    etd: row.etd == null ? null : String(row.etd),
    eta: row.eta == null ? null : String(row.eta),
    actualDeparture: row.actual_departure == null ? null : String(row.actual_departure),
    actualArrival: row.actual_arrival == null ? null : String(row.actual_arrival),
    lastFreeDay: row.last_free_day == null ? null : String(row.last_free_day),
    emptyReturnDate: row.empty_return_date == null ? null : String(row.empty_return_date),
    status: row.status == null ? 'planned' : String(row.status),
    notes: row.notes == null ? null : String(row.notes),
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapFollowUp(row: Record<string, unknown>): FollowUpRow {
  return {
    id: Number(row.id),
    shipmentRefId: String(row.shipment_ref_id),
    title: String(row.title),
    dueDate: row.due_date == null ? null : String(row.due_date),
    priority: row.priority == null ? 'normal' : String(row.priority),
    completed: Boolean(row.completed),
    notes: row.notes == null ? null : String(row.notes),
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function shipmentExists(refId: string): Promise<boolean> {
  const rows = await sql`SELECT ref_id FROM shipments WHERE ref_id = ${refId} LIMIT 1`;
  return rows.length > 0;
}

export async function getShipmentOperations(refId: string) {
  await ensureTables();
  if (!(await shipmentExists(refId))) return null;
  const [containerRows, followUpRows] = await Promise.all([
    sql`SELECT * FROM shipment_containers WHERE shipment_ref_id = ${refId} ORDER BY sort_order, id`,
    sql`SELECT * FROM shipment_follow_ups WHERE shipment_ref_id = ${refId} ORDER BY completed, due_date NULLS LAST, sort_order, id`,
  ]);
  return {
    refId,
    containers: containerRows.map((row) => mapContainer(row as Record<string, unknown>)),
    followUps: followUpRows.map((row) => mapFollowUp(row as Record<string, unknown>)),
  };
}

export async function replaceShipmentOperations(
  refId: string,
  containers: ShipmentContainerInput[],
  followUps: ShipmentFollowUpInput[]
) {
  await ensureTables();
  if (!(await shipmentExists(refId))) return null;

  await sql`DELETE FROM shipment_containers WHERE shipment_ref_id = ${refId}`;
  await sql`DELETE FROM shipment_follow_ups WHERE shipment_ref_id = ${refId}`;

  for (let index = 0; index < containers.length; index += 1) {
    const item = containers[index]!;
    await sql`
      INSERT INTO shipment_containers (
        shipment_ref_id, container_number, seal_number, vessel_voyage,
        etd, eta, actual_departure, actual_arrival, last_free_day,
        empty_return_date, status, notes, sort_order, updated_at
      ) VALUES (
        ${refId}, ${item.containerNumber?.trim() || null}, ${item.sealNumber?.trim() || null},
        ${item.vesselVoyage?.trim() || null}, ${item.etd || null}, ${item.eta || null},
        ${item.actualDeparture || null}, ${item.actualArrival || null}, ${item.lastFreeDay || null},
        ${item.emptyReturnDate || null}, ${item.status?.trim() || 'planned'},
        ${item.notes?.trim() || null}, ${index}, NOW()
      )`;
  }

  for (let index = 0; index < followUps.length; index += 1) {
    const item = followUps[index]!;
    await sql`
      INSERT INTO shipment_follow_ups (
        shipment_ref_id, title, due_date, priority, completed, notes, sort_order, updated_at
      ) VALUES (
        ${refId}, ${item.title.trim()}, ${item.dueDate || null}, ${item.priority?.trim() || 'normal'},
        ${Boolean(item.completed)}, ${item.notes?.trim() || null}, ${index}, NOW()
      )`;
  }

  await sql`UPDATE shipments SET updated_at = NOW() WHERE ref_id = ${refId}`;
  return getShipmentOperations(refId);
}

export async function listOpenFollowUps() {
  await ensureTables();
  const rows = await sql`
    SELECT id, shipment_ref_id, title, due_date, priority, notes, sort_order, created_at, updated_at, completed
    FROM shipment_follow_ups
    WHERE completed = FALSE
    ORDER BY due_date NULLS LAST, sort_order, id`;
  return rows.map((row) => mapFollowUp(row as Record<string, unknown>));
}
