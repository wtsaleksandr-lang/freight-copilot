import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreDeliveryMatch,
  matchesOriginPort,
  computeLibraryEstimate,
  median,
} from './drayageLibraryEstimate.js';

test('scoreDeliveryMatch — state is the floor, tighter tiers win', () => {
  const target = { city: 'Banning', state: 'CA', zip: '92220' };
  // exact ZIP
  assert.equal(
    scoreDeliveryMatch(target, { deliveryCity: 'Banning', deliveryState: 'CA', deliveryZip: '92220' }),
    'exact_zip'
  );
  // same city+state, different ZIP
  assert.equal(
    scoreDeliveryMatch(target, { deliveryCity: 'Banning', deliveryState: 'ca', deliveryZip: '92223' }),
    'city_state'
  );
  // same STATE only, different city + ZIP  ← the fallback Alex wants
  assert.equal(
    scoreDeliveryMatch(target, { deliveryCity: 'Fontana', deliveryState: 'CA', deliveryZip: '92335' }),
    'state'
  );
  // different state → unusable
  assert.equal(
    scoreDeliveryMatch(target, { deliveryCity: 'Phoenix', deliveryState: 'AZ', deliveryZip: '85001' }),
    null
  );
  // missing state → unusable
  assert.equal(scoreDeliveryMatch(target, { deliveryCity: 'Banning', deliveryState: null }), null);
});

test('matchesOriginPort — loose match on code or port city', () => {
  assert.equal(matchesOriginPort('USLAX', 'Los Angeles', { pickupLabel: 'Port of Los Angeles (USLAX)' }), true);
  assert.equal(matchesOriginPort('USLAX', 'Los Angeles', { pickupCity: 'Los Angeles' }), true);
  assert.equal(matchesOriginPort('USLAX', 'Los Angeles', { pickupLabel: 'Port of Long Beach (USLGB)' }), false);
  assert.equal(matchesOriginPort('USLAX', 'Los Angeles', { pickupLabel: null, pickupCity: null, pickupZip: null }), false);
});

test('median', () => {
  assert.equal(median([5]), 5);
  assert.equal(median([1, 3]), 2);
  assert.equal(median([3, 1, 2]), 2);
  assert.ok(Number.isNaN(median([])));
});

test('computeLibraryEstimate — state-tier derives $/mile and applies to new lane', () => {
  // Two state-only CA rates from the same port; new lane is 60 mi.
  const est = computeLibraryEstimate(60, [
    { totalRate: 575, miles: 45, tier: 'state' },
    { totalRate: 875, miles: 120, tier: 'state' },
  ]);
  assert.ok(est);
  // perMiles: 12.7778 and 7.2917 → median 10.0347 → total = *60
  assert.equal(est!.tier, 'state');
  assert.equal(est!.sampleSize, 2);
  assert.equal(est!.perMileMedian, 10.03);
  assert.equal(est!.estimatedTotal, 602.08);
});

test('computeLibraryEstimate — tighter tier wins when it has samples', () => {
  // An exact-ZIP rate is present alongside state rates → use ONLY the exact tier.
  const est = computeLibraryEstimate(60, [
    { totalRate: 575, miles: 45, tier: 'state' },
    { totalRate: 875, miles: 120, tier: 'state' },
    { totalRate: 600, miles: 50, tier: 'exact_zip' },
  ]);
  assert.ok(est);
  assert.equal(est!.tier, 'exact_zip');
  assert.equal(est!.sampleSize, 1);
  assert.equal(est!.perMileMedian, 12); // 600/50
  assert.equal(est!.estimatedTotal, 720); // 12 * 60
});

test('computeLibraryEstimate — nothing usable → null', () => {
  assert.equal(computeLibraryEstimate(60, [{ totalRate: null, miles: 50, tier: 'state' }]), null);
  assert.equal(computeLibraryEstimate(60, [{ totalRate: 500, miles: 0, tier: 'state' }]), null);
  assert.equal(computeLibraryEstimate(0, [{ totalRate: 500, miles: 50, tier: 'state' }]), null);
  assert.equal(computeLibraryEstimate(60, []), null);
});
