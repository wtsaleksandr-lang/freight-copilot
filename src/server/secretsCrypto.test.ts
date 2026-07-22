import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMasterKey,
  isProductionRuntime,
  isMasterKeyConfigured,
  describeMasterKey,
  encryptSecret,
  decryptSecret,
  __resetSecretsKeyCacheForTests,
} from './secretsCrypto.js';

test('parseMasterKey accepts a 32-byte hex key', () => {
  const key = parseMasterKey('ab'.repeat(32));
  assert.equal(key.length, 32);
});

test('parseMasterKey accepts a 32-byte base64 key', () => {
  const source = Buffer.alloc(32, 7);
  const key = parseMasterKey(source.toString('base64'));
  assert.deepEqual(key, source);
});

test('parseMasterKey rejects invalid values', () => {
  assert.throws(() => parseMasterKey('too-short'), /32-byte/);
});

// --- production fail-safe (Objective 1) --------------------------------------

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k]!;
  }
  const restore = () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  };
  return Promise.resolve()
    .then(fn)
    .finally(restore);
}

test('isProductionRuntime detects NODE_ENV=production and REPLIT_DEPLOYMENT', async () => {
  await withEnv({ NODE_ENV: 'production', REPLIT_DEPLOYMENT: undefined }, () => {
    assert.equal(isProductionRuntime(), true);
  });
  await withEnv({ NODE_ENV: 'development', REPLIT_DEPLOYMENT: '1' }, () => {
    assert.equal(isProductionRuntime(), true);
  });
  await withEnv({ NODE_ENV: 'development', REPLIT_DEPLOYMENT: undefined }, () => {
    assert.equal(isProductionRuntime(), false);
  });
});

test('production with no SECRETS_MASTER_KEY fails safely instead of generating a key', async () => {
  await withEnv({ REPLIT_DEPLOYMENT: '1', NODE_ENV: 'production', SECRETS_MASTER_KEY: undefined }, async () => {
    __resetSecretsKeyCacheForTests();
    await assert.rejects(() => encryptSecret('anything'), /required in production/);
    __resetSecretsKeyCacheForTests();
  });
});

test('encrypt/decrypt round-trips with a configured master key (no filesystem)', async () => {
  await withEnv({ REPLIT_DEPLOYMENT: undefined, NODE_ENV: 'test', SECRETS_MASTER_KEY: 'cd'.repeat(32) }, async () => {
    __resetSecretsKeyCacheForTests();
    const blob = await encryptSecret('sk-secret-value');
    assert.notEqual(blob, 'sk-secret-value');
    assert.equal(await decryptSecret(blob), 'sk-secret-value');
    assert.equal(isMasterKeyConfigured(), true);
    assert.equal(describeMasterKey().productionSafe, true);
    __resetSecretsKeyCacheForTests();
  });
});

test('decryptSecret reports a locked secret when the key is wrong', async () => {
  let blob = '';
  await withEnv({ REPLIT_DEPLOYMENT: undefined, NODE_ENV: 'test', SECRETS_MASTER_KEY: 'aa'.repeat(32) }, async () => {
    __resetSecretsKeyCacheForTests();
    blob = await encryptSecret('locked-value');
    __resetSecretsKeyCacheForTests();
  });
  await withEnv({ REPLIT_DEPLOYMENT: undefined, NODE_ENV: 'test', SECRETS_MASTER_KEY: 'bb'.repeat(32) }, async () => {
    __resetSecretsKeyCacheForTests();
    await assert.rejects(() => decryptSecret(blob), /cannot be unlocked/);
    __resetSecretsKeyCacheForTests();
  });
});
