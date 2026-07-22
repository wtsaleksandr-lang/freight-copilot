import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const KEY_FILE = resolve('./.secrets/secrets.key');
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;
let cachedSource: 'environment' | 'file' | 'generated' | null = null;

export function parseMasterKey(raw: string): Buffer {
  const value = raw.trim();
  if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === KEY_BYTES && decoded.toString('base64').replace(/=+$/,'') === value.replace(/=+$/,'')) return decoded;
  throw new Error('SECRETS_MASTER_KEY must be a 32-byte value encoded as 64 hex characters or base64');
}

/**
 * True when running as a real deployment, where a missing SECRETS_MASTER_KEY
 * must be a hard error rather than an auto-generated ephemeral key. Detects a
 * standard NODE_ENV=production and Replit's published-deployment flag.
 */
export function isProductionRuntime(): boolean {
  if (process.env.NODE_ENV === 'production') return true;
  const dep = process.env.REPLIT_DEPLOYMENT;
  return dep === '1' || dep === 'true';
}

/**
 * Clear, non-secret error thrown in production when no master key is set. Kept
 * as a named export so readiness/status code can recognise this exact failure
 * (a database row exists but is unreadable) instead of mislabelling it.
 */
export const MISSING_MASTER_KEY_MESSAGE =
  'SECRETS_MASTER_KEY is required in production. Refusing to auto-generate an ephemeral ' +
  'key because stored provider credentials would become permanently unreadable after the ' +
  'next redeploy. Set SECRETS_MASTER_KEY in your deployment Secrets (64 hex characters or a ' +
  '32-byte base64 value) and republish.';

async function loadOrCreateKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;

  const configured = process.env.SECRETS_MASTER_KEY?.trim();
  if (configured) {
    cachedKey = parseMasterKey(configured);
    cachedSource = 'environment';
    return cachedKey;
  }

  // In production we NEVER fabricate a key: a generated key would re-encrypt
  // secrets under an ephemeral value that the next redeploy wipes, making every
  // stored credential permanently unreadable. Fail with a clear setup error.
  if (isProductionRuntime()) {
    throw new Error(MISSING_MASTER_KEY_MESSAGE);
  }

  // --- development / local only below this line ---
  try {
    const hex = (await readFile(KEY_FILE, 'utf8')).trim();
    cachedKey = parseMasterKey(hex);
    cachedSource = 'file';
    return cachedKey;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  await mkdir(dirname(KEY_FILE), { recursive: true });
  const key = randomBytes(KEY_BYTES);
  await writeFile(KEY_FILE, key.toString('hex'), 'utf8');
  try {
    await chmod(KEY_FILE, 0o600);
  } catch {
    // chmod is best-effort on Windows
  }
  console.warn(
    '[secretsCrypto] DEVELOPMENT ONLY: SECRETS_MASTER_KEY is not set; generated a local ' +
      'fallback key at .secrets/secrets.key. This fallback is disabled in production — set ' +
      'SECRETS_MASTER_KEY in Secrets before deploying.',
  );
  cachedKey = key;
  cachedSource = 'generated';
  return key;
}

export function getSecretsKeySource(): 'environment' | 'file' | 'generated' | 'not_loaded' {
  return cachedSource ?? 'not_loaded';
}

/** Whether SECRETS_MASTER_KEY is present in the environment (no value exposed). */
export function isMasterKeyConfigured(): boolean {
  return Boolean(process.env.SECRETS_MASTER_KEY?.trim());
}

/**
 * Non-throwing description of the master-key state for readiness/UI. Never
 * returns or logs the key value. `productionSafe` is false only when running in
 * production with no configured key (the data-loss-risk case).
 */
export function describeMasterKey(): {
  configured: boolean;
  source: ReturnType<typeof getSecretsKeySource>;
  productionSafe: boolean;
} {
  const configured = isMasterKeyConfigured();
  return {
    configured,
    source: getSecretsKeySource(),
    productionSafe: configured || !isProductionRuntime(),
  };
}

/** Test-only: reset the in-process key cache so prod/dev branches can be exercised. */
export function __resetSecretsKeyCacheForTests(): void {
  cachedKey = null;
  cachedSource = null;
}

/** Encrypt plaintext with AES-256-GCM. Returns "iv:tag:ct" base64 segments. */
export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await loadOrCreateKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export async function decryptSecret(blob: string): Promise<string> {
  const key = await loadOrCreateKey();
  const parts = blob.split(':');
  if (parts.length !== 3) throw new Error('Malformed encrypted secret');
  const iv = Buffer.from(parts[0]!, 'base64');
  const tag = Buffer.from(parts[1]!, 'base64');
  const ct = Buffer.from(parts[2]!, 'base64');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Encrypted secret is stored but cannot be unlocked with the current master key');
  }
}
