// Mis-drop safety net — the intake/library parsers must surface a
// `documentType` (rate_sheet | quote_request | other) classifier so the
// frontend can offer to re-route a mis-dropped file.
//
// These tests prove:
//   1. parseDrayageIntake + parseIntake (ocean) carry the classifier through
//      when the model returns one, and default sensibly when it omits it.
//   2. parseDrayageRates carries its top-level document_type through.
//   3. The rate-library route threads `documentType` into its JSON responses
//      (static guard — the route file is Express wiring that needs a DB).
//
// The AI transport is stubbed at globalThis.fetch — no real API calls. The
// default AI config (Gemini) is forced exactly as in callAiTool.test.ts by
// pointing DATABASE_URL at an unreachable host so the DB settings read fails
// and getAiConfig() falls back to the built-in Gemini preset.

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseDrayageIntake } from './parseDrayageIntake.js';
import { parseIntake } from './parseIntake.js';
import { parseDrayageRates } from './parseDrayageRates.js';

const GEMINI_HOST = 'generativelanguage.googleapis.com';

const realFetch = globalThis.fetch;
const savedEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
};

// The tool args the stubbed model "returns" for the next parser call.
let nextToolArgs: Record<string, unknown> = {};

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && 'url' in input)
    return String((input as { url: unknown }).url);
  return String(input);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  nextToolArgs = {};
  process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:1/none';
  process.env.GEMINI_API_KEY = 'gm-test-key';
  process.env.ANTHROPIC_API_KEY = 'sk-test-key';

  globalThis.fetch = (async (input: unknown) => {
    const url = urlOf(input);
    if (url.includes(GEMINI_HOST)) {
      // Gemini tool-call shape: functionCall.args carries the tool input.
      return json({
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: 'tool', args: nextToolArgs } },
              ],
            },
          },
        ],
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('parseDrayageIntake carries documentType=rate_sheet through', async () => {
  nextToolArgs = {
    cargoType: null,
    containerType: null,
    containerCount: null,
    weightKg: null,
    originType: null,
    destinationType: null,
    specialEquipment: [],
    accessorials: [],
    readiness: { status: 'needs_review', reason: 'mis-drop test' },
    documentType: 'rate_sheet',
  };
  const out = await parseDrayageIntake({
    content: [{ type: 'text', text: 'drayage rate sheet' }],
  });
  assert.equal(out.documentType, 'rate_sheet');
});

test('parseDrayageIntake defaults documentType to quote_request when the model omits it', async () => {
  nextToolArgs = {
    cargoType: null,
    containerType: null,
    containerCount: null,
    weightKg: null,
    originType: null,
    destinationType: null,
    specialEquipment: [],
    accessorials: [],
    readiness: { status: 'needs_review', reason: 'no classifier' },
    // documentType intentionally omitted
  };
  const out = await parseDrayageIntake({
    content: [{ type: 'text', text: 'a client request' }],
  });
  assert.equal(out.documentType, 'quote_request');
});

test('parseIntake (ocean) carries documentType=rate_sheet through', async () => {
  nextToolArgs = {
    cargoType: null,
    from: null,
    fromRegion: null,
    to: null,
    toRegion: null,
    originType: null,
    destinationType: null,
    container: null,
    weight: null,
    commodity: null,
    notes: null,
    confidence: 'high',
    documentType: 'rate_sheet',
  };
  const out = await parseIntake({
    content: [{ type: 'text', text: 'ocean rate sheet' }],
  });
  assert.equal(out.documentType, 'rate_sheet');
});

test('parseIntake (ocean) defaults documentType to quote_request when omitted', async () => {
  nextToolArgs = {
    cargoType: null,
    from: null,
    fromRegion: null,
    to: null,
    toRegion: null,
    originType: null,
    destinationType: null,
    container: null,
    weight: null,
    commodity: null,
    notes: null,
    confidence: 'medium',
  };
  const out = await parseIntake({
    content: [{ type: 'text', text: 'a client request' }],
  });
  assert.equal(out.documentType, 'quote_request');
});

test('parseDrayageRates carries document_type=quote_request through (mis-dropped request, no rates)', async () => {
  nextToolArgs = { rates: [], document_type: 'quote_request' };
  const out = await parseDrayageRates([
    {
      mediaType: 'text/plain',
      filename: 'request.txt',
      textContent: 'Please quote drayage from APM Newark to Chicago.',
    },
  ]);
  assert.deepEqual(out.rates, []);
  assert.equal(out.document_type, 'quote_request');
});

test('parseDrayageRates defaults document_type to rate_sheet when omitted', async () => {
  nextToolArgs = { rates: [] };
  const out = await parseDrayageRates([
    {
      mediaType: 'text/plain',
      filename: 'sheet.txt',
      textContent: 'Newark -> Chicago 40HC $850',
    },
  ]);
  assert.equal(out.document_type, 'rate_sheet');
});

test('rate-library route threads documentType into its JSON responses (static guard)', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const routes = await readFile(join(here, '../server/routes.ts'), 'utf8');
  // The dry-run and empty-result branches of /api/drayage-rate-library/parse
  // must both surface the classifier so the frontend offer can fire.
  assert.ok(
    routes.includes('const documentType = result.document_type ?? null'),
    'library route must derive documentType from the parser result',
  );
  assert.ok(
    routes.includes('res.json({ rates: previewRates, documentType })'),
    'dry-run response must include documentType',
  );
  assert.match(
    routes,
    /inserted: 0,\s*rates: \[\],\s*documentType,/,
    'empty-result response must include documentType',
  );
});
