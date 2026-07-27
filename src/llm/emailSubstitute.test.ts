import test from 'node:test';
import assert from 'node:assert/strict';
import { substituteTokens } from './emailSubstitute.js';
import type { SheetReplyRow } from './generateReply.js';

function row(overrides: Partial<SheetReplyRow>): SheetReplyRow {
  return {
    carrier: 'MAEU',
    pol: 'Shanghai',
    polCode: 'CNSHA',
    pod: 'Los Angeles',
    podCode: 'USLAX',
    containerType: '20GP',
    transitDays: 18,
    detentionFreetimeDays: null,
    demurrageFreetimeDays: null,
    freightTotal: 1000,
    freightCurrency: 'USD',
    freightCharges: [],
    destinationTotal: 250,
    destinationCurrency: 'USD',
    destinationCharges: [{ name: 'THC', amount: 250, currency: 'USD' }],
    validityFrom: '2026-08-01',
    validityTo: '2026-08-31',
    serviceName: null,
    ...overrides,
  };
}

test('scalar tokens fill from the row (no LLM guessing)', () => {
  const out = substituteTokens(
    'POL: <POL> POD: <POD> Carrier: <CARRIER> Transit: <TRANSIT> Validity: <VALIDITY> Client: <CLIENT>',
    [row({})],
    { clientName: 'Acme Co' }
  );
  assert.equal(
    out,
    'POL: Shanghai (CNSHA) POD: Los Angeles (USLAX) Carrier: MAEU Transit: 18 Validity: 2026-08-01 -> 2026-08-31 Client: Acme Co'
  );
});

test('price = freightTotal * (1 + pct/100) + flat, rounded, thousands-grouped', () => {
  // 1000 * 1.10 + 50 = 1150
  const out = substituteTokens('$<PRICE>', [row({ freightTotal: 1000 })], {
    markupPct: 10,
    markupFlat: 50,
  });
  assert.equal(out, '$1,150');
});

test('container-bucket price tokens map 20GP / 40GP / 40HQ correctly', () => {
  const rows = [
    row({ containerType: '20 Dry Standard', freightTotal: 1000 }),
    row({ containerType: '40 Dry Standard', freightTotal: 1800 }),
    row({ containerType: '40 Dry High', freightTotal: 1900 }),
  ];
  const out = substituteTokens(
    '20:$<20GP_PRICE> 40:$<40GP_PRICE> HQ:$<40HQ_PRICE>',
    rows,
    {}
  );
  assert.equal(out, '20:$1,000 40:$1,800 HQ:$1,900');
});

test('<EACH_RATE> expands one line per container in the lane', () => {
  const rows = [
    row({ containerType: '20GP', freightTotal: 1000 }),
    row({ containerType: '40HQ', freightTotal: 1900 }),
  ];
  const out = substituteTokens(
    'Rates:\n<EACH_RATE>  $<PRICE> / <CONTAINER></EACH_RATE>',
    rows,
    {}
  );
  assert.equal(out, 'Rates:\n  $1,000 / 20GP\n  $1,900 / 40HQ');
});

test('<EACH_LANE> expands per lane and resolves per-lane scope', () => {
  const rows = [
    row({ pol: 'Shanghai', polCode: 'CNSHA', pod: 'Los Angeles', podCode: 'USLAX', containerType: '20GP', freightTotal: 1000 }),
    row({ pol: 'Ningbo', polCode: 'CNNGB', pod: 'New York', podCode: 'USNYC', containerType: '40HQ', freightTotal: 2200, carrier: 'MSC' }),
  ];
  const out = substituteTokens(
    '<EACH_LANE><POL> -> <POD> (<CARRIER>): <EACH_RATE>$<PRICE>/<CONTAINER></EACH_RATE></EACH_LANE>',
    rows,
    {}
  );
  assert.equal(
    out,
    'Shanghai (CNSHA) -> Los Angeles (USLAX) (MAEU): $1,000/20GP\n\nNingbo (CNNGB) -> New York (USNYC) (MSC): $2,200/40HQ'
  );
});

test('unknown/no-data tokens resolve blank (never invented)', () => {
  const out = substituteTokens(
    'transit:<TRANSIT>|validity:<VALIDITY>|dest:<DEST_CHARGES>',
    [row({ transitDays: null, validityFrom: null, validityTo: null, destinationTotal: null })],
    {}
  );
  assert.equal(out, 'transit:|validity:|dest:');
});

test('tokens outside the vocabulary are left untouched (not fabricated)', () => {
  const out = substituteTokens('keep <ETD> and <VESSEL> literal', [row({})], {});
  assert.equal(out, 'keep <ETD> and <VESSEL> literal');
});

test('<SURCHARGES> renders one line per applicable surcharge', () => {
  const out = substituteTokens('<SURCHARGES>', [row({})], {
    surcharges: [
      { label: 'Export declaration', amount: 65, currency: 'USD', basis: 'per shipment' },
      { label: 'Overweight surcharge', amount: 275, currency: 'USD' },
      { label: 'Zero (ignored)', amount: 0 },
    ],
  });
  assert.equal(
    out,
    'Export declaration: USD 65 (per shipment)\nOverweight surcharge: USD 275'
  );
});
