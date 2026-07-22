import { buildExecutionPlan, getAiRoutingProfile, type ModelRole } from '../server/aiRoutingService.js';
import { loadAiProviderKey, type AiProvider } from '../server/aiProviderKeys.js';

export type AiMedia = { mediaType: string; base64: string; filename?: string };
export type ProviderUsage = { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
export type StructuredAiResult<T> = {
  value: T;
  provider: AiProvider;
  model: string;
  attempts: Array<{ provider: AiProvider; model: string; ok: boolean; error?: string }>;
  usage: ProviderUsage;
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

type RawProviderResult = { text: string; inputTokens: number; outputTokens: number };

const PRICE_PER_MILLION: Record<AiProvider, { input: number; output: number }> = {
  anthropic: { input: 5, output: 25 },
  gemini: { input: 2.5, output: 15 },
  openai: { input: 5, output: 20 },
  xai: { input: 5, output: 25 },
  deepseek: { input: 1, output: 4 },
};

function estimateCost(provider: AiProvider, inputTokens: number, outputTokens: number): number {
  const price = PRICE_PER_MILLION[provider];
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
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

async function callAnthropic(role: ModelRole, key: string, task: StructuredAiTask<unknown>): Promise<RawProviderResult> {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: `${task.userPrompt}\n\nReturn only JSON matching this schema:\n${task.schemaDescription}` }];
  if (task.media) {
    content.push(task.media.mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: task.media.base64 } }
      : { type: 'image', source: { type: 'base64', media_type: task.media.mediaType, data: task.media.base64 } });
  }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: role.model, max_tokens: 8192, system: task.systemPrompt, messages: [{ role: 'user', content }] }),
  });
  if (!response.ok) throw new Error(`Anthropic ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const json = await response.json() as { content?: Array<{ type?: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
  const text = (json.content ?? []).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n');
  return { text, inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 };
}

async function callGemini(role: ModelRole, key: string, task: StructuredAiTask<unknown>): Promise<RawProviderResult> {
  const parts: Array<Record<string, unknown>> = [{ text: `${task.systemPrompt}\n\n${task.userPrompt}\n\nReturn only JSON matching this schema:\n${task.schemaDescription}` }];
  if (task.media) parts.push({ inline_data: { mime_type: task.media.mediaType, data: task.media.base64 } });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(role.model)}:generateContent?key=${encodeURIComponent(key)}`;
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8192 } }) });
  if (!response.ok) throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const json = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
  const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('\n') ?? '';
  return { text, inputTokens: json.usageMetadata?.promptTokenCount ?? 0, outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0 };
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
  const json = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  return { text: json.choices?.[0]?.message?.content ?? '', inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 };
}

async function callProvider(role: ModelRole, key: string, task: StructuredAiTask<unknown>): Promise<RawProviderResult> {
  if (role.provider === 'anthropic') return callAnthropic(role, key, task);
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
  let spent = 0;

  const runRole = async (role: ModelRole): Promise<{ role: ModelRole; value: T; usage: ProviderUsage } | null> => {
    const provider = role.provider as AiProvider;
    const key = await loadAiProviderKey(provider);
    if (!key) { attempts.push({ provider, model: role.model, ok: false, error: 'Provider key is not configured' }); return null; }
    if (spent >= profile.maxTaskCostUsd) { attempts.push({ provider, model: role.model, ok: false, error: 'Task spending limit reached' }); return null; }
    try {
      const raw = await callProvider(role, key, task as StructuredAiTask<unknown>);
      const usage: ProviderUsage = { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, estimatedCostUsd: estimateCost(provider, raw.inputTokens, raw.outputTokens) };
      spent += usage.estimatedCostUsd;
      if (spent > profile.maxTaskCostUsd) throw new Error(`Estimated task cost exceeded $${profile.maxTaskCostUsd.toFixed(2)} limit`);
      const value = task.validate(extractJson(raw.text));
      attempts.push({ provider, model: role.model, ok: true });
      return { role, value, usage };
    } catch (error) {
      attempts.push({ provider, model: role.model, ok: false, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };

  const analysisRoles = plan.steps.filter((role) => role.purpose.toLowerCase().includes('synthesis') === false);
  const candidates = profile.mode === 'ultimate'
    ? (await Promise.all(analysisRoles.map(runRole))).filter((item): item is NonNullable<typeof item> => Boolean(item))
    : [];

  if (profile.mode !== 'ultimate') {
    for (const role of analysisRoles) {
      const candidate = await runRole(role);
      if (candidate) candidates.push(candidate);
    }
  }

  if (!candidates.length) {
    const reasons = attempts.map((attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error ?? 'failed'}`).join('; ');
    throw new Error(`No configured AI provider completed ${task.kind}. ${reasons}`);
  }

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

  return {
    value: chosen.value,
    provider: chosen.role.provider as AiProvider,
    model: chosen.role.model,
    attempts,
    usage: { inputTokens: candidates.reduce((sum, item) => sum + item.usage.inputTokens, 0), outputTokens: candidates.reduce((sum, item) => sum + item.usage.outputTokens, 0), estimatedCostUsd: spent },
    disagreement: distinct.size > 1,
    candidateCount: candidates.length,
  };
}
