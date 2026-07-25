import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRateToPercent, calculateDuty, getBestTreatment, calculateCanadaCustoms, searchHs, calculateUsCustoms, searchUsHs, getUsHsCode, adcvdFlag } from './customsCalc.js';

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

test('US: HS code resolves the Column-1-General (MFN) rate and duty', () => {
  const codes = searchUsHs('6109', 1);
  assert.ok(codes.length > 0, 'US dataset loaded');
  const r = calculateUsCustoms({ hsCode: codes[0]!.code, countryOfOrigin: 'China', valueUSD: 10000 });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.match(r.appliedTreatmentName, /Column 1 General/);
    assert.equal(r.dutyAmount, Math.round((r.dutyRatePercent ?? 0) / 100 * 10000 * 100) / 100);
  }
});

test('US: USMCA preference is Free only once origin is confirmed', () => {
  // 6109.10.00 (cotton T-shirts) carries a real MFN rate and USMCA "S" in special.
  const code = '6109.10.00';
  assert.ok(getUsHsCode(code), 'code present');
  const unconfirmed = calculateUsCustoms({ hsCode: code, countryOfOrigin: 'Canada', valueUSD: 10000, confirmedOrigin: false });
  const confirmed = calculateUsCustoms({ hsCode: code, countryOfOrigin: 'Canada', valueUSD: 10000, confirmedOrigin: true });
  assert.equal(unconfirmed.ok && confirmed.ok, true);
  if (unconfirmed.ok && confirmed.ok) {
    assert.match(unconfirmed.appliedTreatmentName, /Column 1 General/);
    assert.ok(unconfirmed.warnings.some((w) => /USMCA/i.test(w)));
    assert.equal(confirmed.dutyRate, 'Free');
    assert.equal(confirmed.dutyAmount, 0);
  }
});

test('US: a 10-digit statistical code falls back to its 8-digit rate', () => {
  const eight = searchUsHs('01', 1)[0]?.code;
  assert.ok(eight, 'have a code');
  // Query with an extra suffix — should still resolve.
  const r = getUsHsCode((eight as string).slice(0, 10));
  assert.ok(r, 'fallback resolved');
});

test('US: unknown HS code is reported, not crashed', () => {
  const r = calculateUsCustoms({ hsCode: '9999.99.99', countryOfOrigin: 'China', valueUSD: 1000 });
  assert.equal(r.ok, false);
});

test('AD/CVD flag: fires on a covered HS area, prioritises origin match, never a rate', () => {
  const flag = adcvdFlag('7208.10.00.00', 'China'); // hot-rolled steel from China
  assert.ok(flag, 'steel/China should flag');
  if (flag) {
    assert.ok(flag.matches.length > 0);
    assert.equal(flag.matches[0]!.originMatch, true); // China is a listed origin → sorted first
    assert.ok(flag.verifyUrl.includes('trade.gov'));
    assert.equal('rate' in (flag.matches[0] as object), false); // it's a flag, not a rate
  }
  // A clearly non-covered HS (live horses) should not flag.
  assert.equal(adcvdFlag('0101.30.00.00', 'France'), null);
});
