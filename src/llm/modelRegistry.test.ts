import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveModel,
  isModelUsable,
  supportsPromptCaching,
  cachingModeFor,
  defaultModelFor,
  getModelEntry,
} from './modelRegistry.js';

test('resolveModel passes through enabled ids unchanged', () => {
  const r = resolveModel('anthropic', 'claude-haiku-4-5-20251001');
  assert.equal(r.model, 'claude-haiku-4-5-20251001');
  assert.equal(r.substituted, false);
  assert.equal(r.state, 'enabled');
});

test('resolveModel keeps experimental ids but marks them (executor falls back on error)', () => {
  const r = resolveModel('openai', 'gpt-5.6');
  assert.equal(r.model, 'gpt-5.6');
  assert.equal(r.substituted, false);
  assert.equal(r.state, 'experimental');
});

test('resolveModel substitutes an unknown id for the provider default', () => {
  const r = resolveModel('gemini', 'gemini-does-not-exist');
  assert.equal(r.substituted, true);
  assert.equal(r.model, defaultModelFor('gemini'));
  assert.equal(r.state, 'unknown');
});

test('prompt caching is explicit only for Anthropic models', () => {
  assert.equal(supportsPromptCaching('anthropic', 'claude-sonnet-5'), true);
  assert.equal(supportsPromptCaching('openai', 'gpt-4o'), false); // automatic, not explicit
  assert.equal(cachingModeFor('openai', 'gpt-4o'), 'automatic');
  assert.equal(cachingModeFor('gemini', 'gemini-2.0-flash'), 'none');
});

test('isModelUsable rejects unknown ids and every preset model is registered', () => {
  assert.equal(isModelUsable('anthropic', 'totally-made-up'), false);
  for (const [provider, model] of [
    ['gemini', 'gemini-2.0-flash'],
    ['anthropic', 'claude-sonnet-5'],
    ['anthropic', 'claude-opus-4-8'],
    ['openai', 'gpt-4o'],
    ['deepseek', 'deepseek-chat'],
  ] as const) {
    assert.ok(getModelEntry(provider, model), `${provider}/${model} should be in the registry`);
  }
});
