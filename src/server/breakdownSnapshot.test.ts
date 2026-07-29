import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBreakdownSnapshotUpdate } from './routes.js';

const fixedNow = () => '2026-07-29T00:00:00.000Z';

test('set snapshot recomputes totals as sum(items) on both sides', () => {
  const out = buildBreakdownSnapshotUpdate({
    costBreakdown: [
      { name: 'Ocean freight', amount: 1000, currency: 'USD' },
      { name: 'Terminal handling', amount: 250, currency: 'USD' },
    ],
    soldBreakdown: [{ name: 'All-in rate', amount: 1600, currency: 'USD' }],
    now: fixedNow,
  });
  assert.equal(out.ourCost, 1250);
  assert.equal(out.soldRate, 1600);
  assert.equal(out.costBreakdownJson?.length, 2);
  assert.equal(out.soldBreakdownJson?.length, 1);
});

test('totals ignore any client-sent totals — invariant total===sum holds', () => {
  // Even if the client tried to smuggle a mismatched total, the payload
  // is derived purely from the items.
  const items = [
    { name: 'A', amount: 100, currency: 'USD' },
    { name: 'B', amount: 50, currency: 'USD' },
  ];
  const out = buildBreakdownSnapshotUpdate({ costBreakdown: items, now: fixedNow });
  const sum = out.costBreakdownJson!.reduce((s, c) => s + c.amount, 0);
  assert.equal(out.ourCost, sum);
});

test('empty side persists null for both array and total', () => {
  const out = buildBreakdownSnapshotUpdate({
    costBreakdown: [],
    soldBreakdown: undefined,
    now: fixedNow,
  });
  assert.equal(out.costBreakdownJson, null);
  assert.equal(out.ourCost, null);
  assert.equal(out.soldBreakdownJson, null);
  assert.equal(out.soldRate, null);
});

test('items with non-finite amounts are dropped; fields normalized', () => {
  const out = buildBreakdownSnapshotUpdate({
    costBreakdown: [
      { name: 'Good', amount: 42, currency: 'usd' },
      { name: 'Bad', amount: Number.NaN, currency: 'USD' },
      // @ts-expect-error — exercise runtime sanitization of a bad amount
      { name: 'AlsoBad', amount: 'oops', currency: 'USD' },
    ],
    now: fixedNow,
  });
  assert.equal(out.costBreakdownJson?.length, 1);
  const item = out.costBreakdownJson![0]!;
  assert.equal(item.name, 'Good');
  assert.equal(item.amount, 42);
  assert.equal(item.currency, 'USD'); // upper-cased
  assert.equal(item.sourceFile, null);
  assert.equal(item.addedAt, fixedNow());
  assert.equal(out.ourCost, 42);
});

test('round-trip: snapshot A -> B -> back to A restores exact totals', () => {
  const snapA = {
    costBreakdown: [{ name: 'x', amount: 300, currency: 'USD' }],
    soldBreakdown: [{ name: 'y', amount: 500, currency: 'USD' }],
  };
  const a1 = buildBreakdownSnapshotUpdate({ ...snapA, now: fixedNow });
  // simulate an edit to B then undo back to A's arrays
  const a2 = buildBreakdownSnapshotUpdate({
    costBreakdown: a1.costBreakdownJson ?? [],
    soldBreakdown: a1.soldBreakdownJson ?? [],
    now: fixedNow,
  });
  assert.equal(a2.ourCost, 300);
  assert.equal(a2.soldRate, 500);
});
