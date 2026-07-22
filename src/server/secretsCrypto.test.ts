import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMasterKey } from './secretsCrypto.js';

test('parseMasterKey accepts a 32-byte hex key', () => {
  const key = parseMasterKey('ab'.repeat(32));
  assert.equal(key.length, 32);
});

test('parseMasterKey accepts a 32-byte base64 key', () => {
  const source = Buffer.alloc(32, 7);
  const key = parseMasterKey(source.toString('base64'));
  assert.deepEqual(key, source);
});

test('parseMasterKey rejects invalid values', () => {
  assert.throws(() => parseMasterKey('too-short'), /32-byte/);
});
