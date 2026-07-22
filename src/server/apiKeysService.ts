// API-key vault. Same encryption scheme as carrier credentials —
// AES-256-GCM with the master key from secretsCrypto. Plaintext keys never
// touch disk except briefly at decrypt time, and are NEVER returned to the
// browser, logs, errors, readiness, or tests (only a last-4 mask is exposed).
//
// Runtime read precedence (loadAiKey):
//   1. DB row for the provider (if present and decryptable)
//   2. process.env fallback (e.g. ANTHROPIC_API_KEY)
//   3. undefined → caller decides
//
// The .env fallback is preserved so existing deploys keep working; in-app
// encrypted keys take precedence over it.

import { eq } from 'drizzle-orm';
import { createDbClient } from '../db/client.js';
import { apiKeys } from '../db/schema.js';
import { encryptSecret, decryptSecret } from './secretsCrypto.js';

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

// Legacy alias: the vault UI previously stored xAI under the id 'grok'. We
// canonicalize to 'xai' (matching the routing/readiness side) but still accept
// 'grok' on read/write so any pre-existing row keeps working.
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

export type ProviderState =
  | 'stored_usable' // DB row exists and decrypts — using the encrypted vault
  | 'env_fallback' // no usable vault row, but an env var provides the key
  | 'stored_locked' // DB row exists but cannot be decrypted (master-key mismatch)
  | 'missing'; // neither a vault row nor an env var

/**
 * Pure state classifier — no DB, no env, no crypto. Unit-testable in isolation
 * so CI (which has no DATABASE_URL / keys) can exercise every branch.
 */
export function classifyProviderState(input: {
  storedRow: boolean;
  decryptable: boolean;
  hasEnv: boolean;
}): ProviderState {
  if (input.storedRow && input.decryptable) return 'stored_usable';
  if (input.storedRow && !input.decryptable) return 'stored_locked';
  if (input.hasEnv) return 'env_fallback';
  return 'missing';
}

export interface ProviderStatus {
  provider: AiProviderKey;
  state: ProviderState;
  /** True when a request can obtain a key at runtime (vault OR env fallback). */
  usable: boolean;
  storedRow: boolean;
  hasEnv: boolean;
  envVar: string;
  label: string | null;
  /** Last-4 mask, only when the stored key decrypts. Never the full value. */
  keyMasked: string | null;
  updatedAt: string | null;
}

/**
 * Status for ALL five providers. Never throws on a single bad row: each row is
 * decrypted inside its own try/catch, so one locked key surfaces as
 * `stored_locked` instead of blanking the entire list (the previous bug).
 */
export async function getProviderStatuses(): Promise<ProviderStatus[]> {
  const rowByProvider = new Map<
    AiProviderKey,
    { keyEncrypted: string; label: string | null; updatedAt: Date }
  >();
  try {
    const db = createDbClient();
    const rows = await db.select().from(apiKeys);
    for (const row of rows) {
      if (!isKnownProvider(row.provider)) continue;
      rowByProvider.set(normalizeProvider(row.provider), {
        keyEncrypted: row.keyEncrypted,
        label: row.label,
        updatedAt: row.updatedAt,
      });
    }
  } catch {
    // DB unavailable — classify from env only below (never throw here).
  }

  const out: ProviderStatus[] = [];
  for (const provider of AI_PROVIDERS) {
    const envVar = ENV_VAR_FOR[provider];
    const hasEnv = Boolean(process.env[envVar]?.trim());
    const row = rowByProvider.get(provider);
    let decryptable = false;
    let keyMasked: string | null = null;
    if (row) {
      try {
        const plain = await decryptSecret(row.keyEncrypted);
        decryptable = true;
        keyMasked = plain.length > 4 ? '••••' + plain.slice(-4) : '••••';
      } catch {
        decryptable = false; // stored but locked — surfaced, not hidden
      }
    }
    const state = classifyProviderState({ storedRow: Boolean(row), decryptable, hasEnv });
    out.push({
      provider,
      state,
      // Runtime can serve a key when the vault row decrypts, or when an env
      // fallback exists (loadAiKey falls back to env if a row is locked).
      usable: state === 'stored_usable' || hasEnv,
      storedRow: Boolean(row),
      hasEnv,
      envVar,
      label: row?.label ?? null,
      keyMasked,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    });
  }
  return out;
}

