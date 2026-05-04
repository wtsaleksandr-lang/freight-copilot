// API-key vault. Same encryption scheme as carrier credentials —
// AES-256-GCM with the key in .secrets/secrets.key. Plaintext keys
// never touch disk except briefly at decrypt time.
//
// Read precedence at runtime:
//   1. DB row for the provider (if present, fully decrypted)
//   2. process.env (e.g. ANTHROPIC_API_KEY)
//   3. undefined → caller decides what to do (usually throws)
//
// The .env path is preserved so existing deploys keep working until
// the user opts into the UI vault.

import { eq } from 'drizzle-orm';
import { createDbClient } from '../db/client.js';
import { apiKeys } from '../db/schema.js';
import { encryptSecret, decryptSecret } from './secretsCrypto.js';

export type AiProviderKey =
  | 'anthropic'
  | 'gemini'
  | 'openai'
  | 'deepseek'
  | 'grok';

const ENV_VAR_FOR: Record<AiProviderKey, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  grok: 'XAI_API_KEY',
};

const VALID: ReadonlySet<string> = new Set([
  'anthropic',
  'gemini',
  'openai',
  'deepseek',
  'grok',
]);

function assertProvider(p: string): asserts p is AiProviderKey {
  if (!VALID.has(p)) throw new Error(`Unknown AI provider: ${p}`);
}

export interface ApiKeySummary {
  provider: AiProviderKey;
  label: string | null;
  /** Just the last 4 characters so the user can sanity-check which
   *  key is loaded without exposing the full secret to the dashboard. */
  keyMasked: string;
  envFallback: string;
  hasEnvFallback: boolean;
  updatedAt: string;
}

export async function listApiKeys(): Promise<ApiKeySummary[]> {
  const db = createDbClient();
  const rows = await db.select().from(apiKeys);
  const out: ApiKeySummary[] = [];
  for (const row of rows) {
    const decrypted = await decryptSecret(row.keyEncrypted);
    const masked = decrypted.length > 4
      ? '••••' + decrypted.slice(-4)
      : '••••';
    const envVar = ENV_VAR_FOR[row.provider as AiProviderKey];
    out.push({
      provider: row.provider as AiProviderKey,
      label: row.label,
      keyMasked: masked,
      envFallback: envVar,
      hasEnvFallback: !!process.env[envVar],
      updatedAt: row.updatedAt.toISOString(),
    });
  }
  // Also surface providers that aren't stored but DO have an env var,
  // so the UI shows the user "Anthropic — using .env value" until they
  // override.
  for (const p of Object.keys(ENV_VAR_FOR) as AiProviderKey[]) {
    if (out.find((o) => o.provider === p)) continue;
    const envVar = ENV_VAR_FOR[p];
    if (process.env[envVar]) {
      out.push({
        provider: p,
        label: null,
        keyMasked: '(.env)',
        envFallback: envVar,
        hasEnvFallback: true,
        updatedAt: new Date(0).toISOString(),
      });
    }
  }
  return out;
}

export async function upsertApiKey(input: {
  provider: string;
  key: string;
  label?: string;
}): Promise<ApiKeySummary> {
  assertProvider(input.provider);
  const trimmed = input.key.trim();
  if (!trimmed) throw new Error('Key is empty');
  const keyEncrypted = await encryptSecret(trimmed);
  const db = createDbClient();
  const existing = (
    await db.select().from(apiKeys).where(eq(apiKeys.provider, input.provider))
  )[0];
  if (existing) {
    await db
      .update(apiKeys)
      .set({
        keyEncrypted,
        label: input.label ?? existing.label,
        updatedAt: new Date(),
      })
      .where(eq(apiKeys.provider, input.provider));
  } else {
    await db.insert(apiKeys).values({
      provider: input.provider,
      keyEncrypted,
      label: input.label ?? null,
    });
  }
  const all = await listApiKeys();
  return all.find((a) => a.provider === input.provider)!;
}

export async function deleteApiKey(provider: string): Promise<boolean> {
  assertProvider(provider);
  const db = createDbClient();
  const result = await db.delete(apiKeys).where(eq(apiKeys.provider, provider));
  const ra = (result as unknown as { rowsAffected?: number }).rowsAffected ?? 0;
  return ra > 0;
}

/** Resolve the runtime API key for a provider — DB takes precedence
 *  over env var. Returns undefined if neither is set. */
export async function loadAiKey(
  provider: AiProviderKey
): Promise<string | undefined> {
  try {
    const db = createDbClient();
    const row = (
      await db.select().from(apiKeys).where(eq(apiKeys.provider, provider))
    )[0];
    if (row) return await decryptSecret(row.keyEncrypted);
  } catch {
    /* fall through to env */
  }
  return process.env[ENV_VAR_FOR[provider]];
}
