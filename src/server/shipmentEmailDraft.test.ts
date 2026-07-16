import assert from 'node:assert/strict';
import test from 'node:test';
import { buildShipmentEmailDraft } from './shipmentEmailDraft.js';

const shipment = {
  refId: 'S00042',
  customerName: 'Acme Imports',
  pol: 'Montreal',
  pod: 'Antwerp',
  containerType: '40HC',
  containerQuantity: 2,
  cargoName: 'Household goods',
  carrierPreference: 'MSC',
  bookingRef: 'MSC123456',
  operationalStatus: 'processing',
  notes: 'Awaiting vessel confirmation.',
};

test('status update includes shipment context but no financial data', () => {
  const draft = buildShipmentEmailDraft(shipment, { type: 'status_update' });
  assert.match(draft.subject, /S00042/);
  assert.match(draft.body, /Montreal to Antwerp/);
  assert.match(draft.body, /2 x 40HC/);
  assert.match(draft.body, /MSC123456/);
  assert.doesNotMatch(draft.body, /profit|sell rate|our cost/i);
});

test('booking follow-up requests confirmation', () => {
  const draft = buildShipmentEmailDraft(
    { ...shipment, bookingRef: null },
    { type: 'booking_followup', recipientName: 'Daniel' }
  );
  assert.match(draft.body, /Dear Daniel/);
  assert.match(draft.body, /provide the booking confirmation/i);
  assert.ok(draft.missingFields.includes('booking reference'));
});

test('missing-information draft uses supplied request', () => {
  const draft = buildShipmentEmailDraft(shipment, {
    type: 'missing_information',
    extraContext: 'Please confirm cargo weight and pickup date.',
  });
  assert.match(draft.subject, /Information required/);
  assert.match(draft.body, /cargo weight and pickup date/i);
});

test('delay notice uses operational context', () => {
  const draft = buildShipmentEmailDraft(shipment, {
    type: 'delay_notice',
    extraContext: 'The vessel departure was moved by three days.',
  });
  assert.match(draft.subject, /delay notice/i);
  assert.match(draft.body, /moved by three days/i);
});
