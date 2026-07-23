/**
 * Durable store for the ORIGINAL uploaded files the user chooses to keep
 * (carrier rate sheets). Throwaway inputs (customer quote-request screenshots)
 * are never sent here — the caller discards them after parsing.
 *
 * Backend selection is automatic:
 *   - If Cloudflare R2 credentials are present in the environment, kept files
 *     go to R2 under the `loadmode/` prefix (durable, survives redeploys).
 *   - Otherwise they fall back to the local `parsed-sheets/` disk directory
 *     (the historical behaviour — works, but ephemeral on Replit).
 *
 * R2 is S3-compatible; we sign requests with AWS SigV4 using node:crypto so
 * there is no SDK dependency and nothing to install on the Replit container.
 */
import { createHash, createHmac } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_REGION = 'auto';
const R2_SERVICE = 's3';

/** All LoadMode objects live under this key prefix inside the shared bucket. */
const KEY_PREFIX = 'loadmode/rate-sheets';
/** Public serve-back route mounted in routes.ts. */
export const KEPT_FILE_ROUTE = '/api/kept-file';

export type KeptBackend = 'r2' | 'disk';
export interface StoredKeptFile {
  backend: KeptBackend;
  /** Storage key: R2 object key, or disk-relative path under parsed-sheets/. */
  key: string;
  /** URL the dashboard can link to (served behind the app's existing auth). */
  servedUrl: string;
}

export function isDurableStorageConfigured(): boolean {
  return Boolean(
    R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME
  );
}

// ---- SigV4 signing (S3 / R2) ------------------------------------------------

const sha256hex = (b: Buffer | string) =>
  createHash('sha256').update(b).digest('hex');
const hmac = (key: Buffer | string, s: string) =>
  createHmac('sha256', key).update(s).digest();
const encSeg = (seg: string) =>
  encodeURIComponent(seg).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );

async function r2Fetch(
  method: 'PUT' | 'GET' | 'DELETE',
  key: string,
  body: Buffer | '' = '',
  contentType?: string
): Promise<Response> {
  const url = new URL(R2_ENDPOINT as string);
  const host = url.host;
  const canonicalUri =
    '/' + [R2_BUCKET_NAME as string, ...key.split('/')].map(encSeg).join('/');
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);
  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (contentType && method === 'PUT') headers['content-type'] = contentType;
  const signedNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = signedNames
    .map((h) => {
      const entry = Object.entries(headers).find(
        ([k]) => k.toLowerCase() === h
      );
      return `${h}:${String(entry ? entry[1] : '').trim()}\n`;
    })
    .join('');
  const signedHeaders = signedNames.join(';');
  const canonicalRequest = [
    method,
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join('\n');
  let signingKey = hmac('AWS4' + (R2_SECRET_ACCESS_KEY as string), dateStamp);
  signingKey = hmac(signingKey, R2_REGION);
  signingKey = hmac(signingKey, R2_SERVICE);
  signingKey = hmac(signingKey, 'aws4_request');
  const signature = createHmac('sha256', signingKey)
    .update(stringToSign)
    .digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return fetch(url.origin + canonicalUri, {
    method,
    headers: { ...headers, Authorization: authorization },
    body:
      method === 'PUT'
        ? new Uint8Array(body as Buffer)
        : undefined,
  });
}

// ---- Public API -------------------------------------------------------------

function safeName(filename: string): string {
  return filename.replace(/[^a-z0-9._-]/gi, '_');
}

/** Persist a kept original file. Prefers R2, falls back to local disk. */
export async function storeKeptFile(input: {
  refId: string;
  index: number;
  filename: string;
  bytes: Buffer;
  contentType: string;
}): Promise<StoredKeptFile> {
  const name = `${input.index + 1}-${safeName(input.filename)}`;
  if (isDurableStorageConfigured()) {
    const key = `${KEY_PREFIX}/${input.refId}/${name}`;
    const res = await r2Fetch('PUT', key, input.bytes, input.contentType);
    if (!res.ok) {
      throw new Error(
        `R2 PUT failed (${res.status}): ${(await res.text()).slice(0, 200)}`
      );
    }
    return {
      backend: 'r2',
      key,
      servedUrl: `${KEPT_FILE_ROUTE}?key=${encodeURIComponent(key)}`,
    };
  }
  // Disk fallback — mirrors the historical parsed-sheets layout.
  const relPath = `${input.refId}/${name}`;
  const absPath = resolve(process.cwd(), 'parsed-sheets', relPath);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, input.bytes);
  return {
    backend: 'disk',
    key: relPath,
    servedUrl: `/parsed-sheets-files/${relPath}`,
  };
}

/** Read a kept file back for the serve-back route. */
export async function readKeptFile(
  key: string
): Promise<{ bytes: Buffer; contentType: string } | null> {
  // Guard: only ever serve objects under our own prefix.
  if (!key.startsWith(`${KEY_PREFIX}/`)) return null;
  if (!isDurableStorageConfigured()) return null;
  const res = await r2Fetch('GET', key);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    bytes: buf,
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
  };
}

/** Best-effort delete of a kept file (used when a user un-keeps one). */
export async function deleteKeptFile(
  backend: KeptBackend,
  key: string
): Promise<void> {
  try {
    if (backend === 'r2' && isDurableStorageConfigured()) {
      await r2Fetch('DELETE', key);
    } else if (backend === 'disk') {
      await unlink(resolve(process.cwd(), 'parsed-sheets', key));
    }
  } catch {
    // best-effort — a missing object is fine.
  }
}
