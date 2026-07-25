// AI provider API keys — ENVIRONMENT ONLY.
//
// Keys live exclusively in environment Secrets (ANTHROPIC_API_KEY, etc.).
// There is no in-app encrypted vault and no SECRETS_MASTER_KEY for AI keys, so
// there is nothing that can ever show as "locked": a key is either present in
// the environment or it isn't. Replit Secrets are already encrypted at rest and
// persist across redeploys, which is why this is both simpler and safe.
//
// (Carrier login credentials are a separate feature and still use the encrypted
// store in credentialsService.ts — unrelated to these AI keys.)

export type AiProviderKey = 'anthropic' | 'gemini' | 'openai' | 'xai' | 'deepseek';

export const AI_PROVIDERS: readonly AiProviderKey[] = [
  'anthropic',
  'gemini',
  'openai',
  'xai',
  'deepseek',
];

const ENV_VAR_FOR: Record<AiProviderKey, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

// Legacy alias: xAI was once stored under 'grok'. Still accepted on read.
const PROVIDER_ALIASES: Record<string, AiProviderKey> = { grok: 'xai' };

export function envVarFor(provider: AiProviderKey): string {
  return ENV_VAR_FOR[provider];
}

export function isKnownProvider(p: string): boolean {
  const lower = p.trim().toLowerCase();
  const canonical = (PROVIDER_ALIASES[lower] ?? lower) as AiProviderKey;
  return (AI_PROVIDERS as readonly string[]).includes(canonical);
}

export function normalizeProvider(p: string): AiProviderKey {
  const lower = p.trim().toLowerCase();
  const canonical = (PROVIDER_ALIASES[lower] ?? lower) as AiProviderKey;
  if (!(AI_PROVIDERS as readonly string[]).includes(canonical)) {
    throw new Error(`Unknown AI provider: ${p}`);
  }
  return canonical;
}

// 'configured' = the env var is present; 'missing' = it isn't. That's the whole
// state space now — no vault, no locked state.
export type ProviderState = 'configured' | 'missing';

export interface ProviderStatus {
  provider: AiProviderKey;
  state: ProviderState;
  usable: boolean;
  hasEnv: boolean;
  envVar: string;
}

export function getProviderStatuses(): ProviderStatus[] {
  return AI_PROVIDERS.map((provider) => {
    const envVar = ENV_VAR_FOR[provider];
    const hasEnv = Boolean(process.env[envVar]?.trim());
    return { provider, state: hasEnv ? 'configured' : 'missing', usable: hasEnv, hasEnv, envVar };
  });
}

/**
 * Resolve the runtime API key for a provider from the environment. Returns
 * undefined when the env var isn't set. Never logs the value.
 */
export async function loadAiKey(provider: AiProviderKey | string): Promise<string | undefined> {
  const canonical = normalizeProvider(provider);
  const env = process.env[ENV_VAR_FOR[canonical]];
  return env?.trim() ? env.trim() : undefined;
}
