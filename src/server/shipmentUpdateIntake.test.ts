import assert from 'node:assert/strict';
import test from 'node:test';
import { extractShipmentUpdateProposals } from './shipmentUpdateIntake.js';

test('extracts booking, carrier, status and container changes', () => {
  const proposals = extractShipmentUpdateProposals(
    'MSC booking confirmation\nBooking ref: MSCU1234567\nEquipment: 2 x 40HC',
    { bookingRef: null, carrierPreference: null, operationalStatus: null }
  );
  const byField = Object.fromEntries(proposals.map((item) => [item.field, item.proposedValue]));
  assert.equal(byField.bookingRef, 'MSCU1234567');
  assert.equal(byField.carrierPreference, 'MSC');
  assert.equal(byField.operationalStatus, 'processing');
  assert.equal(byField.containerType, '40HC');
  assert.equal(byField.containerQuantity, 2);
});

test('does not propose values already stored', () => {
  const proposals = extractShipmentUpdateProposals(
    'Booking ref: MAEU1234567\nPOL: Montreal\nPOD: Antwerp',
    { bookingRef: 'MAEU1234567', pol: 'Montreal', pod: 'Antwerp' }
  );
  assert.equal(proposals.length, 0);
});

test('captures operational exception as a reviewable note', () => {
  const proposals = extractShipmentUpdateProposals(
    'The container was rolled to the next sailing due to port congestion.',
    { notes: 'Customer advised.' }
  );
  const note = proposals.find((item) => item.field === 'notes');
  assert.ok(note);
  assert.match(String(note?.proposedValue), /Customer advised/);
  assert.match(String(note?.proposedValue), /rolled/i);
});
