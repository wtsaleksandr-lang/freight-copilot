import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionPlan, listAiPresets, validateProfile } from './aiRoutingService.js';

test('provides Everyday, Power and Ultimate presets with caching and automatic web policy', () => {
  const presets = listAiPresets();
  assert.deepEqual(presets.map((profile) => profile.mode), ['default', 'power', 'ultimate']);
  for (const profile of presets) {
    assert.equal(profile.promptCaching, true);
    assert.equal(profile.webPolicy, 'automatic');
    assert.ok(profile.roles.length >= 3);
    assert.ok(profile.maxTaskCostUsd > 0);
  }
});

test('Ultimate creates a parallel, web-grounded plan requiring approval', () => {
  const ultimate = listAiPresets().find((profile) => profile.mode === 'ultimate');
  assert.ok(ultimate);
  const plan = buildExecutionPlan(ultimate, { kind: 'OOG quote', hasImages: true, requiresFreshData: true, highStakes: true });
  assert.equal(plan.parallel, true);
  assert.equal(plan.webResearch, true);
  assert.equal(plan.humanApprovalRequired, true);
  assert.match(plan.disagreementPolicy, /disagreements/i);
  assert.ok(plan.steps.filter((step) => step.parallelGroup === 'analysis').length >= 3);
});

test('rejects unsafe custom spending limits and empty roles', () => {
  assert.throws(() => validateProfile({ mode: 'custom', maxTaskCostUsd: 1000, webPolicy: 'automatic', roles: [] }), /model role|Maximum task cost/i);
});
