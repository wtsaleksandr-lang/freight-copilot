// Shared provider-routing helper for every structured-extraction and
// text-generation LLM call in LoadMode.
//
// WHY THIS EXISTS — the 404 bug it fixes:
//   Many parsers used to hardcode `new Anthropic(...)` as the client but pass
//   `model: await getModel()` as the model. In the DEFAULT (Gemini) AI mode,
//   getModel() resolves to a Gemini id (e.g. `gemini-2.5-flash`), so those
//   parsers fired `anthropicClient.messages.create({ model: 'gemini-2.5-flash' })`
//   → Anthropic 404 `not_found_error "model: gemini-2.5-flash"`. Result: on the
//   default config, Drayage Extract, customer Intake, rate parsers, recording
//   analysis, and reply generation were all broken unless the user manually
//   switched to Power (a Claude model).
//
// THE RULE (identical to parseShipmentBriefing.callExtract):
//   1. Resolve provider + model per-call via getAiConfig().
//   2. provider === 'gemini' → route to the Gemini adapter (Google endpoint).
//   3. NEVER pass a gemini-* model id to the Anthropic client. On a
//      non-Anthropic provider failure, fall back to the Anthropic client with a
//      REAL Claude id (claude-haiku-4-5-20251001), never the gemini id.
//
// Two shapes are supported:
//   - callAiTool: single forced tool-use extraction → returns the tool input
//     (unknown; the caller Zod-validates it). Mirrors Anthropic's
//     `toolUse.input` so downstream schemas are unchanged.
//   - callAiText: plain text generation (no tools) → returns the text string.

import Anthropic from '@anthropic-ai/sdk';
import { getAiConfig, type AiProvider } from './model.js';
import { callGeminiTool, callGeminiText } from './geminiAdapter.js';

const PLACEHOLDER_KEY = 'PLACEHOLDER_REPLACE_WITH_REAL_KEY';

/** Real Claude id used for the cross-provider fallback. Never a gemini id. */
export const ANTHROPIC_FALLBACK_MODEL = 'claude-haiku-4-5-20251001';

/** Content block in the Anthropic/Gemini-adapter shared shape. */
export type AiContentBlock = { type: string; [k: string]: unknown };

export interface AiToolDef {
  name: string;
  description: string;
  // JSON Schema — the same object already fed to Anthropic's tools[].
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input_schema: any;
}

export interface AiToolCallParams {
  system: string;
  /** User message content: a block array, or a plain string (wrapped as text). */
  content: AiContentBlock[] | string;
  tool: AiToolDef;
  maxTokens?: number;
}

export interface AiTextCallParams {
  system: string;
  userText: string;
  maxTokens?: number;
}

/**
 * Resolve a usable Anthropic key (DB vault → .env). Returns undefined when no
 * real key is configured (placeholder or empty), so callers can decide whether
 * a fallback is possible.
 */
async function loadAnthropicKey(): Promise<string | undefined> {
  const { loadAiKey } = await import('../server/apiKeysService.js');
  const key = await loadAiKey('anthropic');
  if (!key || key === PLACEHOLDER_KEY) return undefined;
  return key;
}

function shortErr(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 140) : String(err);
}

function toBlocks(content: AiContentBlock[] | string): AiContentBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

// --- Tool-use extraction --------------------------------------------------

