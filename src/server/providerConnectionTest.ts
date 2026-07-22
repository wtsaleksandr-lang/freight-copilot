// Objective 6 — safe per-provider connection tests.
//
// Each test hits the provider's cheapest metadata endpoint (list models) with a
// short timeout. It sends NO freight data and incurs no meaningful billing. The
// result carries provider, success, the safe endpoint label, model (if any),
// latency, and a SANITIZED error — never tokens, credentials, or the
// key-bearing request URL.

import { loadAiKey, normalizeProvider, type AiProviderKey } from './apiKeysService.js';

export interface ConnectionTestResult {
  provider: AiProviderKey;
  success: boolean;
  /** Safe label only (e.g. "GET /v1/models") — never the full key-bearing URL. */
  endpoint: string;
  model: string | null;
  latencyMs: number;
  error: string | null;
}

interface Probe {
  url: (key: string) => string;
  headers: (key: string) => Record<string, string>;
  label: string;
  pickModel: (body: unknown) => string | null;
}

function firstDataId(body: unknown): string | null {
  const data = (body as { data?: Array<{ id?: string }> })?.data;
  return Array.isArray(data) && data[0]?.id ? String(data[0].id) : null;
}

const PROBES: Record<AiProviderKey, Probe> = {
  anthropic: {
    url: () => 'https://api.anthropic.com/v1/models',
    headers: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }),
    label: 'GET /v1/models',
    pickModel: firstDataId,
  },
  openai: {
    url: () => 'https://api.openai.com/v1/models',
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    label: 'GET /v1/models',
    pickModel: firstDataId,
  },
  xai: {
    url: () => 'https://api.x.ai/v1/models',
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    label: 'GET /v1/models',
    pickModel: firstDataId,
  },
  deepseek: {
    url: () => 'https://api.deepseek.com/models',
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    label: 'GET /models',
    pickModel: firstDataId,
  },
  gemini: {
    // Gemini takes the key as a query param — the URL is key-bearing and must
    // NEVER be returned or logged; we only ever expose `label`.
    url: (k) => `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(k)}`,
    headers: () => ({}),
    label: 'GET /v1beta/models',
    pickModel: (body) => {
      const models = (body as { models?: Array<{ name?: string }> })?.models;
      return Array.isArray(models) && models[0]?.name ? String(models[0].name) : null;
    },
  },
};

/** Remove the live key and any key-shaped token from a message. */
function sanitize(raw: string, key: string): string {
  let out = raw;
  if (key) out = out.split(key).join('[redacted]');
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{40,})\b/g, '[redacted]');
  return out.replace(/\s+/g, ' ').trim().slice(0, 200);
}

export interface ConnectionTestDeps {
  fetchImpl?: typeof fetch;
  getKey?: (provider: AiProviderKey) => Promise<string | undefined>;
  now?: () => number;
  timeoutMs?: number;
}

export async function testProviderConnection(
  providerRaw: string,
  deps: ConnectionTestDeps = {},
): Promise<ConnectionTestResult> {
  const provider = normalizeProvider(providerRaw);
  const probe = PROBES[provider];
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? 8000;
  const started = now();

  const key = (deps.getKey ? await deps.getKey(provider) : await loadAiKey(provider))?.trim();
  if (!key) {
    return {
      provider,
      success: false,
      endpoint: probe.label,
      model: null,
      latencyMs: 0,
      error: `No ${provider} key configured (add one to the vault or set ${provider.toUpperCase()}_API_KEY).`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(probe.url(key), {
      method: 'GET',
      headers: probe.headers(key),
      signal: controller.signal,
    });
    const latencyMs = now() - started;
    if (res.ok) {
      let model: string | null = null;
      try {
        model = probe.pickModel(await res.json());
      } catch {
        /* metadata parse is best-effort */
      }
      return { provider, success: true, endpoint: probe.label, model, latencyMs, error: null };
    }
    let detail = '';
    try {
      detail = sanitize(await res.text(), key);
    } catch {
      /* ignore body read failure */
    }
    let error: string;
    if (res.status === 401 || res.status === 403) {
      error = `Invalid or unauthorized API key (HTTP ${res.status}).`;
    } else if (res.status === 429) {
      error = `Rate limited (HTTP 429) — the key looks valid but the provider is throttling.`;
    } else {
      error = `HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
    }
    return { provider, success: false, endpoint: probe.label, model: null, latencyMs, error };
  } catch (err) {
    const latencyMs = now() - started;
    const aborted = err instanceof Error && err.name === 'AbortError';
    const message = aborted
      ? `Request timed out after ${timeoutMs}ms.`
      : sanitize(err instanceof Error ? err.message : String(err), key);
    return { provider, success: false, endpoint: probe.label, model: null, latencyMs, error: message };
  } finally {
    clearTimeout(timer);
  }
}
