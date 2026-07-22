// Objective 9 — provider model registry (single source of truth for which
// model IDs are real, what they can do, roughly what they cost, and when we
// last verified them). Used to (a) keep the routing presets honest and (b) fall
// back to a known-good model at runtime instead of sending a speculative id
// that would 404/400.
//
// IMPORTANT: do not add a model here as `enabled` unless it is a real,
// currently-callable id for the account. Speculative / not-yet-confirmed ids go
// in as `experimental` so the runtime treats them as best-effort with fallback.

export type RegistryProvider = 'anthropic' | 'gemini' | 'openai' | 'xai' | 'deepseek';
export type ModelState = 'enabled' | 'experimental' | 'deprecated';
export type CachingMode = 'explicit' | 'automatic' | 'none';

export interface ModelEntry {
  provider: RegistryProvider;
  modelId: string;
  purpose: string;
  vision: boolean;
  pdf: boolean;
  webSearch: boolean;
  structuredOutput: boolean;
  state: ModelState;
  /** Approximate USD per million tokens — for budgeting only, not billing. */
  pricing?: { inputPerMTokUsd: number; outputPerMTokUsd: number; cachedInputPerMTokUsd?: number };
  /** How prompt caching works for this model: explicit (Anthropic cache_control),
   *  automatic (provider-side, no client action), or none/unsupported here. */
  caching: CachingMode;
  /** ISO date this entry was last checked against provider docs/knowledge. */
  lastVerified: string;
}

const V = '2026-01-15'; // knowledge-verified date for the `enabled` Anthropic/OpenAI/Gemini set

export const MODEL_REGISTRY: readonly ModelEntry[] = [
  // --- Anthropic (explicit prompt caching via cache_control) ---
  { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001', purpose: 'Fast, cheap vision+text workhorse', vision: true, pdf: true, webSearch: false, structuredOutput: true, state: 'enabled', pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 5, cachedInputPerMTokUsd: 0.1 }, caching: 'explicit', lastVerified: V },
  { provider: 'anthropic', modelId: 'claude-sonnet-5', purpose: 'Strong reasoning + planning', vision: true, pdf: true, webSearch: false, structuredOutput: true, state: 'enabled', pricing: { inputPerMTokUsd: 3, outputPerMTokUsd: 15, cachedInputPerMTokUsd: 0.3 }, caching: 'explicit', lastVerified: V },
  { provider: 'anthropic', modelId: 'claude-opus-4-8', purpose: 'Highest-depth reasoning for high-stakes work', vision: true, pdf: true, webSearch: false, structuredOutput: true, state: 'enabled', pricing: { inputPerMTokUsd: 15, outputPerMTokUsd: 75, cachedInputPerMTokUsd: 1.5 }, caching: 'explicit', lastVerified: V },
  // Legacy defaults still referenced by src/llm/model.ts — kept enabled (the
  // maintainer's declared production ids); runtime fallback protects if invalid.
  { provider: 'anthropic', modelId: 'claude-sonnet-4-6', purpose: 'Legacy fallback reasoner', vision: true, pdf: true, webSearch: false, structuredOutput: true, state: 'enabled', pricing: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 }, caching: 'explicit', lastVerified: V },
  { provider: 'anthropic', modelId: 'claude-opus-4-7', purpose: 'Legacy high-depth reasoner', vision: true, pdf: true, webSearch: false, structuredOutput: true, state: 'experimental', pricing: { inputPerMTokUsd: 15, outputPerMTokUsd: 75 }, caching: 'explicit', lastVerified: V },
  { provider: 'anthropic', modelId: 'claude-fable-5', purpose: 'Specialized generative model', vision: true, pdf: true, webSearch: false, structuredOutput: true, state: 'experimental', caching: 'explicit', lastVerified: V },

  // --- Google Gemini (context caching uses a different API — not applied here) ---
  { provider: 'gemini', modelId: 'gemini-2.0-flash', purpose: 'Fast vision+text extraction', vision: true, pdf: true, webSearch: true, structuredOutput: true, state: 'enabled', pricing: { inputPerMTokUsd: 0.1, outputPerMTokUsd: 0.4 }, caching: 'none', lastVerified: V },
  { provider: 'gemini', modelId: 'gemini-2.5-flash', purpose: 'Newer fast vision+text', vision: true, pdf: true, webSearch: true, structuredOutput: true, state: 'enabled', pricing: { inputPerMTokUsd: 0.15, outputPerMTokUsd: 0.6 }, caching: 'none', lastVerified: V },
  { provider: 'gemini', modelId: 'gemini-1.5-pro', purpose: 'Higher-quality Gemini', vision: true, pdf: true, webSearch: true, structuredOutput: true, state: 'enabled', pricing: { inputPerMTokUsd: 1.25, outputPerMTokUsd: 5 }, caching: 'none', lastVerified: V },
  { provider: 'gemini', modelId: 'gemini-3.1-pro', purpose: 'Next-gen Gemini (unconfirmed id)', vision: true, pdf: true, webSearch: true, structuredOutput: true, state: 'experimental', caching: 'none', lastVerified: V },

  // --- OpenAI (automatic server-side prompt caching) ---
  { provider: 'openai', modelId: 'gpt-4o', purpose: 'Strong multimodal reasoning', vision: true, pdf: false, webSearch: false, structuredOutput: true, state: 'enabled', pricing: { inputPerMTokUsd: 2.5, outputPerMTokUsd: 10, cachedInputPerMTokUsd: 1.25 }, caching: 'automatic', lastVerified: V },
  { provider: 'openai', modelId: 'gpt-4o-mini', purpose: 'Cheap multimodal', vision: true, pdf: false, webSearch: false, structuredOutput: true, state: 'enabled', pricing: { inputPerMTokUsd: 0.15, outputPerMTokUsd: 0.6, cachedInputPerMTokUsd: 0.075 }, caching: 'automatic', lastVerified: V },
  { provider: 'openai', modelId: 'gpt-5.6', purpose: 'Next-gen OpenAI (unconfirmed id)', vision: true, pdf: false, webSearch: false, structuredOutput: true, state: 'experimental', caching: 'automatic', lastVerified: V },

  // --- xAI (OpenAI-compatible; caching not applied here) ---
  { provider: 'xai', modelId: 'grok-2-latest', purpose: 'xAI general model', vision: false, pdf: false, webSearch: true, structuredOutput: true, state: 'experimental', pricing: { inputPerMTokUsd: 2, outputPerMTokUsd: 10 }, caching: 'none', lastVerified: V },
  { provider: 'xai', modelId: 'grok-4.3', purpose: 'Next-gen Grok (unconfirmed id)', vision: false, pdf: false, webSearch: true, structuredOutput: true, state: 'experimental', caching: 'none', lastVerified: V },

  // --- DeepSeek (OpenAI-compatible; caching automatic server-side) ---
  { provider: 'deepseek', modelId: 'deepseek-chat', purpose: 'Cheap reasoning + checks', vision: false, pdf: false, webSearch: false, structuredOutput: true, state: 'enabled', pricing: { inputPerMTokUsd: 0.27, outputPerMTokUsd: 1.1, cachedInputPerMTokUsd: 0.07 }, caching: 'automatic', lastVerified: V },
  { provider: 'deepseek', modelId: 'deepseek-reasoner', purpose: 'DeepSeek reasoning model', vision: false, pdf: false, webSearch: false, structuredOutput: true, state: 'enabled', pricing: { inputPerMTokUsd: 0.55, outputPerMTokUsd: 2.19 }, caching: 'automatic', lastVerified: V },
  { provider: 'deepseek', modelId: 'deepseek-v4-flash', purpose: 'Next-gen DeepSeek (unconfirmed id)', vision: false, pdf: false, webSearch: false, structuredOutput: true, state: 'experimental', caching: 'none', lastVerified: V },
];

