import assert from 'node:assert/strict';
import test from 'node:test';
import { fillOnlyPatch } from '../db/shipmentBoard.js';
import {
  NEWER_WINS_FIELDS,
  newerWinsDatePatch,
  buildCutoffChangeNote,
} from './shipmentIntakeApply.js';

// The intake merge (mergeFromBriefing) routes cut-off/milestone DATE fields
// through newerWinsDatePatch (overwrite when the new doc differs) and every
// other operational field through fillOnlyPatch/mergeShipmentFillOnly
// (never overwrite a populated cell). These prove the decision layer without
// touching the DB.

test('re-drop with CHANGED cut-off dates updates the stored values', () => {
  const existing = {
    siDate: 'Jul 10',
    cutOffDate: 'Jul 09',
    vgm: 'Jul 08',
    customsCutoffDate: 'Jul 07',
  };
  const incoming = {
    siDate: 'Jul 12', // revised
    cutOffDate: 'Jul 11', // revised
    vgm: 'Jul 10', // revised
    customsCutoffDate: 'Jul 09', // revised
  };
  const patch = newerWinsDatePatch(existing, incoming);
  assert.deepEqual(patch, {
    siDate: 'Jul 12',
    cutOffDate: 'Jul 11',
    vgm: 'Jul 10',
    customsCutoffDate: 'Jul 09',
  });
});

test('a null/omitted incoming value leaves the stored date intact', () => {
  const existing = { siDate: 'Jul 10', cutOffDate: 'Jul 09' };
  const incoming = { siDate: null, cutOffDate: undefined };
  const patch = newerWinsDatePatch(existing, incoming as Record<string, unknown>);
  assert.deepEqual(patch, {});
});

test('an identical incoming value is not re-written', () => {
  const existing = { siDate: 'Jul 10' };
  const incoming = { siDate: 'Jul 10' };
  assert.deepEqual(newerWinsDatePatch(existing, incoming), {});
});

test('customs_cutoff_date fills an empty cell (first value)', () => {
  const existing = { customsCutoffDate: null };
  const incoming = { customsCutoffDate: 'Jul 07' };
  assert.deepEqual(newerWinsDatePatch(existing, incoming), {
    customsCutoffDate: 'Jul 07',
  });
});

test('trucker (fill-only field) is NOT overwritten once populated', () => {
  // trucker is deliberately absent from the newer-wins set...
  assert.ok(!(NEWER_WINS_FIELDS as readonly string[]).includes('trucker'));
  // ...and never re-written even if the new doc reports a different trucker,
  // because fillOnlyPatch skips any cell that already has a value.
  const patch = fillOnlyPatch(
    { trucker: 'Old Haul Co' },
    { trucker: 'New Haul Co' }
  );
  assert.deepEqual(patch, {});
});

test('trucker fill-only DOES populate a previously-empty cell', () => {
  const existing: { trucker: string | null } = { trucker: null };
  const patch = fillOnlyPatch(existing, { trucker: 'Haul Co' });
  assert.deepEqual(patch, { trucker: 'Haul Co' });
});

test('change-note is emitted only for genuinely revised dates, not fills', () => {
  const existing = { siDate: 'Jul 10', customsCutoffDate: null };
  const patch = { siDate: 'Jul 12', customsCutoffDate: 'Jul 07' };
  // siDate was Jul 10 → Jul 12 (a change); customsCutoffDate was empty (a fill).
  const note = buildCutoffChangeNote(existing, patch);
  assert.equal(note, 'SI cut-off updated: Jul 10 → Jul 12');
});

test('no change-note when the patch only fills empty cells', () => {
  const existing = { siDate: null };
  const patch = { siDate: 'Jul 12' };
  assert.equal(buildCutoffChangeNote(existing, patch), null);
});
