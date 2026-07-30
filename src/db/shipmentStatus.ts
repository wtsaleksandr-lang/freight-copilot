/**
 * Operational-status helpers — shared, pure, and DB-free so they can be unit
 * tested and reused by the server (self-heal backfill, import patch) and mirror
 * the front-end (public/app.js keeps its own inline copy — it can't import TS).
 *
 * MULTI-STATUS model: a shipment holds an ARRAY of operational statuses. The
 * empty array `[]` IS the "No status set" state — it is NOT a member value, so
 * "no status" can never coexist with a real status (exclusivity falls out for
 * free). Adding any real status makes the array non-empty; removing the last
 * real status returns it to `[]` which renders the neutral ⚪.
 */

/** Canonical status values, in lifecycle order. Keep stable — stored in the DB.
 *  Curated to two states: `booking` (booking/scheduling pickup) and `loaded`
 *  (loaded / invoice due). Older values (`sailed`, `invoiced`) collapse into
 *  `loaded` via STATUS_LEGACY_MAP so historical rows keep rendering. */
export const STATUS_VALUES = ['booking', 'loaded'] as const;
export type StatusValue = (typeof STATUS_VALUES)[number];

/**
 * Pre-rename / retired scalar values → canonical value. Mirrors the front-end
 * STATUS_LEGACY_MAP so a legacy row displays and filters under the new set.
 * `sailed` and `invoiced` were separate statuses before the collapse to two;
 * both now resolve to `loaded` (the "loaded · invoice due" stage).
 */
export const STATUS_LEGACY_MAP: Record<string, StatusValue> = {
  processing: 'booking',
  shipped: 'loaded',
  pending_invoice: 'loaded',
  pending_payment: 'loaded',
  sailed: 'loaded',
  invoiced: 'loaded',
};

/**
 * Normalize a single scalar to its canonical value. Unknown / free-text values
 * (e.g. an imported sheet's "PAID?") are returned as-is — the renderer maps any
 * unrecognized value to the neutral ⚪, matching the prior single-valued
 * behavior. Empty / null → null.
 */
export function normalizeStatus(value: unknown): string | null {
  const v = value == null ? '' : String(value).trim();
  if (v === '') return null;
  return STATUS_LEGACY_MAP[v] ?? v;
}

/**
 * A single legacy scalar → the multi-status array. Empty / null → `[]` (the
 * "No status set" state); a present scalar → a single-element array carrying
 * the canonical value. This is the exact mapping the boot backfill applies.
 */
export function legacyScalarToArray(value: unknown): string[] {
  const one = normalizeStatus(value);
  return one == null ? [] : [one];
}

/**
 * Coerce any stored/incoming shape into a clean status array: accepts an array
 * (normalizing + de-duping each member, dropping blanks) or a scalar (legacy
 * single value). Guarantees "no status" is never a stored member — blanks are
 * dropped, so an all-blank input collapses to `[]`.
 */
export function toStatusArray(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  const out: string[] = [];
  for (const item of raw) {
    const one = normalizeStatus(item);
    if (one != null && !out.includes(one)) out.push(one);
  }
  return out;
}

/**
 * Toggle a real status on/off in the array. Adding to `[]` → `[status]`;
 * removing the last member → `[]`. Order is preserved by lifecycle order. A
 * blank/none value is ignored (never stored as a member) — exclusivity is
 * enforced by the empty-array representation, not a sentinel.
 */
