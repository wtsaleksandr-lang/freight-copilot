// Unit tests for the AI resilience layer: missing-key skip, dead-model advance,
// clear all-fail aggregation, and the honest AI health model. Run with:
//   node --import tsx --test src/llm/sharedAiExecutor.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

// The routing profile is read from the DB; point it at a refused port so the
// read fails fast and getAiRoutingProfile() falls back to the default preset.
// ANTHROPIC_API_KEY must stay set the whole run (config.loadEnv requires it).
process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:1/none?sslmode=disable';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

const {
  executeStructuredAiTask,
  getLastAiError,
  clearLastAiError,
  isModelUnavailableError,
} = await import('./sharedAiExecutor.js');
const { computeAiHealth } = await import('../server/runtimeHealthRoute.js');
const { listAiPresets } = await import('../server/aiRoutingService.js');
const { AI_PROVIDERS, envVarFor } = await import('../server/apiKeysService.js');
const { closeDbPool } = await import('../db/client.js');

type FetchLike = typeof globalThis.fetch;
const realFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) } as unknown as Response;
}
const geminiOk = () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({ from: 'gemini', ok: true }) }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6 } });
const anthropicOk = () => jsonResponse(200, { content: [{ type: 'text', text: JSON.stringify({ from: 'anthropic', ok: true }) }], usage: { input_tokens: 12, output_tokens: 6 } });

/** Install a fetch that dispatches by provider host. */
function installFetch(handlers: { gemini?: () => Response; anthropic?: () => Response; other?: () => Response }) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('generativelanguage.googleapis.com')) return (handlers.gemini ?? (() => { throw new Error('unexpected gemini call'); }))();
    if (url.includes('api.anthropic.com')) return (handlers.anthropic ?? (() => { throw new Error('unexpected anthropic call'); }))();
    return (handlers.other ?? (() => { throw new Error('unexpected call: ' + url); }))();
  }) as FetchLike;
}

const imageTask = () => ({
  kind: 'test-extraction',
  systemPrompt: 'system',
  userPrompt: 'extract',
  schemaDescription: '{ ok: boolean }',
  media: { mediaType: 'image/png', base64: 'AAAA' },
  validate: (v: unknown) => { if (!v || typeof v !== 'object') throw new Error('invalid shape'); return v as Record<string, unknown>; },
});
const textTask = () => ({ ...imageTask(), media: undefined });

test.after(async () => { globalThis.fetch = realFetch; await closeDbPool().catch(() => {}); });

test('isModelUnavailableError detects retired/unknown model errors, not transient ones', () => {
  assert.equal(isModelUnavailableError(new Error('Gemini 404: model not found')), true);
  assert.equal(isModelUnavailableError(new Error('model_not_found')), true);
  assert.equal(isModelUnavailableError(new Error('this model is no longer available')), true);
  assert.equal(isModelUnavailableError(new Error('ECONNRESET socket hang up')), false);
  assert.equal(isModelUnavailableError(new Error('Anthropic 401: invalid x-api-key')), false);
});

test('missing-key provider is skipped (not a hard error) and the next provider serves the task', async () => {
  clearLastAiError();
  delete process.env.GEMINI_API_KEY; // primary has no key
  installFetch({ anthropic: anthropicOk });
  const result = await executeStructuredAiTask(imageTask());
  assert.equal(result.provider, 'anthropic');
  const gemini = result.attempts.find((a) => a.provider === 'gemini');
  assert.ok(gemini, 'gemini attempt recorded');
  assert.equal(gemini!.skipped, true, 'gemini marked skipped, not failed');
  assert.match(gemini!.error ?? '', /no API key/i);
  assert.equal(getLastAiError(), null, 'a successful task clears the standing error');
});

test('a 404 (dead model) on one provider advances to the next provider', async () => {
  clearLastAiError();
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  installFetch({ gemini: () => jsonResponse(404, 'model not found — no longer available'), anthropic: anthropicOk });
  const result = await executeStructuredAiTask(imageTask());
  assert.equal(result.provider, 'anthropic');
  const gemini = result.attempts.find((a) => a.provider === 'gemini' && a.ok === false);
  assert.ok(gemini, 'gemini failure recorded');
  assert.match(gemini!.error ?? '', /404|not found|no longer available/i);
});

test('all providers failing yields a clear aggregated error and records last AI error', async () => {
  clearLastAiError();
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  installFetch({ gemini: () => jsonResponse(404, 'model not found'), anthropic: () => jsonResponse(500, 'internal error') });
  await assert.rejects(
    () => executeStructuredAiTask(imageTask()),
    (err: Error) => {
      assert.match(err.message, /No configured AI provider completed test-extraction/);
      assert.match(err.message, /gemini/);
      assert.match(err.message, /anthropic/);
      return true;
    },
  );
  const last = getLastAiError();
  assert.ok(last, 'last AI error is tracked for the health route');
  assert.equal(last!.kind, 'test-extraction');
});

test('no keyed provider in the plan fails fast with a clear error naming the missing key', async () => {
  clearLastAiError();
  delete process.env.GEMINI_API_KEY; // text task selects only the gemini primary
  installFetch({});
  await assert.rejects(
    () => executeStructuredAiTask(textTask()),
    (err: Error) => {
      assert.match(err.message, /gemini/);
      assert.match(err.message, /no API key/i);
      return true;
    },
  );
});

// ---- Honest AI health model ------------------------------------------------
type PMap = Partial<Record<string, boolean>>;
function statuses(keyed: PMap) {
  return AI_PROVIDERS.map((provider) => {
    const usable = Boolean(keyed[provider]);
    return { provider, state: (usable ? 'configured' : 'missing') as 'configured' | 'missing', usable, hasEnv: usable, envVar: envVarFor(provider) };
  });
}
const defaultProfile = () => listAiPresets()[0]!; // primary provider = gemini

test('computeAiHealth: keyed provider with an enabled model → ok', () => {
  const ai = computeAiHealth(defaultProfile(), statuses({ gemini: true }), null);
  assert.equal(ai.status, 'ok');
  assert.equal(ai.primary, 'gemini');
});

test('computeAiHealth: no keys at all → degraded (AI is optional, not red)', () => {
  const ai = computeAiHealth(defaultProfile(), statuses({}), null);
  assert.equal(ai.status, 'degraded');
  assert.match(ai.reason, /No AI provider key/i);
});

test('computeAiHealth: keyed provider but no enabled model → down', () => {
  // xai has only experimental model ids in the registry → no usable model.
  const ai = computeAiHealth(defaultProfile(), statuses({ xai: true }), null);
  assert.equal(ai.status, 'down');
  assert.match(ai.reason, /no keyed provider has a currently-enabled model/i);
});

test('computeAiHealth: primary unkeyed but a fallback provider usable → degraded', () => {
  const ai = computeAiHealth(defaultProfile(), statuses({ anthropic: true }), null);
  assert.equal(ai.status, 'degraded');
  assert.match(ai.reason, /gemini/i);
});

test('computeAiHealth: a recent total failure downgrades an otherwise-ok light to degraded', () => {
  const ai = computeAiHealth(defaultProfile(), statuses({ gemini: true }), { kind: 'x', message: 'boom', at: new Date().toISOString() });
  assert.equal(ai.status, 'degraded');
  assert.match(ai.reason, /Recent AI failure/);
});
