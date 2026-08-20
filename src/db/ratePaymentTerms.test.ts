import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seedBuckets,
  moveCharge,
  bucketTotals,
  type PaymentCharge,
} from './ratePaymentTerms.js';

function line(name: string, amount: number, currency = 'USD'): PaymentCharge {
  return { name, amount, currency };
}

test('seedBuckets: never-touched rate seeds Prepaid from freight, Collect from destination', () => {
  const buckets = seedBuckets({
    freightCharges: [line('Ocean freight', 2000), line('BAF', 300)],
    destinationCharges: [line('THC', 250)],
    prepaidStored: null,
    collectStored: null,
  });
  assert.deepEqual(
    buckets.prepaid.map((c) => c.name),
    ['Ocean freight', 'BAF']
  );
  assert.deepEqual(
    buckets.collect.map((c) => c.name),
    ['THC']
  );
});

test('seedBuckets: once stored, stored values are authoritative (freight/dest ignored)', () => {
  const buckets = seedBuckets({
    freightCharges: [line('Ocean freight', 2000)],
    destinationCharges: [line('THC', 250)],
    prepaidStored: [line('BAF', 300)],
    collectStored: [],
  });
  assert.deepEqual(
    buckets.prepaid.map((c) => c.name),
    ['BAF']
  );
  assert.equal(buckets.collect.length, 0);
});

test('seedBuckets: drops malformed lines (missing name / non-numeric amount)', () => {
  const buckets = seedBuckets({
    freightCharges: [line('Ocean freight', 2000), { name: '', amount: 5, currency: 'USD' }, { name: 'X', amount: NaN, currency: 'USD' }],
    destinationCharges: null,
    prepaidStored: null,
    collectStored: null,
  });
  assert.equal(buckets.prepaid.length, 1);
  assert.equal(buckets.collect.length, 0);
});

test('moveCharge: prepaid → collect moves the line and leaves inputs unmutated', () => {
  const before = {
    prepaid: [line('Ocean freight', 2000), line('BAF', 300)],
    collect: [line('THC', 250)],
  };
  const after = moveCharge(before, 'prepaid', 1);
  assert.deepEqual(
    after.prepaid.map((c) => c.name),
    ['Ocean freight']
  );
  assert.deepEqual(
    after.collect.map((c) => c.name),
    ['THC', 'BAF']
  );
  // Original object is untouched (fresh arrays returned).
  assert.equal(before.prepaid.length, 2);
  assert.equal(before.collect.length, 1);
});

test('moveCharge: collect → prepaid moves the line back', () => {
  const after = moveCharge(
    { prepaid: [line('Ocean freight', 2000)], collect: [line('THC', 250)] },
    'collect',
    0
  );
  assert.deepEqual(
    after.prepaid.map((c) => c.name),
    ['Ocean freight', 'THC']
  );
  assert.equal(after.collect.length, 0);
});

test('moveCharge: out-of-range index throws invalid index', () => {
  const buckets = { prepaid: [line('Ocean freight', 2000)], collect: [] };
  assert.throws(() => moveCharge(buckets, 'prepaid', 5), /invalid index/);
  assert.throws(() => moveCharge(buckets, 'prepaid', -1), /invalid index/);
  assert.throws(() => moveCharge(buckets, 'collect', 0), /invalid index/);
});

test('bucketTotals: recomputes each side as the exact sum of its lines', () => {
  const totals = bucketTotals({
    prepaid: [line('Ocean freight', 2000), line('BAF', 300.5)],
    collect: [line('THC', 250)],
  });
  assert.equal(totals.prepaidTotal, 2300.5);
  assert.equal(totals.collectTotal, 250);
  assert.equal(totals.prepaidCurrency, 'USD');
  assert.equal(totals.collectCurrency, 'USD');
});

test('move then recompute: totals follow the moved line (Cost/Sell-style invariant)', () => {
  const seeded = seedBuckets({
    freightCharges: [line('Ocean freight', 2000), line('BAF', 300)],
    destinationCharges: [line('THC', 250)],
    prepaidStored: null,
    collectStored: null,
  });
  const before = bucketTotals(seeded);
  assert.equal(before.prepaidTotal, 2300);
  assert.equal(before.collectTotal, 250);

  const moved = moveCharge(seeded, 'prepaid', 1); // move BAF (300) to collect
  const after = bucketTotals(moved);
  assert.equal(after.prepaidTotal, 2000);
  assert.equal(after.collectTotal, 550);
});

test('bucketTotals: empty bucket totals 0 and defaults currency to USD', () => {
  const totals = bucketTotals({ prepaid: [], collect: [line('THC', 250, 'EUR')] });
  assert.equal(totals.prepaidTotal, 0);
  assert.equal(totals.prepaidCurrency, 'USD');
  assert.equal(totals.collectCurrency, 'EUR');
});
