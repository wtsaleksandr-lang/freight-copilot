import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewTruckingRate } from './truckingIngestionReview.js';

const baseRate = {
  provider_name: 'Test Trucking',
  provider_code: 'TST',
  mode: 'ftl' as const,
  equipment_type: 'Dry Van',
  pickup_address: null,
  pickup_city: 'Chicago',
  pickup_state: 'IL',
  pickup_zip: '60601',
  pickup_country: 'US',
  delivery_address: null,
  delivery_city: 'Atlanta',
  delivery_state: 'GA',
  delivery_zip: '30301',
  delivery_country: 'US',
  cargo_type: 'general' as const,
  hazmat: false,
  temp_controlled: false,
  weight_kg: 10000,
  base_rate: 1800,
  total_cost: 2050,
  currency: 'usd',
  rate_per_mile: 2.8,
  total_miles: 730,
  transit_days: 2,
  valid_until: '2026-08-15',
  charges: [{ name: 'Fuel', amount: 250, currency: 'USD' }],
  notes: null,
  source_filename: 'quote.xlsx',
};

test('marks a complete rate ready and normalizes currency', () => {
  const reviewed = reviewTruckingRate(baseRate);
  assert.equal(reviewed.readyToImport, true);
  assert.equal(reviewed.currency, 'USD');
  assert.equal(reviewed.reviewIssues.length, 0);
});

test('blocks missing lane and invalid currency', () => {
  const reviewed = reviewTruckingRate({ ...baseRate, pickup_city: '', currency: '$' });
  assert.equal(reviewed.readyToImport, false);
  assert.ok(reviewed.reviewIssues.some((issue) => issue.field === 'pickup_city' && issue.severity === 'blocking'));
  assert.ok(reviewed.reviewIssues.some((issue) => issue.field === 'currency' && issue.severity === 'blocking'));
});

test('warns when all-in is below base and validity is absent', () => {
  const reviewed = reviewTruckingRate({ ...baseRate, total_cost: 1700, valid_until: null });
  assert.equal(reviewed.readyToImport, true);
  assert.ok(reviewed.reviewIssues.some((issue) => issue.field === 'total_cost' && issue.severity === 'warning'));
  assert.ok(reviewed.reviewIssues.some((issue) => issue.field === 'valid_until' && issue.severity === 'warning'));
});
