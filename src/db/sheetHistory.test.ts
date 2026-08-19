import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSheetRatesParams } from './sheetHistory.js';

test('parseSheetRatesParams — single value stays a one-item list (back-compat)', () => {
  const q = parseSheetRatesParams({ carrier: 'MSK' });
  assert.deepEqual(q.carriers, ['MSK']);
  assert.equal(q.containers, undefined);
  assert.equal(q.pols, undefined);
  assert.equal(q.pods, undefined);
  assert.equal(q.q, '');
});

test('parseSheetRatesParams — comma-separated multi-select splits into a list', () => {
  const q = parseSheetRatesParams({
    carrier: 'MSK,MSC,CMA',
    container: '20GP,40HC',
    pol: 'Shanghai,Ningbo',
    pod: 'Los Angeles,Long Beach',
  });
  assert.deepEqual(q.carriers, ['MSK', 'MSC', 'CMA']);
  assert.deepEqual(q.containers, ['20GP', '40HC']);
  assert.deepEqual(q.pols, ['Shanghai', 'Ningbo']);
  assert.deepEqual(q.pods, ['Los Angeles', 'Long Beach']);
});

test('parseSheetRatesParams — trims whitespace, drops empties, de-dupes (order kept)', () => {
  const q = parseSheetRatesParams({
    carrier: ' MSK , , MSC ,MSK,  ',
  });
  assert.deepEqual(q.carriers, ['MSK', 'MSC']);
});

test('parseSheetRatesParams — empty / whitespace-only column ⇒ omitted (unfiltered)', () => {
  const q = parseSheetRatesParams({ carrier: '', container: '   ,  ' });
  assert.equal(q.carriers, undefined);
  assert.equal(q.containers, undefined);
});

test('parseSheetRatesParams — non-string params are ignored, not coerced', () => {
  const q = parseSheetRatesParams({
    carrier: ['MSK', 'MSC'] as unknown, // e.g. repeated ?carrier= query params
    pol: 123 as unknown,
  });
  assert.equal(q.carriers, undefined);
  assert.equal(q.pols, undefined);
});

test('parseSheetRatesParams — free-text q is trimmed and preserved alongside lists', () => {
  const q = parseSheetRatesParams({ q: '  shanghai  ', carrier: 'MSK' });
  assert.equal(q.q, 'shanghai');
  assert.deepEqual(q.carriers, ['MSK']);
});

test('parseSheetRatesParams — positive integer limit parsed, junk ignored', () => {
  assert.equal(parseSheetRatesParams({ limit: '200' }).limit, 200);
  assert.equal(parseSheetRatesParams({ limit: '12.9' }).limit, 12);
  assert.equal(parseSheetRatesParams({ limit: '0' }).limit, undefined);
  assert.equal(parseSheetRatesParams({ limit: 'abc' }).limit, undefined);
});
