import test from 'node:test';
import assert from 'node:assert/strict';
import { testProviderConnection } from './providerConnectionTest.js';

const SECRET = 'sk-super-secret-key-1234567890abcdef';

function fakeFetch(response: Partial<Response> & { ok: boolean; status?: number }): typeof fetch {
  return (async () =>
    ({
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: response.json ?? (async () => ({})),
      text: response.text ?? (async () => ''),
    }) as unknown as Response) as unknown as typeof fetch;
}

test('successful probe returns success + a model, never the key', async () => {
  const result = await testProviderConnection('anthropic', {
    getKey: async () => SECRET,
    fetchImpl: fakeFetch({ ok: true, json: async () => ({ data: [{ id: 'claude-x' }] }) }),
    now: () => 0,
  });
  assert.equal(result.success, true);
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.model, 'claude-x');
  assert.equal(result.endpoint, 'GET /v1/models');
  assert.equal(result.error, null);
});

test('401 is reported as an unauthorized key and the key is never echoed', async () => {
  const result = await testProviderConnection('openai', {
    getKey: async () => SECRET,
    fetchImpl: fakeFetch({ ok: false, status: 401, text: async () => `invalid key ${SECRET}` }),
    now: () => 0,
  });
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /unauthorized|Invalid/i);
  assert.ok(!(result.error ?? '').includes(SECRET), 'error must not contain the key value');
});

test('429 is surfaced as rate limiting (key looks valid)', async () => {
  const result = await testProviderConnection('deepseek', {
    getKey: async () => SECRET,
    fetchImpl: fakeFetch({ ok: false, status: 429, text: async () => 'slow down' }),
    now: () => 0,
  });
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /rate limited/i);
});

test('a missing key is reported without calling the network', async () => {
  let called = false;
  const result = await testProviderConnection('gemini', {
    getKey: async () => undefined,
    fetchImpl: (async () => {
      called = true;
      return {} as Response;
    }) as unknown as typeof fetch,
  });
  assert.equal(result.success, false);
  assert.equal(called, false);
  assert.match(result.error ?? '', /No gemini key configured/);
});

test('a timeout/abort is reported cleanly, key redacted', async () => {
  const result = await testProviderConnection('xai', {
    getKey: async () => SECRET,
    timeoutMs: 5,
    fetchImpl: (async () => {
      const e = new Error(`network blew up with ${SECRET}`);
      e.name = 'AbortError';
      throw e;
    }) as unknown as typeof fetch,
    now: () => 0,
  });
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /timed out/i);
  assert.ok(!(result.error ?? '').includes(SECRET));
});

test('grok is accepted as an alias for xai', async () => {
  const result = await testProviderConnection('grok', {
    getKey: async () => SECRET,
    fetchImpl: fakeFetch({ ok: true, json: async () => ({ data: [{ id: 'grok-x' }] }) }),
    now: () => 0,
  });
  assert.equal(result.provider, 'xai');
  assert.equal(result.success, true);
});
