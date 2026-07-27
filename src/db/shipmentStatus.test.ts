import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  NO_STATUS_FILTER,
  backfillStatusesSql,
  legacyScalarToArray,
  normalizeStatus,
  statusListMatchesFilter,
  toStatusArray,
  toggleStatus,
} from './shipmentStatus.js';

// (a) legacy scalar → single-element array mapping
test('legacyScalarToArray maps a legacy scalar to a canonical single-element array', () => {
  assert.deepEqual(legacyScalarToArray('processing'), ['booking']);
  assert.deepEqual(legacyScalarToArray('shipped'), ['sailed']);
  assert.deepEqual(legacyScalarToArray('pending_invoice'), ['sailed']);
  assert.deepEqual(legacyScalarToArray('pending_payment'), ['invoiced']);
  // A current canonical value passes through unchanged.
  assert.deepEqual(legacyScalarToArray('booking'), ['booking']);
  // Empty / null → the "No status set" empty array.
  assert.deepEqual(legacyScalarToArray(''), []);
  assert.deepEqual(legacyScalarToArray(null), []);
  assert.deepEqual(legacyScalarToArray(undefined), []);
  // Unknown free-text (e.g. an imported sheet's "PAID?") is preserved as-is.
  assert.deepEqual(legacyScalarToArray('PAID?'), ['PAID?']);
});

test('normalizeStatus trims and maps; blanks → null', () => {
  assert.equal(normalizeStatus('  shipped '), 'sailed');
  assert.equal(normalizeStatus('booking'), 'booking');
  assert.equal(normalizeStatus(''), null);
  assert.equal(normalizeStatus('   '), null);
  assert.equal(normalizeStatus(null), null);
});

// (b) exclusivity — the toggle helper
test('toggleStatus adds a real status to the empty array', () => {
  assert.deepEqual(toggleStatus([], 'booking'), ['booking']);
});

test('toggleStatus removing the last real status returns the empty array', () => {
  assert.deepEqual(toggleStatus(['booking'], 'booking'), []);
});

test('toggleStatus keeps multiple real statuses and holds canonical order', () => {
  // Add out of lifecycle order; result stays lifecycle-ordered.
  let list = toggleStatus([], 'invoiced');
  list = toggleStatus(list, 'booking');
  assert.deepEqual(list, ['booking', 'invoiced']);
});

test('"no status" is never stored as a member (blank toggle is a no-op)', () => {
  assert.deepEqual(toggleStatus([], ''), []);
  assert.deepEqual(toggleStatus(['booking'], ''), ['booking']);
  // The empty array itself represents "no status set".
  assert.deepEqual(toStatusArray([]), []);
  assert.deepEqual(toStatusArray(['', null, undefined]), []);
});

test('toStatusArray normalizes, de-dupes, and drops blanks', () => {
  assert.deepEqual(toStatusArray(['shipped', 'sailed', '', 'booking']), ['sailed', 'booking']);
  // Legacy scalar input is accepted too.
  assert.deepEqual(toStatusArray('processing'), ['booking']);
});

// (c) filter "contains" match, incl. empty-array matches "No status"
test('statusListMatchesFilter uses array-contains semantics', () => {
  assert.equal(statusListMatchesFilter(['booking', 'invoiced'], 'invoiced'), true);
  assert.equal(statusListMatchesFilter(['booking', 'invoiced'], 'sailed'), false);
  // '' (All) always matches.
  assert.equal(statusListMatchesFilter(['booking'], ''), true);
  // Legacy value in the filter still resolves via normalization.
  assert.equal(statusListMatchesFilter(['sailed'], 'shipped'), true);
});

test('statusListMatchesFilter — NO_STATUS_FILTER matches only the empty array', () => {
  assert.equal(statusListMatchesFilter([], NO_STATUS_FILTER), true);
  assert.equal(statusListMatchesFilter(['booking'], NO_STATUS_FILTER), false);
  // A real-status filter never matches an empty array.
  assert.equal(statusListMatchesFilter([], 'booking'), false);
});

// (d) the backfill SQL logic
test('backfillStatusesSql maps every legacy value and guards already-set rows', () => {
  const sql = backfillStatusesSql();
  assert.match(sql, /ADD COLUMN|UPDATE shipments/);
  assert.match(sql, /WHEN 'processing' THEN 'booking'/);
  assert.match(sql, /WHEN 'shipped' THEN 'sailed'/);
  assert.match(sql, /WHEN 'pending_invoice' THEN 'sailed'/);
  assert.match(sql, /WHEN 'pending_payment' THEN 'invoiced'/);
  // Only untouched rows carrying a non-empty scalar are seeded (idempotent).
  assert.match(sql, /operational_statuses IS NULL OR operational_statuses = '\[\]'::jsonb/);
  assert.match(sql, /operational_status IS NOT NULL/);
  assert.match(sql, /operational_status <> ''/);
});
