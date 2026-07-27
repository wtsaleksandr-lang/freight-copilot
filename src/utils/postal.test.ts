import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePostal } from './postal.js';

test('normalizes a spaced Canadian postal code (canonical passes through)', () => {
  assert.equal(normalizePostal('J1Z 2C2'), 'J1Z 2C2');
});

test('normalizes an unspaced Canadian postal code by inserting the mid space', () => {
  assert.equal(normalizePostal('J1Z2C2'), 'J1Z 2C2');
});

test('uppercases a lowercase Canadian postal code', () => {
  assert.equal(normalizePostal('j1z2c2'), 'J1Z 2C2');
  assert.equal(normalizePostal('j1z 2c2'), 'J1Z 2C2');
});

test('collapses irregular whitespace in a CA postal code', () => {
  assert.equal(normalizePostal('  J1Z   2C2  '), 'J1Z 2C2');
});

test('passes a US ZIP through unchanged', () => {
  assert.equal(normalizePostal('60601'), '60601');
  assert.equal(normalizePostal('60601-1234'), '60601-1234');
});

test('passes non-postal / garbage strings through unchanged', () => {
  assert.equal(normalizePostal('Chicago'), 'Chicago');
  assert.equal(normalizePostal('not a postal code'), 'not a postal code');
  assert.equal(normalizePostal(''), '');
});
