import assert from 'node:assert/strict';
import test from 'node:test';
import { validateQuoteRate } from './quoteValidation.js';

const completeRate = {
  carrierCode: 'MSK',
  serviceName: 'Direct',
  sailingDate: '2026-08-01',
  validUntil: '2026-07-31',
  transitDays: 18,
  detentionFreetimeDays: 7,
  demurrageFreetimeDays: 5,
  currency: 'USD',
  totalCostCents: 150000,
  charges: [
    {
      name: 'Ocean freight',
      basis: 'per container',
      quantity: 1,
      unit_price: 1500,
      total: 1500,
      currency: 'USD',
    },
  ],
  destinationCharges: [],
  destinationTotal: null,
  destinationCurrency: null,
  headlineMismatch: false,
  rawHtmlRef: 'quotes/Q-1/result.html',
};

test('complete rate is ready', () => {
  const result = validateQuoteRate(completeRate);
  assert.equal(result.ready, true);
  assert.equal(result.score, 100);
  assert.deepEqual(result.issues, []);
});

test('missing commercial terms block readiness', () => {
  const result = validateQuoteRate({
    ...completeRate,
    validUntil: null,
    rawHtmlRef: null,
  });
  assert.equal(result.ready, false);
  assert.ok(result.issues.some((issue) => issue.code === 'validity_missing'));
  assert.ok(result.issues.some((issue) => issue.code === 'evidence_missing'));
});

test('charge mismatch is detected', () => {
  const result = validateQuoteRate({
    ...completeRate,
    totalCostCents: 140000,
  });
  assert.equal(result.ready, false);
  assert.ok(result.issues.some((issue) => issue.code === 'freight_sum_mismatch'));
});

test('missing free time is warning only', () => {
  const result = validateQuoteRate({
    ...completeRate,
    detentionFreetimeDays: null,
    demurrageFreetimeDays: null,
  });
  assert.equal(result.ready, true);
  assert.equal(result.score, 90);
  assert.equal(result.issues.filter((issue) => issue.severity === 'warning').length, 2);
});
