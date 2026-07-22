import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyProviderState,
  decideMigrationAction,
  normalizeProvider,
  isKnownProvider,
  AI_PROVIDERS,
} from './apiKeysService.js';

// --- provider state model (Objective 1) --------------------------------------

test('classifyProviderState distinguishes all five states', () => {
  assert.equal(
    classifyProviderState({ storedRow: true, decryptable: true, hasEnv: false }),
    'stored_usable',
  );
  assert.equal(
    classifyProviderState({ storedRow: true, decryptable: false, hasEnv: false }),
    'stored_locked',
  );
  // A locked row is surfaced as locked even if an env fallback exists.
  assert.equal(
    classifyProviderState({ storedRow: true, decryptable: false, hasEnv: true }),
    'stored_locked',
  );
  assert.equal(
    classifyProviderState({ storedRow: false, decryptable: false, hasEnv: true }),
    'env_fallback',
  );
  assert.equal(
    classifyProviderState({ storedRow: false, decryptable: false, hasEnv: false }),
    'missing',
  );
});

// --- xai/grok reconciliation -------------------------------------------------

test('normalizeProvider canonicalizes grok -> xai and is case-insensitive', () => {
  assert.equal(normalizeProvider('grok'), 'xai');
  assert.equal(normalizeProvider('XAI'), 'xai');
  assert.equal(normalizeProvider(' Anthropic '), 'anthropic');
  assert.throws(() => normalizeProvider('bogus'), /Unknown AI provider/);
});

test('isKnownProvider accepts canonical ids and the grok alias', () => {
  assert.equal(isKnownProvider('grok'), true);
  assert.equal(isKnownProvider('xai'), true);
  assert.equal(isKnownProvider('foobar'), false);
  assert.deepEqual([...AI_PROVIDERS], ['anthropic', 'gemini', 'openai', 'xai', 'deepseek']);
});

// --- env->vault migration decisions (Objective 2) ----------------------------

test('decideMigrationAction is idempotent and never clobbers a good stored key', () => {
  // Already stored + decryptable -> leave it alone.
  assert.equal(decideMigrationAction('stored_usable', true), 'already_stored');
  assert.equal(decideMigrationAction('stored_usable', false), 'already_stored');
  // Locked row -> do not overwrite by default.
  assert.equal(decideMigrationAction('stored_locked', true), 'stored_locked');
  // Locked row + explicit overwrite + env present -> import.
  assert.equal(decideMigrationAction('stored_locked', true, true), 'import');
  // Locked row + overwrite but NO env -> nothing to import.
  assert.equal(decideMigrationAction('stored_locked', false, true), 'no_env');
  // Env fallback available -> import into the vault.
  assert.equal(decideMigrationAction('env_fallback', true), 'import');
  // Missing everywhere -> no-op.
  assert.equal(decideMigrationAction('missing', false), 'no_env');
});
