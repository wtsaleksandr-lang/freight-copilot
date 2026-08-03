import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  NO_STATUS_FILTER,
  STATUS_VALUES,
  backfillStatusesSql,
  collapseMultiStatusSql,
  deriveStatusFromMilestones,
  legacyScalarToArray,
  mergeAutoStatus,
  normalizeStatus,
  statusListMatchesFilter,
  toStatusArray,
  toggleStatus,
} from './shipmentStatus.js';

test('the curated set is exactly the three statuses', () => {
  assert.deepEqual([...STATUS_VALUES], ['booking', 'loaded', 'invoiced']);
});

// (a) legacy scalar → single-element array mapping. The retired statuses
// (sailed / pending_* / shipped) collapse into `loaded`; `invoiced` is now its
// own canonical value and passes through unchanged.
test('legacyScalarToArray maps a legacy scalar to a canonical single-element array', () => {
  assert.deepEqual(legacyScalarToArray('processing'), ['booking']);
  assert.deepEqual(legacyScalarToArray('shipped'), ['loaded']);
  assert.deepEqual(legacyScalarToArray('pending_invoice'), ['loaded']);
  assert.deepEqual(legacyScalarToArray('pending_payment'), ['loaded']);
  assert.deepEqual(legacyScalarToArray('sailed'), ['loaded']);
  // `invoiced` is a canonical status now — NOT collapsed to loaded.
  assert.deepEqual(legacyScalarToArray('invoiced'), ['invoiced']);
  // A current canonical value passes through unchanged.
  assert.deepEqual(legacyScalarToArray('booking'), ['booking']);
  assert.deepEqual(legacyScalarToArray('loaded'), ['loaded']);
  // Empty / null → the "No status set" empty array.
  assert.deepEqual(legacyScalarToArray(''), []);
  assert.deepEqual(legacyScalarToArray(null), []);
  assert.deepEqual(legacyScalarToArray(undefined), []);
  // Unknown free-text (e.g. an imported sheet's "PAID?") is preserved as-is.
  assert.deepEqual(legacyScalarToArray('PAID?'), ['PAID?']);
});

test('normalizeStatus trims and maps; blanks → null', () => {
  assert.equal(normalizeStatus('  shipped '), 'loaded');
  assert.equal(normalizeStatus('sailed'), 'loaded');
  assert.equal(normalizeStatus('invoiced'), 'invoiced');
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
  let list = toggleStatus([], 'loaded');
  list = toggleStatus(list, 'booking');
  assert.deepEqual(list, ['booking', 'loaded']);
});

test('"no status" is never stored as a member (blank toggle is a no-op)', () => {
  assert.deepEqual(toggleStatus([], ''), []);
  assert.deepEqual(toggleStatus(['booking'], ''), ['booking']);
  assert.deepEqual(toStatusArray([]), []);
  assert.deepEqual(toStatusArray(['', null, undefined]), []);
});

test('toStatusArray normalizes, de-dupes, and drops blanks', () => {
  // shipped + sailed both → loaded, de-duped.
  assert.deepEqual(toStatusArray(['shipped', 'sailed', '', 'booking']), ['loaded', 'booking']);
  assert.deepEqual(toStatusArray('processing'), ['booking']);
});

// (c) filter "contains" match, incl. empty-array matches "No status"
test('statusListMatchesFilter uses array-contains semantics', () => {
  assert.equal(statusListMatchesFilter(['booking', 'loaded'], 'loaded'), true);
  assert.equal(statusListMatchesFilter(['booking'], 'loaded'), false);
  // '' (All) always matches.
  assert.equal(statusListMatchesFilter(['booking'], ''), true);
  // Legacy value in the filter still resolves via normalization (sailed → loaded).
  assert.equal(statusListMatchesFilter(['sailed'], 'loaded'), true);
  // `invoiced` is its own status: a loaded row does NOT match the invoiced filter.
  assert.equal(statusListMatchesFilter(['loaded'], 'invoiced'), false);
  assert.equal(statusListMatchesFilter(['invoiced'], 'invoiced'), true);
});

test('statusListMatchesFilter — NO_STATUS_FILTER matches only the empty array', () => {
  assert.equal(statusListMatchesFilter([], NO_STATUS_FILTER), true);
  assert.equal(statusListMatchesFilter(['booking'], NO_STATUS_FILTER), false);
  assert.equal(statusListMatchesFilter([], 'booking'), false);
});

// (d) the backfill SQL logic — every legacy value now collapses to the two.
test('backfillStatusesSql maps every legacy value and guards already-set rows', () => {
  const sql = backfillStatusesSql();
  assert.match(sql, /UPDATE shipments/);
  assert.match(sql, /WHEN 'processing' THEN 'booking'/);
  assert.match(sql, /WHEN 'shipped' THEN 'loaded'/);
  assert.match(sql, /WHEN 'pending_invoice' THEN 'loaded'/);
  assert.match(sql, /WHEN 'pending_payment' THEN 'loaded'/);
  assert.match(sql, /WHEN 'sailed' THEN 'loaded'/);
  // `invoiced` is no longer a legacy alias — it must NOT be remapped to loaded,
  // so a legacy `invoiced` scalar backfills to ['invoiced'] via the ELSE branch.
  assert.doesNotMatch(sql, /WHEN 'invoiced'/);
  assert.match(sql, /operational_statuses IS NULL OR operational_statuses = '\[\]'::jsonb/);
  assert.match(sql, /operational_status IS NOT NULL/);
  assert.match(sql, /operational_status <> ''/);
});