export function toggleStatus(list: readonly string[], value: string): string[] {
  const normalized = normalizeStatus(value);
  if (normalized == null) return toStatusArray(list); // "none" is not togglable
  const current = toStatusArray(list);
  const next = current.includes(normalized)
    ? current.filter((s) => s !== normalized)
    : [...current, normalized];
  // Re-sort into canonical lifecycle order so display is stable regardless of
  // click order. Unknown values sink to the end in insertion order.
  return next.slice().sort((a, b) => {
    const ia = STATUS_VALUES.indexOf(a as StatusValue);
    const ib = STATUS_VALUES.indexOf(b as StatusValue);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
}

/** Relative lifecycle rank of the two curated statuses (higher = further along).
 *  Used to auto-assign the FURTHEST-along status and to never downgrade. */
const STATUS_RANK: Record<string, number> = { booking: 1, loaded: 2 };

/** Milestone labels (lower-cased, matched by `includes`) that imply the shipment
 *  has reached the LOADED · invoice-due stage. */
const LOADED_TIER_MILESTONES = [
  'cargo loaded',
  'vgm filed',
  'vessel departed',
  'vessel arrived',
  'customs cleared',
  'invoiced',
  'payment received',
];
/** Milestone labels that imply the earlier BOOKING · scheduling-pickup stage. */
const BOOKING_TIER_MILESTONES = ['booking confirmed', 'si submitted', 'docs received'];

/**
 * PURE: derive an operational status from the AI's extracted milestone checklist
 * (`statusItems`). Only milestones whose `state` is 'done' count. Returns the
 * FURTHEST-along status the document evidences, or null when nothing maps (never
 * invent a status). This is what lets a dropped file auto-set the row's status.
 */
export function deriveStatusFromMilestones(
  items: ReadonlyArray<{ label?: string | null; state?: string | null }> | null | undefined
): StatusValue | null {
  if (!Array.isArray(items)) return null;
  let booking = false;
  let loaded = false;
  for (const it of items) {
    if (!it || String(it.state ?? '').trim().toLowerCase() !== 'done') continue;
    const label = String(it.label ?? '').trim().toLowerCase();
    if (!label) continue;
    if (LOADED_TIER_MILESTONES.some((m) => label.includes(m))) loaded = true;
    else if (BOOKING_TIER_MILESTONES.some((m) => label.includes(m))) booking = true;
  }
  if (loaded) return 'loaded';
  if (booking) return 'booking';
  return null;
}

/**
 * PURE: merge an auto-derived status into the shipment's current status array,
 * upgrading to the FURTHEST-along state without ever downgrading or wiping. A
 * null derived (document evidences nothing) leaves the current status untouched.
 * Returns a single-element array (or `[]`) — the curated model is one status per
 * shipment. Legacy stored values are normalized first.
 */
export function mergeAutoStatus(
  current: readonly string[] | null | undefined,
  derived: StatusValue | null
): string[] {
  const cur = toStatusArray(current ?? []);
  const curBest = cur.reduce((best, s) => Math.max(best, STATUS_RANK[s] ?? 0), 0);
  const derivedRank = derived ? STATUS_RANK[derived] ?? 0 : 0;
  if (derived && derivedRank > curBest) return [derived];
  return cur;
}

/** The sentinel filter value meaning "show only shipments with no status set". */
export const NO_STATUS_FILTER = '__none__';

/**
 * Filter predicate: does a shipment's status array match the selected filter?
 * - '' (All) → always true (the caller usually skips empty filters anyway).
 * - NO_STATUS_FILTER → the array is empty ("No status set").
 * - a real status → the array CONTAINS that status (normalized). This is the
 *   "array contains" semantics that replaces the old equality match.
 */
export function statusListMatchesFilter(list: unknown, filterValue: string): boolean {
  if (filterValue === '' || filterValue == null) return true;
  const arr = toStatusArray(list);
  if (filterValue === NO_STATUS_FILTER) return arr.length === 0;
  const want = normalizeStatus(filterValue);
  return want != null && arr.includes(want);
}

/**
 * The idempotent SQL that heals + backfills `operational_statuses`. Factored out
 * so the boot self-heal and the tests share one source of truth. The CASE
 * mirrors {@link STATUS_LEGACY_MAP}; only rows still lacking an array AND
 * carrying a non-empty legacy scalar are touched.
 */
export function backfillStatusesSql(): string {
  const cases = Object.entries(STATUS_LEGACY_MAP)
    .map(([from, to]) => `WHEN '${from}' THEN '${to}'`)
    .join(' ');
  return `UPDATE shipments
     SET operational_statuses = to_jsonb(ARRAY[
       CASE operational_status ${cases} ELSE operational_status END
     ])
     WHERE (operational_statuses IS NULL OR operational_statuses = '[]'::jsonb)
       AND operational_status IS NOT NULL
       AND operational_status <> ''`;
}
