import { buildExecutionPlan, getAiRoutingProfile, type ModelRole } from '../server/aiRoutingService.js';
import { loadAiProviderKey, type AiProvider } from '../server/aiProviderKeys.js';
import {
  getModelEntry,
  supportsPromptCaching,
  supportsPdf,
  cachingModeFor,
  defaultModelFor,
  type RegistryProvider,
} from './modelRegistry.js';

// Lightweight in-memory record of the last time a whole task found no viable
// provider. The health route reads this so the status light can go honest-amber
// even when the config *looks* fine but extraction is actually failing right now.
export type LastAiError = { kind: string; message: string; at: string } | null;
let lastAiError: LastAiError = null;
export function getLastAiError(): LastAiError { return lastAiError; }
export function clearLastAiError(): void { lastAiError = null; }

// Errors that mean "this exact model id can't be used" (retired / renamed /
// unknown) as opposed to a transient network or auth failure. On these we treat
// the model as dead for this run and move on (or retry the provider default).
export function isModelUnavailableError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return /\b404\b/.test(msg)
    || /\b400\b/.test(msg)
    || msg.includes('not found')
    || msg.includes('no longer available')
    || msg.includes('model_not_found')
    || msg.includes('does not exist')
    || msg.includes('decommission')
    || msg.includes('deprecated')
    || msg.includes('is not supported')
    || msg.includes('unknown model')
    || msg.includes('invalid model')
    || msg.includes('unsupported model');
}

export type AiMedia = { mediaType: string; base64: string; filename?: string };
export type ProviderUsage = {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};
export type CachingReport = {
  supported: boolean;
  enabled: boolean;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Estimated USD saved by cache reads vs. full input price, when derivable. */
  estimatedSavingsUsd: number | null;
};
export type StructuredAiResult<T> = {
  value: T;
  provider: AiProvider;
  model: string;
  attempts: Array<{ provider: AiProvider; model: string; ok: boolean; error?: string; skipped?: boolean }>;
  usage: ProviderUsage;
  caching: CachingReport;
  disagreement: boolean;
  candidateCount: number;
};

export type StructuredAiTask<T> = {
  kind: string;
  systemPrompt: string;
  userPrompt: string;
  schemaDescription: string;
  media?: AiMedia;
  requiresFreshData?: boolean;
  highStakes?: boolean;
  validate: (value: unknown) => T;
};

type RawProviderResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

// Coarse per-provider fallback prices (USD per million tokens) for models not in
// the registry. The registry's per-model pricing is preferred when available.
const PRICE_PER_MILLION: Record<AiProvider, { input: number; output: number }> = {
  anthropic: { input: 5, output: 25 },
  gemini: { input: 2.5, output: 15 },
  openai: { input: 5, output: 20 },
  xai: { input: 5, output: 25 },
  deepseek: { input: 1, output: 4 },
};

function priceFor(provider: AiProvider, model: string): { input: number; output: number; cachedInput: number } {
  const entry = getModelEntry(provider as RegistryProvider, model);
  if (entry?.pricing) {
    return {
      input: entry.pricing.inputPerMTokUsd,
      output: entry.pricing.outputPerMTokUsd,
      cachedInput: entry.pricing.cachedInputPerMTokUsd ?? entry.pricing.inputPerMTokUsd,
    };
  }
  const p = PRICE_PER_MILLION[provider];
  return { input: p.input, output: p.output, cachedInput: p.input };
}

function estimateCost(
  provider: AiProvider,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
): number {
  const price = priceFor(provider, model);
  // Cache-read tokens are billed at the discounted rate; the rest at full price.
  const freshInput = Math.max(0, inputTokens - cacheReadTokens);
  return (
    (freshInput * price.input + cacheReadTokens * price.cachedInput + outputTokens * price.output) /
    1_000_000
  );
}

// Conservative worst-case cost of a single role, for the Ultimate pre-flight
// budget guard (before any tokens are known). Assumes a large prompt + full
// output so the parallel batch can't blow the per-task cap.
const ASSUMED_INPUT_TOKENS = 8000;
const ASSUMED_OUTPUT_TOKENS = 8192;
function worstCaseCostUsd(provider: AiProvider, model: string): number {
  return estimateCost(provider, model, ASSUMED_INPUT_TOKENS, ASSUMED_OUTPUT_TOKENS, 0);
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* continue */ }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return JSON.parse(fenced.trim());
  const start = Math.min(...['{', '['].map((token) => { const i = trimmed.indexOf(token); return i < 0 ? Number.POSITIVE_INFINITY : i; }));
  if (!Number.isFinite(start)) throw new Error('Provider did not return JSON');
  const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (end < start) throw new Error('Provider returned incomplete JSON');
  return JSON.parse(trimmed.slice(start, end + 1));
}