export async function upsertApiKey(input: {
  provider: string;
  key: string;
  label?: string;
}): Promise<ProviderStatus> {
  const provider = normalizeProvider(input.provider);
  const trimmed = input.key.trim();
  if (!trimmed) throw new Error('Key is empty');
  const keyEncrypted = await encryptSecret(trimmed);
  const db = createDbClient();
  const existing = (await db.select().from(apiKeys).where(eq(apiKeys.provider, provider)))[0];
  if (existing) {
    await db
      .update(apiKeys)
      .set({ keyEncrypted, label: input.label ?? existing.label, updatedAt: new Date() })
      .where(eq(apiKeys.provider, provider));
  } else {
    await db.insert(apiKeys).values({ provider, keyEncrypted, label: input.label ?? null });
  }
  const statuses = await getProviderStatuses();
  return statuses.find((s) => s.provider === provider)!;
}

export async function deleteApiKey(provider: string): Promise<boolean> {
  const canonical = normalizeProvider(provider);
  const db = createDbClient();
  const result = await db.delete(apiKeys).where(eq(apiKeys.provider, canonical));
  const ra = (result as unknown as { rowsAffected?: number }).rowsAffected ?? 0;
  return ra > 0;
}

/**
 * Resolve the runtime API key for a provider — vault row takes precedence over
 * the env var. A locked (undecryptable) row falls back to env. Returns
 * undefined when neither yields a key. Never logs the value.
 */
export async function loadAiKey(provider: AiProviderKey | string): Promise<string | undefined> {
  const canonical = normalizeProvider(provider);
  try {
    const db = createDbClient();
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.provider, canonical));
    if (row) {
      try {
        return await decryptSecret(row.keyEncrypted);
      } catch {
        /* stored but locked — fall through to env */
      }
    }
  } catch {
    /* DB unavailable — fall through to env */
  }
  const env = process.env[ENV_VAR_FOR[canonical]];
  return env?.trim() ? env.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Objective 2 — safe, idempotent environment → encrypted-vault migration.
// Never deletes the env copy, never overwrites a decryptable stored key,
// reports provider names + action only (never values), stamps updated_at.
// ---------------------------------------------------------------------------

export type MigrationAction =
  | 'imported' // env value newly encrypted into the vault
  | 'already_stored' // a decryptable vault row already exists — left untouched
  | 'stored_locked' // a locked row exists — left untouched (not clobbered)
  | 'no_env'; // nothing to import

export interface MigrationResult {
  provider: AiProviderKey;
  action: MigrationAction;
  updatedAt: string | null;
}

/**
 * Pure decision function (no DB/env/crypto) — returns either a terminal action
 * or 'import' to signal the caller should encrypt + write. Unit-testable.
 */
export function decideMigrationAction(
  state: ProviderState,
  hasEnv: boolean,
  overwriteLocked = false,
): MigrationAction | 'import' {
  if (state === 'stored_usable') return 'already_stored';
  if (state === 'stored_locked' && !overwriteLocked) return 'stored_locked';
  if (!hasEnv) return 'no_env';
  return 'import';
}

export async function migrateEnvKeysToVault(options?: {
  overwriteLocked?: boolean;
}): Promise<MigrationResult[]> {
  const statuses = await getProviderStatuses();
  const db = createDbClient();
  const results: MigrationResult[] = [];
  for (const status of statuses) {
    const decision = decideMigrationAction(status.state, status.hasEnv, options?.overwriteLocked);
    if (decision !== 'import') {
      results.push({ provider: status.provider, action: decision, updatedAt: status.updatedAt });
      continue;
    }
    const envVal = process.env[status.envVar]?.trim();
    if (!envVal) {
      results.push({ provider: status.provider, action: 'no_env', updatedAt: status.updatedAt });
      continue;
    }
    const keyEncrypted = await encryptSecret(envVal);
    const now = new Date();
    if (status.storedRow) {
      await db
        .update(apiKeys)
        .set({ keyEncrypted, updatedAt: now })
        .where(eq(apiKeys.provider, status.provider));
    } else {
      await db.insert(apiKeys).values({
        provider: status.provider,
        keyEncrypted,
        label: 'Imported from environment',
      });
    }
    results.push({ provider: status.provider, action: 'imported', updatedAt: now.toISOString() });
  }
  return results;
}
