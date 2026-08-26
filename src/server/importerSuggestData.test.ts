import test from 'node:test';
import assert from 'node:assert/strict';
import {
  suggestImporterField,
  isSuggestField,
  US_PORTS,
  ISO_COUNTRIES,
  HS_HEADINGS,
} from './importerSuggestData.js';

test('isSuggestField accepts the four known fields and rejects others', () => {
  assert.equal(isSuggestField('entryPort'), true);
  assert.equal(isSuggestField('supplierCountry'), true);
  assert.equal(isSuggestField('hsCode'), true);
  assert.equal(isSuggestField('product'), true);
  assert.equal(isSuggestField('maxLeads'), false);
  assert.equal(isSuggestField(''), false);
  assert.equal(isSuggestField(42), false);
});

test('entryPort suggestions match by name, carry the state hint, and prefix-rank', () => {
  const out = suggestImporterField('entryPort', 'los');
  assert.ok(out.length >= 1);
  assert.equal(out[0]?.value, 'Los Angeles');
  assert.equal(out[0]?.hint, 'CA');
  // A two-letter state query resolves too.
  const tx = suggestImporterField('entryPort', 'tx');
  assert.ok(tx.every((r) => r.hint === 'TX'));
  assert.ok(tx.some((r) => r.value === 'Houston'));
});

test('supplierCountry matches by name or ISO code and returns the code as hint', () => {
  const byName = suggestImporterField('supplierCountry', 'viet');
  assert.equal(byName[0]?.value, 'Vietnam');
  assert.equal(byName[0]?.hint, 'VN');
  const byCode = suggestImporterField('supplierCountry', 'cn');
  assert.ok(byCode.some((r) => r.value === 'China'));
});

test('hsCode: plain-English aliases resolve to the right heading code', () => {
  const sneakers = suggestImporterField('hsCode', 'sneakers');
  assert.equal(sneakers[0]?.value, '6404');
  const sofa = suggestImporterField('hsCode', 'sofa');
  assert.ok(sofa.some((r) => r.value === '9401'));
  // Typing a numeric code prefix surfaces that heading first.
  const byCode = suggestImporterField('hsCode', '9405');
  assert.equal(byCode[0]?.value, '9405');
  assert.match(byCode[0]?.label ?? '', /lamp|light/i);
});

test('product keyword field matches common commodities', () => {
  const out = suggestImporterField('product', 'led');
  assert.ok(out.some((r) => r.value === 'led lighting'));
});

test('empty query returns a bounded, non-empty default list per field', () => {
  for (const f of ['entryPort', 'supplierCountry', 'hsCode', 'product'] as const) {
    const out = suggestImporterField(f, '');
    assert.ok(out.length > 0 && out.length <= 8, `${f} default list should be 1..8 rows`);
  }
});

test('limit is clamped and never exceeds the requested cap', () => {
  const out = suggestImporterField('supplierCountry', '', 5);
  assert.ok(out.length <= 5);
});

test('reference lists have no duplicate HS codes and are non-trivially sized', () => {
  assert.ok(US_PORTS.length >= 20);
  assert.ok(ISO_COUNTRIES.length >= 100);
  assert.ok(HS_HEADINGS.length >= 100);
  const codes = HS_HEADINGS.map((h) => h.code);
  assert.equal(new Set(codes).size, codes.length, 'HS heading codes must be unique');
});
