import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHistoricalCost, scoreDrayageEndpoint, weightMatchScore } from './drayageEstimateMath.js';

test('normalizes a historical multi-container total to requested count', () => {
  assert.equal(normalizeHistoricalCost(2400, 2, 3), 3600);
});

test('gives strongest score to exact port and terminal', () => {
  assert.equal(scoreDrayageEndpoint(
    { type: 'CY', portCode: 'USLAX', terminal: 'Pier A' },
    { type: 'CY', portCode: 'USLAX', terminal: 'Pier A' }
  ), 6);
});

test('accepts same postal region with lower confidence than exact ZIP', () => {
  const exact = scoreDrayageEndpoint(
    { type: 'DOOR', zip: '07001', country: 'US' },
    { type: 'DOOR', zip: '07001', country: 'US' }
  );
  const regional = scoreDrayageEndpoint(
    { type: 'DOOR', zip: '07001', country: 'US' },
    { type: 'DOOR', zip: '07092', country: 'US' }
  );
  assert.equal(exact, 6);
  assert.equal(regional, 4);
});

test('rejects substantially lighter historical container weight', () => {
  assert.equal(weightMatchScore(30000, 1, 20000, 1), -100);
});

test('rewards comparable per-container weights', () => {
  assert.equal(weightMatchScore(50000, 2, 26000, 1), 2);
});
