import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTruckingHistoricalEstimate, type TruckingHistoricalRow } from './truckingHistoricalEstimate.js';

const baseRow: TruckingHistoricalRow = {
  providerName: 'Carrier A',
  providerCode: 'CARRIER_A',
  baseRateCents: 200000,
  totalCostCents: 240000,
  currency: 'USD',
  transitDays: 2,
  ratePerMile: 3,
  totalMiles: 800,
  parsedAt: new Date('2026-07-10T00:00:00Z'),
  mode: 'ftl',
  equipmentType: 'dryvan',
  pickupCity: 'Chicago',
  pickupState: 'IL',
  pickupZip: '60601',
  pickupCountry: 'US',
  deliveryCity: 'Houston',
  deliveryState: 'TX',
  deliveryZip: '77001',
  deliveryCountry: 'US',
  cargoType: 'general',
  hazmat: false,
  tempControlled: false,
  weightKg: 18000,
};

const input = {
  mode: 'ftl' as const,
  equipmentType: 'dryvan',
  pickupCity: 'Chicago',
  pickupState: 'IL',
  pickupZip: '60601',
  deliveryCity: 'Houston',
  deliveryState: 'TX',
  deliveryZip: '77001',
  weightKg: 17500,
};

test('uses median and excludes generated estimates', () => {
  const rows = [
    baseRow,
    { ...baseRow, providerName: 'Carrier B', totalCostCents: 260000, baseRateCents: 220000 },
    { ...baseRow, providerName: 'Carrier C', totalCostCents: 250000, baseRateCents: 210000 },
    { ...baseRow, providerCode: 'HIST_ESTIMATE', totalCostCents: 999999 },
  ];
  const estimate = buildTruckingHistoricalEstimate(input, rows);
  assert.ok(estimate);
  assert.equal(estimate.totalCost, 2500);
  assert.equal(estimate.sourceCount, 3);
  assert.equal(estimate.confidence, 'medium');
});

test('does not use non-hazmat history for hazmat request', () => {
  const estimate = buildTruckingHistoricalEstimate({ ...input, cargoType: 'hazmat', hazmat: true }, [baseRow]);
  assert.equal(estimate, null);
});

test('requires matching equipment and lane', () => {
  const estimate = buildTruckingHistoricalEstimate({ ...input, equipmentType: 'flatbed' }, [baseRow]);
  assert.equal(estimate, null);
});
