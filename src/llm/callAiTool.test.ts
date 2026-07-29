// Provider-routing gate for the shared AI helper.
//
// These tests prove the default-mode 404 bug cannot recur:
//   - On the DEFAULT (Gemini) config, callAiTool routes to the Gemini
//     endpoint and NEVER constructs an Anthropic request with a gemini model.
//   - The Anthropic branch talks to the Anthropic endpoint.
//   - When Gemini fails, the fallback retries on Anthropic with a REAL Claude
//     model id (claude-haiku-4-5-20251001), never a gemini-* id.
//
// Transports are stubbed at globalThis.fetch — no real API calls. The default
// AI config is forced by removing DATABASE_URL so the DB settings read fails
// and getAiConfig() falls back to the built-in Gemini preset.

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  callAiTool,
  callAiText,
  runToolCall,
  ANTHROPIC_FALLBACK_MODEL,
} from './callAiTool.js';

const GEMINI_HOST = 'generativelanguage.googleapis.com';
const ANTHROPIC_HOST = 'api.anthropic.com';

type FetchCall = { url: string; body: Record<string, unknown> };
let calls: FetchCall[] = [];
let geminiShouldFail = false;

const realFetch = globalThis.fetch;
const savedEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
};

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && 'url' in input) return String((input as { url: unknown }).url);
  return String(input);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  geminiShouldFail = false;
  // Force getAiConfig() → default (Gemini) preset: keep a well-formed
  // DATABASE_URL (loadEnv() calls process.exit(1) if it's missing) but point it
  // at an unreachable host so the settings read rejects and getAiConfig falls
  // back to the built-in Gemini preset.
  process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:1/none';
  process.env.GEMINI_API_KEY = 'gm-test-key';
  process.env.ANTHROPIC_API_KEY = 'sk-test-key';

  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = urlOf(input);
    let body: Record<string, unknown> = {};
    try {
      body = init?.body ? JSON.parse(String(init.body)) : {};
    } catch {
      body = {};
    }
    calls.push({ url, body });
    if (url.includes(GEMINI_HOST)) {
      if (geminiShouldFail) return json({ error: 'boom' }, 500);
      // Gemini tool response (functionCall.args) OR text response.
      if (url.includes(':generateContent') && body.tools) {
        return json({
          candidates: [
            { content: { parts: [{ functionCall: { name: 'demo_tool', args: { ok: true, via: 'gemini' } } }] } },
          ],
        });
      }
      return json({ candidates: [{ content: { parts: [{ text: 'gemini text reply' }] } }] });
    }
    if (url.includes(ANTHROPIC_HOST)) {
      const isText = !Array.isArray(body.tools);
      return json({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: body.model,
        stop_reason: isText ? 'end_turn' : 'tool_use',
        stop_sequence: null,
        content: isText
          ? [{ type: 'text', text: 'anthropic text reply' }]
          : [{ type: 'tool_use', id: 'tu_1', name: 'demo_tool', input: { ok: true, via: 'anthropic' } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const demoTool = {
  name: 'demo_tool',
  description: 'demo',
  input_schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
};

test('default (Gemini) config routes callAiTool to the Gemini endpoint, never Anthropic', async () => {
  const out = (await callAiTool({ system: 'sys', content: 'hello', tool: demoTool })) as { via?: string };
  assert.equal(out.via, 'gemini');
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.url.includes(GEMINI_HOST), 'should hit the Gemini endpoint');
  assert.ok(calls[0]!.url.includes('gemini-flash-latest'), 'should use the default gemini model id in the URL');
  // The core bug: a gemini model id must NEVER reach the Anthropic client.
  assert.ok(!calls.some((c) => c.url.includes(ANTHROPIC_HOST)), 'must not call Anthropic on the default config');
});

test('Anthropic branch sends to the Anthropic endpoint with the given Claude model', async () => {
  const out = (await runToolCall(
    'anthropic',
    'claude-haiku-4-5-20251001',
    { system: 'sys', content: 'hello', tool: demoTool },
    [{ type: 'text', text: 'hello' }],
    'sk-test-key',
  )) as { via?: string };
  assert.equal(out.via, 'anthropic');
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.url.includes(ANTHROPIC_HOST));
  assert.equal(calls[0]!.body.model, 'claude-haiku-4-5-20251001');
  assert.ok(!String(calls[0]!.body.model).includes('gemini'), 'Anthropic must never receive a gemini model');
});

test('on Gemini failure, callAiTool falls back to Anthropic with a real Claude model id', async () => {
  geminiShouldFail = true;
  const out = (await callAiTool({ system: 'sys', content: 'hello', tool: demoTool })) as { via?: string };
  assert.equal(out.via, 'anthropic');
  assert.equal(calls.length, 2, 'one failed Gemini attempt + one Anthropic fallback');
  assert.ok(calls[0]!.url.includes(GEMINI_HOST));
  assert.ok(calls[1]!.url.includes(ANTHROPIC_HOST));
  // The fallback model MUST be a Claude id, not the gemini id that caused the 404.
  assert.equal(calls[1]!.body.model, ANTHROPIC_FALLBACK_MODEL);
  assert.ok(String(calls[1]!.body.model).startsWith('claude-'));
  assert.ok(!String(calls[1]!.body.model).includes('gemini'));
});

test('callAiText routes to Gemini by default and falls back to Anthropic (Claude id) on failure', async () => {
  const geminiOut = await callAiText({ system: 'sys', userText: 'compose' });
  assert.equal(geminiOut, 'gemini text reply');
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.url.includes(GEMINI_HOST));

  // Now force the failure path.
  calls = [];
  geminiShouldFail = true;
  const anthOut = await callAiText({ system: 'sys', userText: 'compose' });
  assert.equal(anthOut, 'anthropic text reply');
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.url.includes(ANTHROPIC_HOST));
  assert.equal(calls[1]!.body.model, ANTHROPIC_FALLBACK_MODEL);
});

test('no rerouted parser still hardcodes the Anthropic SDK or getModel() (static guard)', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const rerouted = [
    'parseDrayageIntake.ts',
    'parseIntake.ts',
    'parseRates.ts',
    'classifyRateFiles.ts',
    'analyzeRecording.ts',
    'generateReply.ts',
    'parseTruckingRateFiles.ts',
    'parseDrayageRateFiles.ts',
  ];
  for (const file of rerouted) {
    const src = await readFile(join(here, file), 'utf8');
    assert.ok(
      !src.includes("from '@anthropic-ai/sdk'"),
      `${file} must not import the Anthropic SDK directly — route via callAiTool`,
    );
    assert.ok(
      !src.includes('getModel('),
      `${file} must not call getModel() — provider+model come from callAiTool/getAiConfig`,
    );
  }
});
