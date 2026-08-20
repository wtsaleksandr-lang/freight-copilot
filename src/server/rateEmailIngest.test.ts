import test from 'node:test';
import assert from 'node:assert/strict';
import type { RateSheetResult } from '../llm/parseRateSheet.js';
import type { SheetUploadInput } from '../db/sheetHistory.js';
import {
  runEmailRateIngest,
  sellRowsFromParsed,
  isRateQuote,
  tokenMatches,
  SELL_RATE_NOTE,
  type IngestDeps,
} from './rateEmailIngestRoute.js';

const CRLF = '\r\n';

/** A minimal, schema-valid parsed ocean rate sheet with one lane / one rate. */
function oceanQuote(overrides: Partial<RateSheetResult> = {}): RateSheetResult {
  return {
    carrier_code: 'MSK',
    carrier_name_raw: 'Maersk',
    validity_from: '2026-08-01',
    validity_to: '2026-08-31',
    document_type: 'rate_sheet',
    notes: null,
    lanes: [
      {
        origin: 'Shanghai',
        origin_code: 'CNSHA',
        destination: 'Los Angeles',
        destination_code: 'USLAX',
        service_name: 'TP1',
        vessel_voyage: null,
        transit_days: 15,
        detention_freetime_days: null,
        demurrage_freetime_days: null,
        rates_per_container: [
          {
            container_type: '40HC',
            freight_charges: [{ name: 'Ocean freight', amount: 2450, currency: 'USD' }],
            freight_total: 2450,
            freight_currency: 'USD',
            destination_charges: [],
            destination_total: null,
            destination_currency: null,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function rawEmail(messageId: string, subject = 'Your ocean quote'): string {
  return [
    'From: Alex <alex@loadmode.com>',
    'To: customer@acme.com',
    `Subject: ${subject}`,
    ...(messageId ? [`Message-ID: <${messageId}>`] : []),
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Please find our quote attached: Shanghai → Los Angeles 40HC USD 2450.',
  ].join(CRLF);
}

/** Build injectable deps with a captured save + configurable dedupe/parse. */
function makeDeps(over: Partial<IngestDeps> = {}): IngestDeps & { saved: SheetUploadInput[] } {
  const saved: SheetUploadInput[] = [];
  const deps: IngestDeps & { saved: SheetUploadInput[] } = {
    saved,
    parse: async () => oceanQuote(),
    findByMessageId: async () => null,
    save: async (input) => {
      saved.push(input);
      return 4242;
    },
    genRefId: () => 'EM-TEST-0001',
    ...over,
  };
  return deps;
}

test('sellRowsFromParsed flags every row sell/email_bcc with the disclaimer note', () => {
  const rows = sellRowsFromParsed(oceanQuote(), 'Your ocean quote');
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.rateType, 'sell');
  assert.equal(r.sourceType, 'email_bcc');
  assert.equal(r.sourceNote, SELL_RATE_NOTE);
  // The ocean fields are extracted identically to the file path.
  assert.equal(r.carrierCode, 'MSK');
  assert.equal(r.pol, 'Shanghai');
  assert.equal(r.pod, 'Los Angeles');
  assert.equal(r.containerType, '40HC');
  assert.equal(r.freightTotal, 2450);
  assert.equal(r.freightCurrency, 'USD');
});

test('isRateQuote: rate_sheet with rows = true; inquiry / empty = false', () => {
  assert.equal(isRateQuote(oceanQuote()), true);
  assert.equal(isRateQuote(oceanQuote({ document_type: 'quote_request' })), false);
  assert.equal(isRateQuote(oceanQuote({ document_type: 'other' })), false);
  assert.equal(isRateQuote(oceanQuote({ lanes: [] })), false);
});

test('ingested path persists a synthetic email_bcc upload with sell rows', async () => {
  const deps = makeDeps();
  const result = await runEmailRateIngest({ raw: rawEmail('msg-1@loadmode.com') }, deps);
  assert.equal(result.status, 'ingested');
  assert.equal(result.rateCount, 1);
  assert.equal(result.uploadId, 4242);
  assert.equal(result.refId, 'EM-TEST-0001');

  assert.equal(deps.saved.length, 1);
  const upload = deps.saved[0]!;
  assert.equal(upload.sourceType, 'email_bcc');
  assert.equal(upload.sourceMessageId, 'msg-1@loadmode.com');
  assert.equal(upload.rows.length, 1);
  assert.equal(upload.rows[0]!.rateType, 'sell');
  assert.equal(upload.rows[0]!.sourceNote, SELL_RATE_NOTE);
  // Source filename falls back to the subject when no explicit filename given.
  assert.equal(upload.rows[0]!.sourceFilename, 'Your ocean quote');
});

test('dedupe: a re-delivered Message-ID skips re-ingest and never saves', async () => {
  let saveCalls = 0;
  const deps = makeDeps({
    findByMessageId: async (id) =>
      id === 'dup-1@loadmode.com' ? { id: 99, refId: 'EM-EXISTING' } : null,
    save: async () => {
      saveCalls++;
      return 1;
    },
  });
  const result = await runEmailRateIngest({ raw: rawEmail('dup-1@loadmode.com') }, deps);
  assert.equal(result.status, 'duplicate');
  assert.equal(result.uploadId, 99);
  assert.equal(result.refId, 'EM-EXISTING');
  assert.equal(saveCalls, 0);
});

test('not_a_quote: a non-rate email persists nothing', async () => {
  let saveCalls = 0;
  const deps = makeDeps({
    parse: async () => oceanQuote({ document_type: 'quote_request', lanes: [] }),
    save: async () => {
      saveCalls++;
      return 1;
    },
  });
  const result = await runEmailRateIngest({ raw: rawEmail('inq-1@loadmode.com') }, deps);
  assert.equal(result.status, 'not_a_quote');
  assert.equal(saveCalls, 0);
});

test('tokenMatches: constant-time equality, rejects mismatch / empty secret', () => {
  assert.equal(tokenMatches('s3cret-token', 's3cret-token'), true);
  assert.equal(tokenMatches('wrong', 's3cret-token'), false);
  assert.equal(tokenMatches('', 's3cret-token'), false);
  assert.equal(tokenMatches('anything', ''), false); // unset server secret ⇒ disabled
  assert.equal(tokenMatches('short', 'longer-secret'), false); // length mismatch
});