function providerEndpoint(provider: Exclude<AiProvider, 'anthropic' | 'gemini'>): string {
  if (provider === 'openai') return 'https://api.openai.com/v1/chat/completions';
  if (provider === 'xai') return 'https://api.x.ai/v1/chat/completions';
  return 'https://api.deepseek.com/chat/completions';
}

async function callAnthropic(role: ModelRole, key: string, task: StructuredAiTask<unknown>, cachingEnabled: boolean): Promise<RawProviderResult> {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: `${task.userPrompt}\n\nReturn only JSON matching this schema:\n${task.schemaDescription}` }];
  if (task.media) {
    content.push(task.media.mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: task.media.base64 } }
      : { type: 'image', source: { type: 'base64', media_type: task.media.mediaType, data: task.media.base64 } });
  }
  // Prompt caching: only when enabled AND the registry says this model supports
  // explicit cache_control. Cache the (stable, reused) system prompt.
  const useCache = cachingEnabled && supportsPromptCaching('anthropic', role.model);
  const system = useCache
    ? [{ type: 'text', text: task.systemPrompt, cache_control: { type: 'ephemeral' } }]
    : task.systemPrompt;
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: role.model, max_tokens: 8192, system, messages: [{ role: 'user', content }] }),
  });
  if (!response.ok) throw new Error(`Anthropic ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const json = await response.json() as { content?: Array<{ type?: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
  const text = (json.content ?? []).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n');
  return {
    text,
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
    cacheReadTokens: json.usage?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: json.usage?.cache_creation_input_tokens ?? 0,
  };
}

async function callGemini(role: ModelRole, key: string, task: StructuredAiTask<unknown>): Promise<RawProviderResult> {
  const parts: Array<Record<string, unknown>> = [{ text: `${task.systemPrompt}\n\n${task.userPrompt}\n\nReturn only JSON matching this schema:\n${task.schemaDescription}` }];
  if (task.media) parts.push({ inline_data: { mime_type: task.media.mediaType, data: task.media.base64 } });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(role.model)}:generateContent?key=${encodeURIComponent(key)}`;
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8192 } }) });
  if (!response.ok) throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const json = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number } };
  const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('\n') ?? '';
  return { text, inputTokens: json.usageMetadata?.promptTokenCount ?? 0, outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0, cacheReadTokens: json.usageMetadata?.cachedContentTokenCount ?? 0, cacheCreationTokens: 0 };
}

