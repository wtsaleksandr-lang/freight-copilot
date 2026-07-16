import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateRateFreshness } from './quoteValidation.js';

const now = new Date('2026-07-16T12:00:00Z');

test('rate within stated validity is green', () => {
  const result = evaluateRateFreshness({
    validUntil: '2026-08-15',
    parsedAt: '2026-07-15T12:00:00Z',
    now,
  });
  assert.equal(result.status, 'fresh');
  assert.equal(result.color, 'green');
});

test('rate expiring within seven days is yellow', () => {
  const result = evaluateRateFreshness({
    validUntil: '2026-07-20',
    parsedAt: '2026-07-15T12:00:00Z',
    now,
  });
  assert.equal(result.status, 'expiring_soon');
  assert.equal(result.color, 'yellow');
});

test('expired rate is red', () => {
  const result = evaluateRateFreshness({
    validUntil: '2026-07-10',
    parsedAt: '2026-07-01T12:00:00Z',
    now,
  });
  assert.equal(result.status, 'expired');
  assert.equal(result.color, 'red');
});

test('old source without validity is likely stale and red', () => {
  const result = evaluateRateFreshness({
    validUntil: null,
    parsedAt: '2026-05-01T12:00:00Z',
    now,
  });
  assert.equal(result.status, 'likely_stale');
  assert.equal(result.color, 'red');
});

test('missing validity and source date is gray', () => {
  const result = evaluateRateFreshness({ validUntil: null, parsedAt: null, now });
  assert.equal(result.status, 'unknown');
  assert.equal(result.color, 'gray');
});
