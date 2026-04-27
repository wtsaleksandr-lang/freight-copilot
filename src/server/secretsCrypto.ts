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

async function loadOrCreateKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  try {
    const hex = (await readFile(KEY_FILE, 'utf8')).trim();
    if (hex.length !== KEY_BYTES * 2) {
      throw new Error(`secrets.key is not ${KEY_BYTES} bytes hex`);
    }
    cachedKey = Buffer.from(hex, 'hex');
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
  console.log(`[secretsCrypto] generated new key at ${KEY_FILE}`);
  cachedKey = key;
  return key;
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
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(
    ':'
  );
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
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