// (d2) the multi-status collapse backfill
test('collapseMultiStatusSql collapses multi/legacy rows to a single status', () => {
  const sql = collapseMultiStatusSql();
  assert.match(sql, /UPDATE shipments/);
  // An invoiced-tier member anywhere → single ['invoiced'] (furthest along).
  assert.match(sql, /THEN '\["invoiced"\]'::jsonb/);
  // A loaded-tier member anywhere → single ['loaded'].
  assert.match(sql, /operational_statuses @> '\["loaded"\]'::jsonb/);
  assert.match(sql, /operational_statuses @> '\["sailed"\]'::jsonb/);
  assert.match(sql, /THEN '\["loaded"\]'::jsonb/);
  // Otherwise a booking-tier member → single ['booking'].
  assert.match(sql, /operational_statuses @> '\["booking"\]'::jsonb/);
  assert.match(sql, /THEN '\["booking"\]'::jsonb/);
  // Only rows that need it: length > 1, or still holding a retired value.
  assert.match(sql, /jsonb_array_length\(operational_statuses\) > 1/);
  // Invoiced is checked FIRST so ['loaded','invoiced'] → ['invoiced']; loaded
  // is checked before booking so ['booking','loaded'] → ['loaded'].
  assert.ok(
    sql.indexOf(`THEN '["invoiced"]'`) < sql.indexOf(`THEN '["loaded"]'`),
    'invoiced-tier branch must precede loaded-tier so invoiced wins'
  );
  assert.ok(
    sql.indexOf(`'["loaded"]'::jsonb`) < sql.indexOf(`THEN '["booking"]'`),
    'loaded-tier branch must precede booking-tier so loaded wins'
  );
  // CRITICAL: `invoiced` must NOT appear in the force-collapse WHERE list, else
  // the boot self-heal would re-collapse a clean ['invoiced'] row every restart.
  // The `@> '["invoiced"]'` guard therefore appears EXACTLY ONCE — in the CASE
  // WHEN only — proving the WHERE clause never forces a clean invoiced row.
  const invoicedGuards = sql.match(/@> '\["invoiced"\]'::jsonb/g) || [];
  assert.equal(invoicedGuards.length, 1, 'invoiced must be guarded once (CASE only, not WHERE)');
});

// (e) AI auto-assign from milestones
const done = (label: string) => ({ label, state: 'done' });
const pending = (label: string) => ({ label, state: 'pending' });

test('deriveStatusFromMilestones: booking-confirmed → booking', () => {
  assert.equal(deriveStatusFromMilestones([done('Booking confirmed')]), 'booking');
});

test('deriveStatusFromMilestones: a loaded-tier milestone → loaded', () => {
  assert.equal(deriveStatusFromMilestones([done('Cargo loaded')]), 'loaded');
  assert.equal(deriveStatusFromMilestones([done('VGM filed')]), 'loaded');
  assert.equal(deriveStatusFromMilestones([done('Vessel departed')]), 'loaded');
});

test('deriveStatusFromMilestones: an invoiced-tier milestone → invoiced', () => {
  assert.equal(deriveStatusFromMilestones([done('Invoiced')]), 'invoiced');
  assert.equal(deriveStatusFromMilestones([done('Invoice issued')]), 'invoiced');
  assert.equal(deriveStatusFromMilestones([done('Payment received')]), 'invoiced');
});

test('deriveStatusFromMilestones: furthest-along wins when several present', () => {
  assert.equal(
    deriveStatusFromMilestones([done('Booking confirmed'), done('Cargo loaded')]),
    'loaded'
  );
  // invoiced outranks loaded
  assert.equal(
    deriveStatusFromMilestones([done('Cargo loaded'), done('Invoiced')]),
    'invoiced'
  );
});

test('deriveStatusFromMilestones: only DONE milestones count', () => {
  assert.equal(deriveStatusFromMilestones([pending('Cargo loaded')]), null);
  assert.equal(
    deriveStatusFromMilestones([done('Booking confirmed'), pending('Cargo loaded')]),
    'booking'
  );
});

test('deriveStatusFromMilestones: nothing mappable → null', () => {
  assert.equal(deriveStatusFromMilestones([]), null);
  assert.equal(deriveStatusFromMilestones([done('Some unrelated note')]), null);
  assert.equal(deriveStatusFromMilestones(null), null);
});

test('mergeAutoStatus: upgrades booking → loaded', () => {
  assert.deepEqual(mergeAutoStatus(['booking'], 'loaded'), ['loaded']);
});

test('mergeAutoStatus: upgrades loaded → invoiced (invoiced is furthest along)', () => {
  assert.deepEqual(mergeAutoStatus(['loaded'], 'invoiced'), ['invoiced']);
});

test('mergeAutoStatus: never downgrades loaded → booking', () => {
  assert.deepEqual(mergeAutoStatus(['loaded'], 'booking'), ['loaded']);
});

test('mergeAutoStatus: never downgrades invoiced → loaded', () => {
  assert.deepEqual(mergeAutoStatus(['invoiced'], 'loaded'), ['invoiced']);
});

test('mergeAutoStatus: null derived leaves current untouched', () => {
  assert.deepEqual(mergeAutoStatus(['booking'], null), ['booking']);
  assert.deepEqual(mergeAutoStatus([], null), []);
});

test('mergeAutoStatus: assigns onto an empty status', () => {
  assert.deepEqual(mergeAutoStatus([], 'booking'), ['booking']);
  assert.deepEqual(mergeAutoStatus([], 'loaded'), ['loaded']);
});

test('mergeAutoStatus: normalizes a legacy stored value before comparing', () => {
  // stored 'sailed' normalizes to 'loaded' (rank 2); a booking derive must not downgrade it.
  assert.deepEqual(mergeAutoStatus(['sailed'], 'booking'), ['loaded']);
});
