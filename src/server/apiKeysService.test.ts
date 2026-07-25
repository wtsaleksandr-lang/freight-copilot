import assert from 'node:assert/strict';
import test from 'node:test';
import { getProviderStatuses, loadAiKey, normalizeProvider, envVarFor } from './apiKeysService.js';

test('provider is "configured" iff its env var is set; "missing" otherwise', () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-test-123';
  try {
    const anth = getProviderStatuses().find((p) => p.provider === 'anthropic')!;
    assert.equal(anth.state, 'configured');
    assert.equal(anth.usable, true);
    assert.equal(anth.hasEnv, true);
    assert.equal(anth.envVar, 'ANTHROPIC_API_KEY');
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
});

test('loadAiKey returns the trimmed env value, or undefined when unset', async () => {
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal(await loadAiKey('openai'), undefined);
    process.env.OPENAI_API_KEY = '  sk-openai-xyz  ';
    assert.equal(await loadAiKey('openai'), 'sk-openai-xyz');
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }
});

test('legacy "grok" alias normalises to xai + its env var', () => {
  assert.equal(normalizeProvider('grok'), 'xai');
  assert.equal(envVarFor('xai'), 'XAI_API_KEY');
});
