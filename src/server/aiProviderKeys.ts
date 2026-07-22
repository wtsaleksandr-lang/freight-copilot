// Thin compatibility layer over the unified API-key vault (apiKeysService).
//
// Historically this module maintained its OWN provider list and env-fallback
// logic that disagreed with apiKeysService (it used the id `xai` while the
// vault used `grok`). Both now share one canonical provider set and one key
// resolver, so a key saved in the vault is always visible to the executor and
// readiness. This file remains as the executor/readiness entry point.

import {
  AI_PROVIDERS,
  loadAiKey,
  getProviderStatuses,
  type AiProviderKey,
} from './apiKeysService.js';

export type AiProvider = AiProviderKey;

/** All known providers (anthropic, gemini, openai, xai, deepseek). */
export const AI_PROVIDER_LIST: readonly AiProvider[] = AI_PROVIDERS;

/**
 * Resolve a usable key for a provider: in-app encrypted vault first, then the
 * environment fallback. Returns null when neither is available. Never logs the
 * value. Does not falsely report "missing" when a locked row exists — a locked
 * row transparently falls back to env inside loadAiKey.
 */
export async function loadAiProviderKey(provider: AiProvider): Promise<string | null> {
  return (await loadAiKey(provider)) ?? null;
}

/** Providers that can actually serve a key right now (vault or env fallback). */
export async function listConfiguredAiProviders(): Promise<AiProvider[]> {
  const statuses = await getProviderStatuses();
  return statuses.filter((s) => s.usable).map((s) => s.provider);
}
