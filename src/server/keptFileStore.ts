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

/** LoadMode objects live under these key prefixes inside the shared bucket. */
const KEY_PREFIX = 'loadmode/rate-sheets';
const SHIPMENT_PREFIX = 'loadmode/shipments';
/** Any object the serve-back route is allowed to read must live under this. */
const ALLOWED_ROOT = 'loadmode/';
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

/**
 * Persist a shipment ATTACHMENT (the original booking document / image dropped
 * onto a shipment row). Prefers R2 so it survives redeploys; falls back to the
 * historical `shipments-files/` disk layout when R2 isn't configured.
 * `objectName` is the already-numbered "<n>-<filename>" the caller builds, so
 * the on-disk / R2 key matches the URL stored in the row's artifactsJson.
 */
export async function storeShipmentAttachment(input: {
  refId: string;
  objectName: string;
  bytes: Buffer;
  contentType: string;
}): Promise<StoredKeptFile> {
  if (isDurableStorageConfigured()) {
    const key = `${SHIPMENT_PREFIX}/${input.refId}/${input.objectName}`;
    const res = await r2Fetch('PUT', key, input.bytes, input.contentType);
    if (!res.ok) {
      throw new Error(`R2 PUT failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    return { backend: 'r2', key, servedUrl: `${KEPT_FILE_ROUTE}?key=${encodeURIComponent(key)}` };
  }
  const relPath = `${input.refId}/${input.objectName}`;
  const absPath = resolve(process.cwd(), 'shipments-files', relPath);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, input.bytes);
  return { backend: 'disk', key: relPath, servedUrl: `/shipments-files/${relPath}` };
}

/**
 * Read an attachment's bytes back from wherever it lives, given the URL stored
 * in artifactsJson. Handles both R2 (via the kept-file route + key) and the
 * legacy on-disk `shipments-files/` path. Returns null if it can't be found.
 */
export async function readAttachmentBytes(url: string): Promise<Buffer | null> {
  if (!url) return null;
  if (url.startsWith(KEPT_FILE_ROUTE)) {
    const m = url.match(/[?&]key=([^&]+)/);
    if (!m || !m[1]) return null;
    const got = await readKeptFile(decodeURIComponent(m[1]));
    return got ? got.bytes : null;
  }
  const rel = url.replace(/^\/shipments-files\//, '');
  if (rel === url) return null; // unrecognised URL shape
  try {
    return await readFile(resolve(process.cwd(), 'shipments-files', rel));
  } catch {
    return null;
  }
}

/** Read a kept/attachment file back for the serve-back route. */
export async function readKeptFile(
  key: string
): Promise<{ bytes: Buffer; contentType: string } | null> {
  // Guard: only ever serve objects under our own LoadMode root.
  if (!key.startsWith(ALLOWED_ROOT)) return null;
  if (!isDurableStorageConfigured()) return null;
  const res = await r2Fetch('GET', key);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    bytes: buf,
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
  };
}

/** Best-effort delete of a shipment attachment (R2 or disk) by its stored URL. */
export async function deleteAttachment(url: string): Promise<void> {
  if (!url) return;
  try {
    if (url.startsWith(KEPT_FILE_ROUTE)) {
      const m = url.match(/[?&]key=([^&]+)/);
      if (m && m[1] && isDurableStorageConfigured()) await r2Fetch('DELETE', decodeURIComponent(m[1]));
      return;
    }
    const rel = url.replace(/^\/shipments-files\//, '');
    if (rel !== url) await unlink(resolve(process.cwd(), 'shipments-files', rel));
  } catch {
    // best-effort — a missing object is fine.
  }
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
