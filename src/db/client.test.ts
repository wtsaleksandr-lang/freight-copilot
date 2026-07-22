import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDbPool } from './client.js';

// Graceful shutdown must be safe to call when no pool was ever opened (e.g. a
// process that never served a request) and must resolve without hanging — so
// `node --test` exits cleanly with no open handles.
test('closeDbPool() is a no-op when no pool has been created', async () => {
  await assert.doesNotReject(() => closeDbPool());
  // Idempotent: calling again is still safe.
  await assert.doesNotReject(() => closeDbPool());
});
