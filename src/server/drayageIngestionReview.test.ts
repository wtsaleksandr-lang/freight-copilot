import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewDrayageRate } from './drayageIngestionReview.js';
import type { ParsedDrayageRate } from '../llm/parseDrayageRateFiles.js';

function base(overrides: Partial<ParsedDrayageRate> = {}): ParsedDrayageRate {
  return {
    provider_name: 'Example Drayage', provider_code: null, cargo_type: 'general', container_type: '40HC', container_count: 1, weight_kg: 18000,
    origin_type: 'CY', origin_port_code: 'USNYC', origin_port_name: 'New York', origin_terminal: null, origin_address: null, origin_city: null, origin_state: null, origin_zip: null, origin_country: 'US',
    destination_type: 'DOOR', destination_port_code: null, destination_port_name: null, destination_terminal: null, destination_address: '100 Main St', destination_city: 'Newark', destination_state: 'NJ', destination_zip: '07102', destination_country: 'US',
    base_rate: 900, total_cost: 1150, currency: 'usd', transit_days: 1, valid_until: '2026-08-31', free_time_days: 2,
    special_equipment: [], accessorials: ['fuel'], charges: [{ name: 'Fuel', amount: 250, currency: 'USD' }], notes: null, source_filename: 'quote.pdf',
    ...overrides,
  };
}

test('accepts a complete CY-to-door rate and normalizes currency', () => {
  const result = reviewDrayageRate(base());
  assert.equal(result.readyToImport, true);
  assert.equal(result.currency, 'USD');
  assert.equal(result.reviewIssues.length, 0);
});

test('blocks a CY endpoint with no identifiable port or terminal', () => {
  const result = reviewDrayageRate(base({ origin_port_code: null, origin_port_name: null, origin_terminal: null }));
  assert.equal(result.readyToImport, false);
  assert.ok(result.reviewIssues.some((issue) => issue.field === 'origin' && issue.severity === 'blocking'));
});

test('warns when all-in cost is below the base rate', () => {
  const result = reviewDrayageRate(base({ total_cost: 800 }));
  assert.equal(result.readyToImport, true);
  assert.ok(result.reviewIssues.some((issue) => issue.field === 'total_cost' && issue.severity === 'warning'));
});

test('warns for multi-container pricing ambiguity', () => {
  const result = reviewDrayageRate(base({ container_count: 3 }));
  assert.ok(result.reviewIssues.some((issue) => issue.field === 'container_count'));
});
