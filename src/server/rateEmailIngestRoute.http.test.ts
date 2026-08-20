import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { registerRateEmailIngestRoute } from './rateEmailIngestRoute.js';

// These cases exercise the auth + body-parsing layers only — they return before
// any AI/DB call, so they are deterministic without a database or a provider.
// The persistence + extraction pipeline is covered in rateEmailIngest.test.ts.
const TOKEN = 'test-ingest-secret';

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  process.env.RATE_EMAIL_INGEST_TOKEN = TOKEN;
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  registerRateEmailIngestRoute(app);
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('missing token → 404 (endpoint existence not advertised)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/rates/ingest-email`, {
      method: 'POST',
      headers: { 'content-type': 'message/rfc822' },
      body: 'Subject: x\r\n\r\nbody',
    });
    assert.equal(res.status, 404);
  });
});

test('wrong token → 404', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/rates/ingest-email`, {
      method: 'POST',
      headers: { 'content-type': 'message/rfc822', 'x-rate-ingest-token': 'nope' },
      body: 'Subject: x\r\n\r\nbody',
    });
    assert.equal(res.status, 404);
  });
});

test('correct token + empty raw MIME body → 400', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/rates/ingest-email`, {
      method: 'POST',
      headers: { 'content-type': 'message/rfc822', 'x-rate-ingest-token': TOKEN },
      body: '   ',
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.status, 'error');
  });
});

test('correct token via Bearer + JSON with blank raw → 400', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/rates/ingest-email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ raw: '', filename: 'q.eml' }),
    });
    assert.equal(res.status, 400);
  });
});
