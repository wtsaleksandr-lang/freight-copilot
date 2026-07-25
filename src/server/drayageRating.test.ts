import assert from 'node:assert/strict';
import test from 'node:test';
import { computeDrayageMatrix, isTariffPort } from './drayageRating.js';

// A door a few miles from the LA/LB port → innermost ring flat tariff = $425.
const NEAR_LA = { portCode: 'USLAX', doorLat: 33.80, doorLng: -118.25 };

test('flat zone tariff: door within the innermost ring prices at the ring flat', () => {
  const r = computeDrayageMatrix(NEAR_LA);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.miles <= 30, `expected local miles, got ${r.miles}`);
    assert.equal(r.subtotalLinehaul, 425);
    assert.equal(r.total, 425);
    assert.equal(r.currency, 'USD');
  }
});

test('auto accessorial: hazmat adds the flat hazmat fee', () => {
  const r = computeDrayageMatrix({ ...NEAR_LA, flags: { hazmat: true } });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.subtotalAccessorials, 250);
    assert.equal(r.total, 675); // 425 + 250
    assert.ok(r.lines.some((l) => l.code === 'hazmat_flat'));
  }
});

test('optional accessorial + margin fold correctly', () => {
  const r = computeDrayageMatrix({ ...NEAR_LA, selectedAccessorialCodes: ['prepull'], marginPct: 10 });
  assert.equal(r.ok, true);
  if (r.ok) {
    // 425 linehaul + 145 prepull = 570; +10% margin = 627.
    assert.equal(r.subtotalAccessorials, 145);
    assert.equal(r.margin, 57);
    assert.equal(r.total, 627);
  }
});

test('per-hour detention bills only hours over the free window', () => {
  const r = computeDrayageMatrix({ ...NEAR_LA, selectedAccessorialCodes: ['detention'], flags: { detentionHours: 3 } });
  assert.equal(r.ok, true);
  if (r.ok) {
    // (3 - 2 free) × $99 = 99
    assert.equal(r.subtotalAccessorials, 99);
    assert.equal(r.total, 524);
  }
});

test('fuel surcharge applies per road-mile when a $/mi is given', () => {
  const r = computeDrayageMatrix({ ...NEAR_LA, fuelPerMile: 0.5 });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.fuel, Math.round(0.5 * r.miles * 100) / 100);
    assert.equal(r.total, Math.round((425 + r.fuel) * 100) / 100);
  }
});

test('beyond the outermost ring → unsupported, with a clear reason', () => {
  const r = computeDrayageMatrix({ portCode: 'USLAX', doorLat: 36.0, doorLng: -118.0 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /beyond the 150-mile drayage range/i);
});

test('unknown / non-tariff port → unsupported', () => {
  assert.equal(isTariffPort('USLAX'), true);
  assert.equal(isTariffPort('ZZZZZ'), false);
  const r = computeDrayageMatrix({ portCode: 'ZZZZZ', doorLat: 33.8, doorLng: -118.2 });
  assert.equal(r.ok, false);
});

test('Canadian anchor port quotes in CAD', () => {
  const r = computeDrayageMatrix({ portCode: 'CAVAN', doorLat: 49.25, doorLng: -123.10 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.currency, 'CAD');
});
