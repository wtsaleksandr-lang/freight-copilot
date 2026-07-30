import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MERGE_MUTABLE_COLUMNS,
  snapshotMergePreState,
  type ShipmentRow,
} from './shipmentBoard.js';

// A representative "before merge" row with every mutable column populated.
function baseRow(): ShipmentRow {
  return {
    id: 1,
    refId: 'S00042',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    shipperName: 'Acme Exports',
    receiverName: null,
    customerName: 'Globex',
    loadingAddress: null,
    fpol: null,
    fpolCode: null,
    pol: 'Shanghai',
    polCode: 'CNSHA',
    pod: 'Rotterdam',
    podCode: null,
    fpod: null,
    fpodCode: null,
    containerType: '40HC',
    containerQuantity: 2,
    cargoType: null,
    cargoName: 'Machinery',
    soldRate: 5200,
    soldCurrency: 'USD',
    soldBreakdownJson: [{ name: 'All-in', amount: 5200, currency: 'USD' }],
    ourCost: 4100,
    ourCostCurrency: 'USD',
    costBreakdownJson: [{ name: 'Ocean', amount: 4100, currency: 'USD' }],
    carrierPreference: 'MSC',
    bookingRef: 'MSC-1',
    shipmentType: 'FCL',
    operationalStatus: null,
    operationalStatuses: [],
    notes: 'Original note.',
    statusItems: [{ label: 'Booked', state: 'done', detail: null }],
    artifactsJson: [
      { filename: 'a.pdf', url: '/x/a.pdf', mediaType: 'application/pdf', addedAt: '2026-01-01' },
    ],
    cutOffDate: null,
    siDate: null,
    seaAirCargo: null,
    vgm: null,
    draftDate: null,
    loadingDate: null,
    trucker: null,
    etd: null,
    eta: null,
    bolType: null,
    quoteRef: null,
    aes: null,
    customsCutoffDate: null,
  } as ShipmentRow;
}

// Emulate exactly what mergeFromBriefing mutates: fill empty operational
// cells, append notes, grow the breakdowns + totals, upsert status items,
// append artifacts. The snapshot must be able to undo ALL of it.
function applyMergeMutation(row: ShipmentRow): ShipmentRow {
  return {
    ...row,
    receiverName: 'Rhine Imports', // was empty → filled
    loadingAddress: '12 Dock Rd', // was empty → filled
    notes: 'Original note.\n\nAppended from new doc.',
    costBreakdownJson: [
      ...(row.costBreakdownJson ?? []),
      { name: 'THC', amount: 300, currency: 'USD' },
    ],
    ourCost: 4400,
    soldBreakdownJson: [
      ...(row.soldBreakdownJson ?? []),
      { name: 'Markup', amount: 400, currency: 'USD' },
    ],
    soldRate: 5600,
    statusItems: [
      ...(row.statusItems ?? []),
      { label: 'Sailed', state: 'pending', detail: null },
    ],
    artifactsJson: [
      ...(row.artifactsJson ?? []),
      { filename: 'b.pdf', url: '/x/b.pdf', mediaType: 'application/pdf', addedAt: '2026-02-01' },
    ],
  } as ShipmentRow;
}

// Pure stand-in for restoreShipmentSnapshot's write step: overlay the snapshot
// onto whatever the row currently is. (restoreShipmentSnapshot does this via
// db.update; here we prove the snapshot carries enough to reverse the merge.)
function applySnapshot(
  row: ShipmentRow,
  snap: ReturnType<typeof snapshotMergePreState>
): ShipmentRow {
  const out = { ...row } as Record<string, unknown>;
  for (const col of MERGE_MUTABLE_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(snap, col)) {
      out[col] = (snap as Record<string, unknown>)[col] ?? null;
    }
  }
  return out as ShipmentRow;
}

test('snapshot → merge-mutate → restore returns the original mutable columns', () => {
  const original = baseRow();
  const snap = snapshotMergePreState(original);

  const merged = applyMergeMutation(original);
  // Sanity: the merge actually changed things.
  assert.notDeepEqual(merged.costBreakdownJson, original.costBreakdownJson);
  assert.notEqual(merged.notes, original.notes);
  assert.notEqual(merged.ourCost, original.ourCost);

  const restored = applySnapshot(merged, snap);

  // Every mutable column is back to its pre-merge value, verbatim.
  for (const col of MERGE_MUTABLE_COLUMNS) {
    assert.deepEqual(
      (restored as Record<string, unknown>)[col],
      (original as Record<string, unknown>)[col],
      `column ${col} not restored`
    );
  }
});

test('snapshot captures every mutable column (empty values stored as null, not omitted)', () => {
  const snap = snapshotMergePreState(baseRow());
  for (const col of MERGE_MUTABLE_COLUMNS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(snap, col),
      `snapshot missing column ${col}`
    );
  }
  // A column that was null on the row is present and null in the snapshot.
  assert.equal((snap as Record<string, unknown>).receiverName, null);
});
