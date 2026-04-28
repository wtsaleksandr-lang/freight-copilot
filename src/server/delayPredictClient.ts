/**
 * Client for the DelayPredict app (separate repo). Reads tracking status
 * for each freight-copilot shipment by joining on personal_ref → refId.
 *
 * Failure-tolerant: if DelayPredict isn't running or returns an error,
 * we silently fall through. The Shipments grid renders "Not tracked"
 * for every row in that case.
 */
import { loadEnv } from '../config.js';

export interface DelayPredictShipment {
  id?: string;
  personal_ref?: string;
  status?: 'planned' | 'in_transit' | 'delivered' | 'delayed' | 'cancelled';
  eta?: string;
  etd?: string;
  actual_arrival?: string;
  actual_delay_days?: number | null;
  predicted_arrival?: string;
  predicted_delay_days?: number | null;
  vessel_name?: string;
  vessel_mmsi?: string;
  tracking_last_event_at?: string;
  risk_score?: number | null;
  recommendation?: string;
}

export interface DelayPredictBadge {
  /** UI color: green / yellow / red / orange / check / gray */
  color: 'green' | 'yellow' | 'red' | 'orange' | 'check' | 'gray';
  label: string;
  /** Underlying DelayPredict shipment, or null if not tracked. */
  data: DelayPredictShipment | null;
}

interface CacheEntry {
  fetchedAt: number;
  byRef: Map<string, DelayPredictShipment>;
}

const CACHE_TTL_MS = 60_000;
let cache: CacheEntry | null = null;

function baseUrl(): string | null {
  const env = loadEnv();
  if (!env.DELAYPREDICT_URL) return null;
  return env.DELAYPREDICT_URL.replace(/\/$/, '');
}

export function invalidateDelayPredictCache(): void {
  cache = null;
}

async function fetchAllShipments(): Promise<Map<string, DelayPredictShipment>> {
  const url = baseUrl();
  if (!url) return new Map();
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.byRef;
  }
  try {
    const r = await fetch(`${url}/api/shipments`, {
      // Keep the request snappy; if DelayPredict is slow, abort and serve
      // stale cache rather than blocking the dashboard render.
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) {
      console.warn(`[delayPredict] /api/shipments returned ${r.status}`);
      return cache?.byRef ?? new Map();
    }
    const body = (await r.json()) as unknown;
    const list: DelayPredictShipment[] = Array.isArray(body)
      ? (body as DelayPredictShipment[])
      : Array.isArray((body as { shipments?: unknown[] }).shipments)
        ? ((body as { shipments: DelayPredictShipment[] }).shipments)
        : [];
    const map = new Map<string, DelayPredictShipment>();
    for (const s of list) {
      const ref = (s.personal_ref ?? '').trim();
      if (ref) map.set(ref, s);
    }
    cache = { fetchedAt: Date.now(), byRef: map };
    return map;
  } catch (err) {
    console.warn('[delayPredict] fetch failed:', err);
    return cache?.byRef ?? new Map();
  }
}

/** Map a DelayPredict shipment to a UI badge (color + short label). */
export function classify(s: DelayPredictShipment | undefined): DelayPredictBadge {
  if (!s) return { color: 'gray', label: 'Not tracked', data: null };
  if (s.status === 'delivered') {
    return { color: 'check', label: 'Delivered', data: s };
  }
  if (s.status === 'cancelled') {
    return { color: 'orange', label: 'Cancelled', data: s };
  }
  const delay = Number(s.actual_delay_days ?? s.predicted_delay_days ?? 0);
  if (s.status === 'delayed' || delay >= 3) {
    return {
      color: 'red',
      label: delay > 0 ? `Delayed ${Math.round(delay)}d` : 'Delayed',
      data: s,
    };
  }
  const risk = Number(s.risk_score ?? 0);
  if (delay >= 1 || risk >= 70) {
    return { color: 'yellow', label: 'Watch', data: s };
  }
  return { color: 'green', label: 'On track', data: s };
}

export async function getDelayPredictBadgeMap(): Promise<
  Map<string, DelayPredictBadge>
> {
  const ships = await fetchAllShipments();
  const out = new Map<string, DelayPredictBadge>();
  for (const [ref, s] of ships.entries()) {
    out.set(ref, classify(s));
  }
  return out;
}

export async function getDelayPredictBadge(
  refId: string
): Promise<DelayPredictBadge> {
  const ships = await fetchAllShipments();
  return classify(ships.get(refId));
}

/**
 * Trigger a tracking refresh on DelayPredict for the given freight-copilot
 * refId. Looks up DelayPredict's internal `id` by personal_ref, then POSTs
 * /api/shipments/:id/refresh-tracking. Returns the new badge.
 */
export async function refreshDelayPredictTracking(
  refId: string
): Promise<DelayPredictBadge> {
  const url = baseUrl();
  if (!url) return { color: 'gray', label: 'DelayPredict not configured', data: null };
  const ships = await fetchAllShipments();
  const target = ships.get(refId);
  if (!target?.id) {
    return { color: 'gray', label: 'Not tracked yet', data: null };
  }
  try {
    await fetch(`${url}/api/shipments/${target.id}/refresh-tracking`, {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    console.warn('[delayPredict] refresh failed:', err);
  }
  // Force a fresh pull next call.
  invalidateDelayPredictCache();
  return getDelayPredictBadge(refId);
}