/** Exported for tests — routes a single tool call to one concrete provider. */
export async function runToolCall(
  provider: AiProvider,
  model: string,
  params: AiToolCallParams,
  content: AiContentBlock[],
  anthKeyOverride?: string,
): Promise<unknown> {
  if (provider === 'gemini') {
    return callGeminiTool({
      modelName: model,
      systemPrompt: params.system,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      content: content as any,
      tool: params.tool,
      maxTokens: params.maxTokens ?? 2048,
    });
  }
  const key = anthKeyOverride ?? (await loadAnthropicKey());
  if (!key) {
    throw new Error(
      'No Anthropic API key set. Add one in the Carrier secrets page or set ANTHROPIC_API_KEY in .env.',
    );
  }
  const client = new Anthropic({ apiKey: key });
  const response = await client.messages.create({
    model,
    max_tokens: params.maxTokens ?? 2048,
    system: [
      { type: 'text', text: params.system, cache_control: { type: 'ephemeral' } },
    ],
    tools: [
      {
        name: params.tool.name,
        description: params.tool.description,
        input_schema: params.tool.input_schema,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tool_choice: { type: 'tool', name: params.tool.name },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: [{ role: 'user', content: content as any }],
  });
  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('Model did not return a tool_use block');
  }
  return toolUse.input;
}

/**
 * Provider-routed structured extraction. Returns the model's tool input
 * (unknown — the caller validates with its own Zod schema).
 *
 * Cross-provider safety net: if a non-Anthropic provider (Gemini) fails
 * outright, retry on Anthropic with a real Claude id so extraction still
 * succeeds instead of surfacing a raw provider error.
 */
export async function callAiTool(params: AiToolCallParams): Promise<unknown> {
  const cfg = await getAiConfig();
  const content = toBlocks(params.content);
  try {
    return await runToolCall(cfg.provider, cfg.model, params, content);
  } catch (primaryErr) {
    if (cfg.provider === 'anthropic') throw primaryErr;
    const anthKey = await loadAnthropicKey();
    if (!anthKey) throw primaryErr;
    console.warn(
      `[callAiTool] ${cfg.provider} failed (${shortErr(primaryErr)}); falling back to Anthropic ${ANTHROPIC_FALLBACK_MODEL}`,
    );
    return runToolCall('anthropic', ANTHROPIC_FALLBACK_MODEL, params, content, anthKey);
  }
}

// --- Plain text generation ------------------------------------------------

/** Exported for tests — routes a single text call to one concrete provider. */
export async function runTextCall(
  provider: AiProvider,
  model: string,
  params: AiTextCallParams,
  anthKeyOverride?: string,
): Promise<string> {
  if (provider === 'gemini') {
    return callGeminiText({
      modelName: model,
      systemPrompt: params.system,
      userText: params.userText,
      maxTokens: params.maxTokens ?? 1024,
    });
  }
  const key = anthKeyOverride ?? (await loadAnthropicKey());
  if (!key) {
    throw new Error(
      'No Anthropic API key set. Add one in the Carrier secrets page or set ANTHROPIC_API_KEY in .env.',
    );
  }
  const client = new Anthropic({ apiKey: key });
  const response = await client.messages.create({
    model,
    max_tokens: params.maxTokens ?? 1024,
    system: [
      { type: 'text', text: params.system, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: params.userText }],
  });
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Model returned no text block');
  }
  return textBlock.text;
}

/**
 * Provider-routed text generation (no tools). Same routing + Claude-id
 * fallback rule as callAiTool.
 */
export async function callAiText(params: AiTextCallParams): Promise<string> {
  const cfg = await getAiConfig();
  try {
    return await runTextCall(cfg.provider, cfg.model, params);
  } catch (primaryErr) {
    if (cfg.provider === 'anthropic') throw primaryErr;
    const anthKey = await loadAnthropicKey();
    if (!anthKey) throw primaryErr;
    console.warn(
      `[callAiText] ${cfg.provider} failed (${shortErr(primaryErr)}); falling back to Anthropic ${ANTHROPIC_FALLBACK_MODEL}`,
    );
    return runTextCall('anthropic', ANTHROPIC_FALLBACK_MODEL, params, anthKey);
  }
}

/**
 * Map a raw provider/API error to a friendly, client-safe message. Routes
 * should log the raw error and return this instead of leaking provider
 * internals (model ids, 404 bodies, keys) to the browser.
 */
export function friendlyAiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Missing-key cases keep their actionable guidance (no secrets leaked).
  if (/No (Anthropic|Gemini) API key set/i.test(raw)) return raw;
  return 'AI extraction is temporarily unavailable — check the AI provider/model in Settings and confirm the matching API key is set.';
}