/** Safest known-good (enabled) model per provider — the runtime fallback. */
const DEFAULT_ENABLED: Record<RegistryProvider, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  gemini: 'gemini-2.0-flash',
  openai: 'gpt-4o',
  xai: 'grok-2-latest',
  deepseek: 'deepseek-chat',
};

export function getModelEntry(provider: RegistryProvider, modelId: string): ModelEntry | undefined {
  return MODEL_REGISTRY.find((m) => m.provider === provider && m.modelId === modelId);
}

export function defaultModelFor(provider: RegistryProvider): string {
  return DEFAULT_ENABLED[provider];
}

/** True when the id is known to the registry and not deprecated. */
export function isModelUsable(provider: RegistryProvider, modelId: string): boolean {
  const entry = getModelEntry(provider, modelId);
  return Boolean(entry && entry.state !== 'deprecated');
}

/**
 * Resolve a requested model to one we will actually send. Known (enabled or
 * experimental) ids pass through — the executor tries them and falls back on
 * error. Unknown/deprecated ids are swapped for the provider's default enabled
 * model so we never send a completely made-up id.
 */
export function resolveModel(provider: RegistryProvider, requested: string): {
  model: string;
  substituted: boolean;
  state: ModelState | 'unknown';
} {
  const entry = getModelEntry(provider, requested);
  if (entry && entry.state !== 'deprecated') {
    return { model: requested, substituted: false, state: entry.state };
  }
  return { model: DEFAULT_ENABLED[provider], substituted: true, state: entry?.state ?? 'unknown' };
}

export function supportsPromptCaching(provider: RegistryProvider, modelId: string): boolean {
  return getModelEntry(provider, modelId)?.caching === 'explicit';
}

export function cachingModeFor(provider: RegistryProvider, modelId: string): CachingMode {
  return getModelEntry(provider, modelId)?.caching ?? 'none';
}

export function supportsPdf(provider: RegistryProvider, modelId: string): boolean {
  return Boolean(getModelEntry(provider, modelId)?.pdf);
}

export function supportsVision(provider: RegistryProvider, modelId: string): boolean {
  return Boolean(getModelEntry(provider, modelId)?.vision);
}
