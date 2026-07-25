import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { storeShipmentAttachment, readAttachmentBytes } from './keptFileStore.js';

// With no R2 env, attachments fall back to the historical shipments-files/ disk
// layout. This proves the store → serve round-trip and the URL routing.
test('shipment attachment: disk round-trip + URL routing when R2 is not configured', async () => {
  const saved = {
    R2_ENDPOINT: process.env.R2_ENDPOINT,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
  };
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_BUCKET_NAME;
  try {
    const stored = await storeShipmentAttachment({
      refId: 'TEST-RT',
      objectName: '1-doc.txt',
      bytes: Buffer.from('hello world'),
      contentType: 'text/plain',
    });
    assert.equal(stored.backend, 'disk');
    assert.equal(stored.servedUrl, '/shipments-files/TEST-RT/1-doc.txt');

    const got = await readAttachmentBytes(stored.servedUrl);
    assert.equal(got?.toString('utf8'), 'hello world');

    // Unrecognised / empty URLs never resolve to a file.
    assert.equal(await readAttachmentBytes(''), null);
    assert.equal(await readAttachmentBytes('/not/a/known/shape'), null);
    // An R2-style URL with no R2 configured returns null (nothing to read).
    assert.equal(await readAttachmentBytes('/api/kept-file?key=loadmode/shipments/x/1.txt'), null);
  } finally {
    await rm(resolve(process.cwd(), 'shipments-files', 'TEST-RT'), { recursive: true, force: true }).catch(() => {});
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
