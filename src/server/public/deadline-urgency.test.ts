import { test } from 'node:test';
import assert from 'node:assert/strict';

// deadline-urgency.js is a side-effect module: it publishes the pure mapping
// on `globalThis.LoadModeDeadlineUrgency` (same source the browser loads as a
// classic script). Import it, then read the global.
import './deadline-urgency.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DU = (globalThis as any).LoadModeDeadlineUrgency as {
  DATE_URGENT_DAYS: number;
  DATE_SOON_DAYS: number;
  daysUntil: (v: unknown, today?: Date) => number | null;
  deadlineUrgencyClass: (v: unknown, today?: Date) => string;
};

// Fixed "today" (local midnight) so the mapping is fully deterministic —
// deadline strings are ISO 'YYYY-MM-DD', also parsed as local dates, so no
// timezone drift between the two.
const TODAY = new Date(2026, 6, 27); // 2026-07-27

test('daysUntil counts whole calendar days from a fixed today', () => {
  assert.equal(DU.daysUntil('2026-07-27', TODAY), 0);
  assert.equal(DU.daysUntil('2026-07-26', TODAY), -1);
  assert.equal(DU.daysUntil('2026-07-28', TODAY), 1);
  assert.equal(DU.daysUntil('2026-08-03', TODAY), 7);
  assert.equal(DU.daysUntil('2026-08-26', TODAY), 30);
});

test('daysUntil returns null for empty / unparseable values', () => {
  assert.equal(DU.daysUntil('', TODAY), null);
  assert.equal(DU.daysUntil(null, TODAY), null);
  assert.equal(DU.daysUntil(undefined, TODAY), null);
  assert.equal(DU.daysUntil('not-a-date', TODAY), null);
});

test('deadlineUrgencyClass maps proximity to the right tier', () => {
  // overdue — anything in the past
  assert.equal(DU.deadlineUrgencyClass('2026-07-26', TODAY), 'is-date-overdue'); // -1
  assert.equal(DU.deadlineUrgencyClass('2026-07-20', TODAY), 'is-date-overdue'); // -7

  // urgent — today through +2 (inclusive)
  assert.equal(DU.deadlineUrgencyClass('2026-07-27', TODAY), 'is-date-urgent'); // 0 (today)
  assert.equal(DU.deadlineUrgencyClass('2026-07-28', TODAY), 'is-date-urgent'); // +1
  assert.equal(DU.deadlineUrgencyClass('2026-07-29', TODAY), 'is-date-urgent'); // +2 boundary

  // soon — +3 through +7 (inclusive)
  assert.equal(DU.deadlineUrgencyClass('2026-07-30', TODAY), 'is-date-soon'); // +3 boundary
  assert.equal(DU.deadlineUrgencyClass('2026-08-03', TODAY), 'is-date-soon'); // +7 boundary

  // far / none — beyond +7 or no date
  assert.equal(DU.deadlineUrgencyClass('2026-08-04', TODAY), ''); // +8
  assert.equal(DU.deadlineUrgencyClass('2026-08-26', TODAY), ''); // +30
  assert.equal(DU.deadlineUrgencyClass('', TODAY), '');
  assert.equal(DU.deadlineUrgencyClass(null, TODAY), '');
});

test('threshold constants are the documented defaults', () => {
  assert.equal(DU.DATE_URGENT_DAYS, 2);
  assert.equal(DU.DATE_SOON_DAYS, 7);
});
