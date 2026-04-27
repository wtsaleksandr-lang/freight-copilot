/**
 * In-memory live progress tracker for bundle runs.
 *
 * runQuoteBundle publishes per-carrier transitions here; the dashboard polls
 * /api/bundle/:refId/progress while a bundle is running to render a live
 * "5 carriers — 2 done, 1 running, 2 pending" UI.
 *
 * Entries auto-expire after 30 min so the map never grows unbounded.
 */

export type CarrierStage =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'captcha_blocked';

export interface CarrierProgress {
  code: string;
  name: string;
  stage: CarrierStage;
  reason?: string;
  rateCount?: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface BundleProgressEntry {
  refId: string;
  status: 'running' | 'done' | 'failed';
  carriers: CarrierProgress[];
  startedAt: number;
  finishedAt?: number;
}

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const store = new Map<string, BundleProgressEntry>();

function gc(): void {
  const now = Date.now();
  for (const [k, v] of store.entries()) {
    const age = now - (v.finishedAt ?? v.startedAt);
    if (age > TTL_MS) store.delete(k);
  }
}

export function initBundle(
  refId: string,
  carriers: Array<{ code: string; name: string }>
): void {
  store.set(refId, {
    refId,
    status: 'running',
    carriers: carriers.map((c) => ({
      code: c.code,
      name: c.name,
      stage: 'pending',
    })),
    startedAt: Date.now(),
  });
  gc();
}

export function updateCarrier(
  refId: string,
  code: string,
  patch: Partial<CarrierProgress>
): void {
  const entry = store.get(refId);
  if (!entry) return;
  const c = entry.carriers.find((x) => x.code === code);
  if (!c) return;
  Object.assign(c, patch);
}

export function finalizeBundle(
  refId: string,
  finalStatus: 'done' | 'failed'
): void {
  const entry = store.get(refId);
  if (!entry) return;
  entry.status = finalStatus;
  entry.finishedAt = Date.now();
}

export function getBundleProgress(refId: string): BundleProgressEntry | null {
  return store.get(refId) ?? null;
}
