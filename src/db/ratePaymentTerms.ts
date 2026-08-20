/**
 * Prepaid / Collect payment-term buckets for an ocean rate row.
 *
 * This is the rate-library analogue of the shipments Cost↔Sell charge-move
 * (see openBreakdownModal + the `/api/shipments/:refId/breakdown` op:'transfer'
 * in routes.ts). There the two buckets are Cost and Sell, each a jsonb column on
 * the shipment; a "transfer" splices one line out of one bucket and pushes it
 * into the other, and each total is recomputed as the exact sum of its lines.
 *
 * Here the two buckets are **Prepaid** (shipper pays at origin) and **Collect**
 * (consignee pays at destination) — the freight-payment terms — stored as the
 * `prepaid_charges` / `collect_charges` jsonb columns on `sheet_rates`. Moving a
 * charge flips which bucket it belongs to. All logic in this file is PURE (no
 * I/O) so the move + total-recompute can be unit-tested exactly like the
 * shipments breakdown logic.
 */

export interface PaymentCharge {
  name: string;
  amount: number;
  currency: string;
}

export type PaymentBucketName = 'prepaid' | 'collect';

export interface PaymentBuckets {
  prepaid: PaymentCharge[];
  collect: PaymentCharge[];
}

export interface PaymentBucketTotals {
  prepaidTotal: number;
  collectTotal: number;
  prepaidCurrency: string;
  collectCurrency: string;
}

function cleanCharge(c: unknown): PaymentCharge | null {
  if (!c || typeof c !== 'object') return null;
  const o = c as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name : '';
  const amount = Number(o.amount);
  const currency =
    typeof o.currency === 'string' && o.currency ? o.currency : 'USD';
  if (!name || !Number.isFinite(amount)) return null;
  return { name, amount, currency };
}

function cleanList(xs: unknown): PaymentCharge[] {
  if (!Array.isArray(xs)) return [];
  return xs.map(cleanCharge).filter((c): c is PaymentCharge => c !== null);
}

/**
 * Resolve the working prepaid/collect buckets for a rate. When the user has
 * never touched this rate (both stored columns null/undefined), seed the
 * buckets from the AI-parsed charge arrays with the sensible ocean default:
 * origin **freight** charges are Prepaid, **destination** charges are Collect.
 * Once either column has been written, the stored values are authoritative and
 * the freight/destination arrays are ignored.
 */
export function seedBuckets(opts: {
  freightCharges: unknown;
  destinationCharges: unknown;
  prepaidStored: unknown;
  collectStored: unknown;
}): PaymentBuckets {
  const hasStored =
    opts.prepaidStored != null || opts.collectStored != null;
  if (hasStored) {
    return {
      prepaid: cleanList(opts.prepaidStored),
      collect: cleanList(opts.collectStored),
    };
  }
  return {
    prepaid: cleanList(opts.freightCharges),
    collect: cleanList(opts.destinationCharges),
  };
}

/**
 * Move the line at `index` in the `from` bucket into the OTHER bucket, appended
 * at the end. Returns fresh arrays (never mutates the input). An out-of-range
 * index throws — the route validates and returns 400. Mirrors the shipments
 * op:'transfer' splice-and-push.
 */
export function moveCharge(
  buckets: PaymentBuckets,
  from: PaymentBucketName,
  index: number
): PaymentBuckets {
  const to: PaymentBucketName = from === 'prepaid' ? 'collect' : 'prepaid';
  const fromList = buckets[from].slice();
  const toList = buckets[to].slice();
  if (!Number.isInteger(index) || index < 0 || index >= fromList.length) {
    throw new Error('invalid index');
  }
  const [moved] = fromList.splice(index, 1);
  if (!moved) throw new Error('invalid index');
  toList.push(moved);
  const next: PaymentBuckets = { prepaid: [], collect: [] };
  next[from] = fromList;
  next[to] = toList;
  return next;
}

function sum(list: PaymentCharge[]): number {
  return Math.round(list.reduce((s, c) => s + (Number(c.amount) || 0), 0) * 100) / 100;
}

function dominantCurrency(list: PaymentCharge[]): string {
  return list.find((c) => c.currency)?.currency || 'USD';
}

/** Recompute each bucket's running total as the exact sum of its lines. */
export function bucketTotals(buckets: PaymentBuckets): PaymentBucketTotals {
  return {
    prepaidTotal: sum(buckets.prepaid),
    collectTotal: sum(buckets.collect),
    prepaidCurrency: dominantCurrency(buckets.prepaid),
    collectCurrency: dominantCurrency(buckets.collect),
  };
}