async function callOpenAiCompatible(role: ModelRole, key: string, task: StructuredAiTask<unknown>): Promise<RawProviderResult> {
  if (task.media?.mediaType === 'application/pdf') throw new Error(`${role.provider} PDF input is not enabled; use Gemini or Anthropic`);
  const userContent: unknown = task.media
    ? [{ type: 'text', text: `${task.userPrompt}\n\nReturn only JSON matching this schema:\n${task.schemaDescription}` }, { type: 'image_url', image_url: { url: `data:${task.media.mediaType};base64,${task.media.base64}` } }]
    : `${task.userPrompt}\n\nReturn only JSON matching this schema:\n${task.schemaDescription}`;
  const response = await fetch(providerEndpoint(role.provider as Exclude<AiProvider, 'anthropic' | 'gemini'>), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: role.model, messages: [{ role: 'system', content: task.systemPrompt }, { role: 'user', content: userContent }], response_format: { type: 'json_object' }, temperature: 0, max_tokens: 8192 }),
  });
  if (!response.ok) throw new Error(`${role.provider} ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const json = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; prompt_cache_hit_tokens?: number } };
  // OpenAI reports automatic cache hits under prompt_tokens_details.cached_tokens;
  // DeepSeek uses prompt_cache_hit_tokens. Both are server-side (no client action).
  const cacheReadTokens = json.usage?.prompt_tokens_details?.cached_tokens ?? json.usage?.prompt_cache_hit_tokens ?? 0;
  return { text: json.choices?.[0]?.message?.content ?? '', inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0, cacheReadTokens, cacheCreationTokens: 0 };
}

async function callProvider(role: ModelRole, key: string, task: StructuredAiTask<unknown>, cachingEnabled: boolean): Promise<RawProviderResult> {
  if (role.provider === 'anthropic') return callAnthropic(role, key, task, cachingEnabled);
  if (role.provider === 'gemini') return callGemini(role, key, task);
  return callOpenAiCompatible(role, key, task);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export async function executeStructuredAiTask<T>(task: StructuredAiTask<T>): Promise<StructuredAiResult<T>> {
  const profile = await getAiRoutingProfile();
  const plan = buildExecutionPlan(profile, { kind: task.kind, hasImages: Boolean(task.media), requiresFreshData: task.requiresFreshData, highStakes: task.highStakes });
  const attempts: StructuredAiResult<T>['attempts'] = [];
  const cachingEnabled = plan.promptCaching;
  const isPdf = task.media?.mediaType === 'application/pdf';
  let spent = 0;
  let cacheReadTotal = 0;
  let cacheCreationTotal = 0;
  let cacheSavings = 0;

  const candidates: Array<{ role: ModelRole; value: T; usage: ProviderUsage }> = [];

  const runRole = async (
    role: ModelRole,
    opts: { ignoreBudget?: boolean } = {},
  ): Promise<{ role: ModelRole; value: T; usage: ProviderUsage } | null> => {
    const provider = role.provider as AiProvider;
    // Do not silently send a PDF to a provider that cannot read PDFs — skip it.
    if (isPdf && !supportsPdf(provider as RegistryProvider, role.model)) {
      attempts.push({ provider, model: role.model, ok: false, skipped: true, error: 'skipped: provider/model does not support PDF input' });
      return null;
    }
    // Skip (do not fail on) a provider whose key is not configured. A missing key
    // must never abort the task when another provider can serve the request.
    const key = await loadAiProviderKey(provider);
    if (!key) { attempts.push({ provider, model: role.model, ok: false, skipped: true, error: 'skipped: no API key configured' }); return null; }
    // Per-task budget guard. The final fallback (last role, still zero candidates)
    // is allowed to run over the cap so a legitimate task is never left with zero
    // viable providers purely because an earlier failed attempt spent the budget.
    if (spent >= profile.maxTaskCostUsd) {
      if (opts.ignoreBudget) {
        console.warn(`[ai-executor] per-task cost cap $${profile.maxTaskCostUsd.toFixed(2)} reached, but no provider has succeeded for "${task.kind}" — running final fallback ${provider}/${role.model} anyway to avoid a spurious total failure.`);
      } else {
        attempts.push({ provider, model: role.model, ok: false, skipped: true, error: 'skipped: per-task spending limit reached' });
        return null;
      }
    }

    // One concrete call at a given model id. Mutates the running cost/cache
    // totals; throws on HTTP error, budget overflow, or validation failure.
    const attemptWith = async (model: string): Promise<{ value: T; usage: ProviderUsage }> => {
      const raw = await callProvider({ ...role, model }, key, task as StructuredAiTask<unknown>, cachingEnabled);
      const usage: ProviderUsage = {
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        estimatedCostUsd: estimateCost(provider, model, raw.inputTokens, raw.outputTokens, raw.cacheReadTokens),
        cacheReadTokens: raw.cacheReadTokens,
        cacheCreationTokens: raw.cacheCreationTokens,
      };
      spent += usage.estimatedCostUsd;
      cacheReadTotal += raw.cacheReadTokens;
      cacheCreationTotal += raw.cacheCreationTokens;
      const price = priceFor(provider, model);
      cacheSavings += (raw.cacheReadTokens * Math.max(0, price.input - price.cachedInput)) / 1_000_000;
      if (!opts.ignoreBudget && spent > profile.maxTaskCostUsd) throw new Error(`Estimated task cost exceeded $${profile.maxTaskCostUsd.toFixed(2)} limit`);
      const value = task.validate(extractJson(raw.text));
      return { value, usage };
    };

    try {
      let modelUsed = role.model;
      let outcome: { value: T; usage: ProviderUsage };
      try {
        outcome = await attemptWith(role.model);
      } catch (err) {
        // resolveModel() swaps deprecated ids at plan time, but an "enabled" id
        // can still 404 in the wild. On a model-unavailable error, retry once
        // with the provider's known-good default before giving up on the role.
        const fallbackModel = defaultModelFor(provider as RegistryProvider);
        if (isModelUnavailableError(err) && fallbackModel && fallbackModel !== role.model) {
          attempts.push({ provider, model: role.model, ok: false, error: `model unavailable — retrying ${fallbackModel}: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}` });
          modelUsed = fallbackModel;
          outcome = await attemptWith(fallbackModel);
        } else {
          throw err;
        }
      }
      attempts.push({ provider, model: modelUsed, ok: true });
      return { role: modelUsed === role.model ? role : { ...role, model: modelUsed }, value: outcome.value, usage: outcome.usage };
    } catch (error) {
      attempts.push({ provider, model: role.model, ok: false, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };

  let analysisRoles = plan.steps.filter((role) => role.purpose.toLowerCase().includes('synthesis') === false);
  // Route PDFs to PDF-capable providers first (still keep others as fallbacks).
  if (isPdf) {
    analysisRoles = [...analysisRoles].sort(
      (a, b) => Number(supportsPdf(b.provider as RegistryProvider, b.model)) - Number(supportsPdf(a.provider as RegistryProvider, a.model)),
    );
  }

  if (profile.mode === 'ultimate') {
    // Pre-flight budget guard: parallel roles all fire at once, so the running
    // `spent` check can't stop them mid-flight. Select, in priority order, only
    // the roles whose conservative worst-case cost fits the per-task cap.
    const selected: ModelRole[] = [];
    let projected = 0;
    for (const role of analysisRoles) {
      const worst = worstCaseCostUsd(role.provider as AiProvider, role.model);
      if (projected + worst <= profile.maxTaskCostUsd || selected.length === 0) {
        selected.push(role);
        projected += worst;
      } else {
        attempts.push({ provider: role.provider as AiProvider, model: role.model, ok: false, error: 'Skipped to stay within the per-task budget' });
      }
    }
    const results = await Promise.all(selected.map((role) => runRole(role)));
    for (const r of results) if (r) candidates.push(r);
  } else {
    for (let i = 0; i < analysisRoles.length; i++) {
      const role = analysisRoles[i]!;
      // The last remaining role, with nothing succeeded yet, is the final hope:
      // let it run even if the running spend has hit the cap.
      const isLastHope = candidates.length === 0 && i === analysisRoles.length - 1;
      const candidate = await runRole(role, { ignoreBudget: isLastHope });
      if (candidate) candidates.push(candidate);
    }
  }

  if (!candidates.length) {
    const reasons = attempts.map((attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error ?? 'failed'}`).join('; ');
    const message = `No configured AI provider completed ${task.kind}. ${reasons}`;
    lastAiError = { kind: task.kind, message: message.slice(0, 500), at: new Date().toISOString() };
    throw new Error(message);
  }
  // A task that reached at least one usable provider clears the standing failure.
  lastAiError = null;

  const distinct = new Set(candidates.map((candidate) => canonical(candidate.value)));
  let chosen = candidates[0]!;
  const synthesisRole = plan.steps.find((role) => role.purpose.toLowerCase().includes('synthesis'));
  if (profile.mode === 'ultimate' && candidates.length > 1 && synthesisRole) {
    const synthesisTask: StructuredAiTask<T> = {
      ...task,
      media: undefined,
      userPrompt: `Reconcile these independently extracted candidates. Preserve supported details, correct arithmetic conflicts, and return one final JSON object. Explicitly do not invent missing data.\n\n${candidates.map((candidate, index) => `Candidate ${index + 1} (${candidate.role.provider}/${candidate.role.model}):\n${JSON.stringify(candidate.value)}`).join('\n\n')}`,
    };
    const originalTask = task;
    task = synthesisTask;
    const synthesized = await runRole(synthesisRole);
    task = originalTask;
    if (synthesized) chosen = synthesized;
  }

  // Honest caching report — measured from provider usage metadata, never a
  // fixed universal percentage.
  const cachingSupported = plan.steps.some((role) => cachingModeFor(role.provider as RegistryProvider, role.model) !== 'none');
  const caching: CachingReport = {
    supported: cachingSupported,
    enabled: cachingEnabled && cachingSupported,
    cacheReadTokens: cacheReadTotal,
    cacheCreationTokens: cacheCreationTotal,
    estimatedSavingsUsd: cacheReadTotal > 0 ? Number(cacheSavings.toFixed(6)) : 0,
  };

  return {
    value: chosen.value,
    provider: chosen.role.provider as AiProvider,
    model: chosen.role.model,
    attempts,
    usage: {
      inputTokens: candidates.reduce((sum, item) => sum + item.usage.inputTokens, 0),
      outputTokens: candidates.reduce((sum, item) => sum + item.usage.outputTokens, 0),
      estimatedCostUsd: spent,
      cacheReadTokens: cacheReadTotal,
      cacheCreationTokens: cacheCreationTotal,
    },
    caching,
    disagreement: distinct.size > 1,
    candidateCount: candidates.length,
  };
}
