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

async function loadOrCreateKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;

  const configured = process.env.SECRETS_MASTER_KEY?.trim();
  if (configured) {
    cachedKey = parseMasterKey(configured);
    cachedSource = 'environment';
    return cachedKey;
  }

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
  console.warn('[secretsCrypto] SECRETS_MASTER_KEY is not configured; generated a local fallback key. Add this key to Replit Secrets before redeploying to prevent encrypted credentials from becoming unreadable.');
  cachedKey = key;
  cachedSource = 'generated';
  return key;
}

export function getSecretsKeySource(): 'environment' | 'file' | 'generated' | 'not_loaded' {
  return cachedSource ?? 'not_loaded';
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
