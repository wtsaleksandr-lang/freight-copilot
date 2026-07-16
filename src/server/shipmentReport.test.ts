import assert from 'node:assert/strict';
import test from 'node:test';
import { buildShipmentStatusReport } from './shipmentReport.js';

const now = new Date('2026-07-16T12:00:00Z');

test('active stale shipment is flagged for attention', () => {
  const report = buildShipmentStatusReport([
    {
      refId: 'S00001',
      customerName: 'Acme',
      pol: 'Toronto',
      pod: 'Antwerp',
      containerType: '40HC',
      operationalStatus: 'processing',
      bookingRef: null,
      updatedAt: '2026-07-01T12:00:00Z',
    },
  ], now);

  assert.equal(report.shipmentCount, 1);
  assert.equal(report.attentionCount, 1);
  assert.ok(report.items[0]?.attention.includes('Booking reference is missing'));
  assert.ok(report.items[0]?.attention.includes('No update for 15 days'));
  assert.match(report.text, /S00001 — Acme/);
});

test('completed shipment is not flagged for missing booking or age', () => {
  const report = buildShipmentStatusReport([
    {
      refId: 'S00002',
      customerName: 'Beta',
      pol: 'Montreal',
      pod: 'Rotterdam',
      operationalStatus: 'completed',
      bookingRef: null,
      updatedAt: '2026-05-01T12:00:00Z',
    },
  ], now);

  assert.equal(report.attentionCount, 0);
});

test('financial values are not part of the report contract', () => {
  const report = buildShipmentStatusReport([
    {
      refId: 'S00003',
      customerName: 'Gamma',
      pol: 'Newark',
      pod: 'Gdynia',
      operationalStatus: 'processing',
      bookingRef: 'MAEU123',
      updatedAt: now,
    },
  ], now);

  assert.doesNotMatch(report.text, /profit|sold rate|our cost/i);
});
