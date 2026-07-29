import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseShipmentMatch, rankShipmentMatches } from './shipmentDocumentMatcher.js';

const updatedAt = new Date('2026-07-17T00:00:00.000Z');
const rows = [
  { refId: 'S00011', updatedAt, bookingRef: 'MAEU-9032111', customerName: 'Access Air', shipperName: 'ABC Machinery', receiverName: 'Port Client', carrierPreference: 'Maersk', pol: 'Montreal', pod: 'Antwerp', containerType: '40HC' },
  { refId: 'S00012', updatedAt, bookingRef: 'MSC-218754', customerName: 'Other Customer', shipperName: 'ABC Machinery', receiverName: 'Port Client', carrierPreference: 'MSC', pol: 'Montreal', pod: 'Hamburg', containerType: '40HC' },
];

test('internal shipment reference is decisive', () => {
  const result = chooseShipmentMatch({ internalRef: 'S00012' }, rows);
  assert.equal(result.status, 'matched');
  if (result.status === 'matched') assert.equal(result.match.shipment.refId, 'S00012');
});

test('exact booking reference is decisive despite punctuation', () => {
  const result = chooseShipmentMatch({ bookingRef: 'MAEU 9032111' }, rows);
  assert.equal(result.status, 'matched');
  if (result.status === 'matched') assert.equal(result.match.shipment.refId, 'S00011');
});

test('weak single-signal overlap does NOT prompt (silently create)', () => {
  // shipper + container = 28, below the ambiguity floor — this combination
  // recurs across genuinely different freight shipments, so it must not prompt.
  const result = chooseShipmentMatch({ shipperName: 'ABC Machinery', containerType: '40HC' }, rows);
  assert.equal(result.status, 'none');
});

test('strong multi-field consensus with no clear winner returns ambiguous', () => {
  // shipper + receiver + POL all match BOTH rows equally (58 each) — a genuine
  // "which one?" that is worth asking about.
  const result = chooseShipmentMatch(
    { shipperName: 'ABC Machinery', receiverName: 'Port Client', pol: 'Montreal' },
    rows
  );
  assert.equal(result.status, 'ambiguous');
});

test('unmatched booking ref + strong soft overlap -> none (definitely new)', () => {
  // A booking ref is present but matches no row, yet shipper+receiver+POL all
  // match. The hard ref is authoritative: this CANNOT be an existing shipment,
  // so it must create silently — never merge, never even prompt.
  const result = chooseShipmentMatch(
    {
      bookingRef: 'ZZZ-NEW-99999',
      shipperName: 'ABC Machinery',
      receiverName: 'Port Client',
      pol: 'Montreal',
    },
    rows
  );
  assert.equal(result.status, 'none');
});

test('soft signals alone never auto-merge (matched requires a hard ref)', () => {
  // Even a lopsided strong soft match (customer+shipper heavily favouring one
  // row) must ASK, not silently merge — only a booking/internal ref may merge.
  const result = chooseShipmentMatch(
    { customerName: 'Access Air', shipperName: 'ABC Machinery' },
    rows
  );
  assert.notEqual(result.status, 'matched');
});

test('matching route ranks above partial party match', () => {
  const ranked = rankShipmentMatches({ customerName: 'Access Air', pol: 'Montreal', pod: 'Antwerp' }, rows);
  assert.equal(ranked[0]?.shipment.refId, 'S00011');
  assert.ok(ranked[0]?.evidence.includes('POD'));
});
