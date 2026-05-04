// AI model orchestration. Resolution order applied EVERY call:
//   1. AI_MODE setting (default | power | custom) — sets a preset
//   2. If 'custom' (or unset): individual AI_PROVIDER / AI_MODEL /
//      AI_MODEL_FALLBACK settings from DB
//   3. .env vars
//   4. Built-in defaults (default mode = Gemini Flash + Pro fallback)
//
// MODES (curated mappings, picked for cost-efficiency-vs-capability
// on this app's specific workloads — vision-heavy PDF extraction,
// structured tool-use, occasional web-agent loops):
//
//   default — Gemini Flash for parsing (~$0.001/call, vision-strong),
//             Gemini Pro fallback when math validator catches an
//             error. Web agent uses Claude Haiku (Anthropic-only).
//             Target: <$5/month for typical use.
//
//   power   — Sonnet 4.6 for parsing + agent. Opus 4.7 fallback.
//             Use when tackling a tricky multi-page rate sheet or
//             a portal the agent struggles with. Toggle back when
//             done. Target: ~$15-30/month if used routinely.
//
//   custom  — user picks each model individually.

import { loadEnv } from '../config.js';

export type AiProvider = 'anthropic' | 'gemini';
export type AiMode = 'default' | 'power' | 'custom';

type AiConfig = {
  provider: AiProvider;
  model: string;
  fallback: string;
  /** The model used by the web agent (always Anthropic, regardless
   *  of `provider` — the agent loop is shaped around Claude). */
  agentModel: string;
  mode: AiMode;
};

const PRESETS: Record<Exclude<AiMode, 'custom'>, Omit<AiConfig, 'mode'>> = {
  default: {
    provider: 'gemini',
    model: 'gemini-2.0-flash',
    fallback: 'gemini-1.5-pro',
    agentModel: 'claude-haiku-4-5-20251001',
  },
  power: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    fallback: 'claude-opus-4-7',
    agentModel: 'claude-sonnet-4-6',
  },
};

async function loadFromDb(): Promise<{
  mode?: AiMode;
  provider?: AiProvider;
  model?: string;
  fallback?: string;
}> {
  try {
    const { getSetting } = await import('../server/appSettingsService.js');
    const [mode, provider, model, fallback] = await Promise.all([
      getSetting('AI_MODE'),
      getSetting('AI_PROVIDER'),
      getSetting('AI_MODEL'),
      getSetting('AI_MODEL_FALLBACK'),
    ]);
    const out: {
      mode?: AiMode;
      provider?: AiProvider;
      model?: string;
      fallback?: string;
    } = {};
    if (mode === 'default' || mode === 'power' || mode === 'custom') out.mode = mode;
    if (provider === 'anthropic' || provider === 'gemini') out.provider = provider;
    if (model) out.model = model;
    if (fallback) out.fallback = fallback;
    return out;
  } catch {
    return {};
  }
}

async function resolve(): Promise<AiConfig> {
  const env = loadEnv();
  const db = await loadFromDb();
  // Decide the mode. Default is 'default' (cheapest preset).
  const mode: AiMode = db.mode ?? 'default';
  if (mode !== 'custom') {
    return { ...PRESETS[mode], mode };
  }
  // Custom: each value falls through DB → env → default-preset value.
  return {
    provider: db.provider ?? env.AI_PROVIDER,
    model: db.model ?? env.AI_MODEL,
    fallback: db.fallback ?? env.AI_MODEL_FALLBACK,
    agentModel:
      db.provider === 'anthropic'
        ? (db.model ?? env.AI_MODEL)
        : PRESETS.default.agentModel,
    mode,
  };
}

export async function getProvider(): Promise<AiProvider> {
  return (await resolve()).provider;
}
export async function getModel(): Promise<string> {
  return (await resolve()).model;
}
export async function getFallbackModel(): Promise<string> {
  return (await resolve()).fallback;
}
export async function getAgentModel(): Promise<string> {
  return (await resolve()).agentModel;
}
export async function getMode(): Promise<AiMode> {
  return (await resolve()).mode;
}

/** True when the validator should retry with the fallback model. */
export async function fallbackEnabled(): Promise<boolean> {
  const c = await resolve();
  return c.fallback !== '' && c.fallback !== c.model;
}

/** Fetch the full resolved config in a single DB round-trip. */
export async function getAiConfig(): Promise<AiConfig> {
  return resolve();
}
