import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRateToPercent, calculateDuty, getBestTreatment, calculateCanadaCustoms, searchHs } from './customsCalc.js';

test('rate parser recognises the CBSA formats', () => {
  assert.equal(parseRateToPercent('Free').description, 'Free');
  assert.equal(parseRateToPercent('6.5%').percent, 6.5);
  assert.equal(parseRateToPercent('6.5%').compound, false);
  assert.equal(parseRateToPercent('N/A').isNA, true);
  assert.equal(parseRateToPercent('6.5% but not less than 5.5¢/kg').compound, true);
  assert.equal(parseRateToPercent('$2.00/kg').perUnit, '$2.00/kg');
});

test('best treatment: any Free wins outright, else lowest-priority preferential', () => {
  // Free under UST short-circuits even though MFN has a rate.
  const a = getBestTreatment(['MFN', 'UST'], { MFN: '6.5%', UST: 'Free' });
  assert.equal(a.treatment, 'UST');
  assert.equal(a.rate, 'Free');
  // No Free anywhere: MFN 6.5% stays because the preferential is higher.
  const b = getBestTreatment(['MFN', 'GPT'], { MFN: '6.5%', GPT: '5%' });
  assert.equal(b.treatment, 'GPT'); // GPT priority(22) < MFN(24) and non-compound
});

test('duty math: ad-valorem, Free, and specific per-kg', () => {
  assert.equal(calculateDuty('6.5%', 10000, 0).duty, 650);
  assert.equal(calculateDuty('Free', 10000, 0).duty, 0);
  assert.equal(calculateDuty('$2.00/kg', 0, 500).duty, 1000);
  // N/A flags manual review.
  assert.equal(calculateDuty('N/A', 10000, 0).requiresManualReview, true);
});

test('calculate: unknown HS code is reported, not crashed', () => {
  const r = calculateCanadaCustoms({ hsCode: '9999.99.99', countryOfOrigin: 'China', valueCAD: 1000 });
  assert.equal(r.ok, false);
});

test('calculate: Quebec applies QST compounded on value+duty+GST', () => {
  const codes = searchHs('01', 1);
  assert.ok(codes.length > 0, 'dataset loaded');
  const r = calculateCanadaCustoms({ hsCode: codes[0]!.code, countryOfOrigin: 'China', valueCAD: 10000, province: 'QC' });
  assert.equal(r.ok, true);
  if (r.ok) {
    // GST 5% on (value+duty); QST 9.975% on (value+duty+GST).
    const base = 10000 + r.dutyAmount;
    assert.equal(r.gstAmount, Math.round(base * 0.05 * 100) / 100);
    assert.equal(r.provincialTaxName, 'QST');
    assert.equal(r.provincialTaxAmount, Math.round((base + base * 0.05) * 0.09975 * 100) / 100);
  }
});

test('calculate: preferential rate withheld until origin confirmed', () => {
  // Find a code where UST differs from MFN would be ideal; here we assert the
  // warning + MFN-application behaviour on any US-origin dutiable item.
  const codes = searchHs('6109', 1); // T-shirts — typically dutiable
  const code = codes[0]?.code || searchHs('01', 1)[0]!.code;
  const unconfirmed = calculateCanadaCustoms({ hsCode: code, countryOfOrigin: 'United States', valueCAD: 10000, confirmedOrigin: false });
  assert.equal(unconfirmed.ok, true);
  if (unconfirmed.ok && unconfirmed.preferentialAvailable) {
    assert.equal(unconfirmed.appliedTreatment, 'MFN');
    assert.ok(unconfirmed.warnings.some((w) => /rules of origin/i.test(w)));
  }
});
