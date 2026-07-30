import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBreakdownLines, type BreakdownLine } from './mergeBreakdown.js';

const now = () => '2026-07-30T00:00:00.000Z';

function apply(
  existing: BreakdownLine[],
  incoming: BreakdownLine[],
  sourceFile: string | null,
  priorTotalOverride: number | null = null,
) {
  return mergeBreakdownLines({
    existing,
    incoming,
    incomingSourceFile: sourceFile,
    priorTotalOverride,
    adjustmentCurrency: 'USD',
    now,
  });
}

function line(name: string, amount: number, sourceFile: string | null): BreakdownLine {
  return { name, amount, currency: 'USD', sourceFile, addedAt: now() };
}

test('first upload adds all lines', () => {
  const { items, total } = apply(
    [],
    [line('Ocean freight', 2000, 'rates.pdf'), line('BAF', 300, 'rates.pdf')],
    'rates.pdf',
  );
  assert.equal(items.length, 2);
  assert.equal(total, 2300);
});

test('re-uploading the SAME file does not duplicate charges', () => {
  const first = apply(
    [],
    [line('Ocean freight', 2000, 'rates.pdf'), line('BAF', 300, 'rates.pdf')],
    'rates.pdf',
  );
  // Same file dropped again → identical incoming, same sourceFile.
  const second = apply(
    first.items,
    [line('Ocean freight', 2000, 'rates.pdf'), line('BAF', 300, 'rates.pdf')],
    'rates.pdf',
  );
  assert.equal(second.items.length, 2, 'should still be 2 lines, not 4');
  assert.equal(second.total, 2300, 'total must not double');
});

test('re-uploading the same file with a CORRECTED amount replaces, not stacks', () => {
  const first = apply([], [line('Ocean freight', 2000, 'rates.pdf')], 'rates.pdf');
  const second = apply(
    first.items,
    [line('Ocean freight', 2100, 'rates.pdf')], // corrected up by 100
    'rates.pdf',
  );
  assert.equal(second.items.length, 1, 'old line replaced, not kept alongside');
  assert.equal(second.total, 2100);
});

test('distinct files each contribute their own lines', () => {
  const first = apply([], [line('Ocean freight', 2000, 'ocean.pdf')], 'ocean.pdf');
  const second = apply(first.items, [line('Trucking', 450, 'drayage.pdf')], 'drayage.pdf');
  assert.equal(second.items.length, 2);
  assert.equal(second.total, 2450);
});

test('exact-duplicate line from a differently-named file is skipped', () => {
  const first = apply([], [line('Ocean freight', 2000, 'ocean.pdf')], 'ocean.pdf');
  // A second file happens to also list the identical ocean-freight charge.
  const second = apply(
    first.items,
    [line('Ocean freight', 2000, 'combined.pdf'), line('Handling', 120, 'combined.pdf')],
    'combined.pdf',
  );
  assert.equal(second.items.length, 2, 'dup ocean freight skipped; handling added');
  assert.equal(second.total, 2120);
});

test('negative discount/credit lines are preserved', () => {
  const { items, total } = apply(
    [],
    [line('Ocean freight', 2000, 'r.pdf'), line('Volume credit', -150, 'r.pdf')],
    'r.pdf',
  );
  assert.equal(items.length, 2);
  assert.equal(total, 1850);
});

test('manual override above sum is preserved as a Previous adjustment on re-apply', () => {
  // Row had one $2000 line but the user manually set ourCost to $2200 (a +200
  // delta not represented by any line). A new file is applied.
  const existing = [line('Ocean freight', 2000, 'old.pdf')];
  const { items, total } = apply(
    existing,
    [line('Documentation', 90, 'new.pdf')],
    'new.pdf',
    2200, // priorTotalOverride
  );
  const adj = items.find((i) => i.name === 'Previous adjustment');
  assert.ok(adj, 'manual override delta snapshotted');
  assert.equal(adj?.amount, 200);
  assert.equal(total, 2000 + 200 + 90);
});

test('empty incoming leaves the existing breakdown untouched', () => {
  const existing = [line('Ocean freight', 2000, 'r.pdf')];
  const { items, total } = apply(existing, [], null);
  assert.equal(items.length, 1);
  assert.equal(total, 2000);
});

test('re-applying the same file three times stays idempotent', () => {
  let state = apply([], [line('Ocean freight', 2000, 'r.pdf'), line('BAF', 300, 'r.pdf')], 'r.pdf');
  for (let i = 0; i < 2; i++) {
    state = apply(
      state.items,
      [line('Ocean freight', 2000, 'r.pdf'), line('BAF', 300, 'r.pdf')],
      'r.pdf',
    );
  }
  assert.equal(state.items.length, 2);
  assert.equal(state.total, 2300);
});
