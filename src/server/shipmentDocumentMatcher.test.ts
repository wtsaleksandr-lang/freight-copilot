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

test('shared evidence returns ambiguous candidates', () => {
  const result = chooseShipmentMatch({ shipperName: 'ABC Machinery', containerType: '40HC' }, rows);
  assert.equal(result.status, 'ambiguous');
});

test('matching route ranks above partial party match', () => {
  const ranked = rankShipmentMatches({ customerName: 'Access Air', pol: 'Montreal', pod: 'Antwerp' }, rows);
  assert.equal(ranked[0]?.shipment.refId, 'S00011');
  assert.ok(ranked[0]?.evidence.includes('POD'));
});
