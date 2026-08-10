/**
 * Drayage rate-library ESTIMATOR — turns your archive of uploaded rate sheets
 * (drayage_rate_library) into a quote for a NEW lane, even when no exact
 * city/ZIP rate exists.
 *
 * The rule (Alex): "as long as the US STATE matches, reuse the old rates and
 * their $/mile to price the new route — don't be strict on city/postal code."
 *
 * So matching degrades gracefully by tier:
 *   exact_zip  → same delivery ZIP           (basically the real rate)
 *   city_state → same delivery city + state
 *   state      → same delivery STATE only    ← the fallback Alex wants
 * A row in a DIFFERENT state is never used. The estimate uses the TIGHTEST tier
 * that actually has samples, derives a median $/mile from those rows (each row's
 * total ÷ its own lane miles), and multiplies by the NEW lane's miles — so a
 * short lane isn't handed a long lane's flat dollar total.
 *
 * Pure + deterministic (no I/O) so it unit-tests cleanly; the route layer feeds
 * it candidates whose miles are already resolved (from stored total_miles or a
 * geocode+haversine computed and persisted upstream).
 */

/** How well a stored library row's DELIVERY end matches the target delivery. */
export type LibMatchTier = 'exact_zip' | 'city_state' | 'state';

const norm = (s?: string | null): string => (s ?? '').trim().toLowerCase();
const normState = (s?: string | null): string => (s ?? '').trim().toUpperCase();
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Tier the delivery-end match of a stored row against the target delivery.
 * STATE is the floor: a different (or missing) state → null (unusable). Within
 * the same state, prefer an exact ZIP, then city, else state-only.
 */
export function scoreDeliveryMatch(
  target: { city?: string | null; state?: string | null; zip?: string | null },
  row: { deliveryCity?: string | null; deliveryState?: string | null; deliveryZip?: string | null }
): LibMatchTier | null {
  const tState = normState(target.state);
  const rState = normState(row.deliveryState);
  if (!tState || !rState || tState !== rState) return null; // state must match
  const tZip = norm(target.zip);
  const rZip = norm(row.deliveryZip);
  if (tZip && rZip && tZip === rZip) return 'exact_zip';
  const tCity = norm(target.city);
  const rCity = norm(row.deliveryCity);
  if (tCity && rCity && tCity === rCity) return 'city_state';
  return 'state';
}

/**
 * Does a stored row's PICKUP reference the target origin PORT? Loose on purpose
 * (Alex: don't be strict) — matches if the port code or the port's city appears
 * in the row's pickup label/city/zip. `portCity` is the anchor city for the
 * code (from PORT_COORDS), passed in so this stays I/O-free.
 */
export function matchesOriginPort(
  portCode: string,
  portCity: string,
  row: { pickupLabel?: string | null; pickupCity?: string | null; pickupZip?: string | null }
): boolean {
  const hay = [row.pickupLabel, row.pickupCity, row.pickupZip].map(norm).join(' ');
  const code = norm(portCode);
  const city = norm(portCity);
  return (!!code && hay.includes(code)) || (!!city && hay.includes(city));
}

export function median(nums: number[]): number {
  if (!nums.length) return NaN;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  const mid = s[m] as number;
  if (s.length % 2) return mid;
  return ((s[m - 1] as number) + mid) / 2;
}

export interface EstimateCandidate {
  /** All-in stored total for this row, USD. */
  totalRate: number | null | undefined;
  /** This row's own lane miles (stored or computed). */
  miles: number | null | undefined;
  tier: LibMatchTier;
}

export interface LibraryEstimate {
  perMileMedian: number;
  estimatedTotal: number;
  sampleSize: number;
  tier: LibMatchTier;
}

/**
 * Derive a per-mile median from the candidates in the tightest tier that has
 * usable samples, and apply it to `targetMiles`. Returns null when there is
 * nothing usable (no candidate with a positive total AND positive miles).
 */
export function computeLibraryEstimate(
  targetMiles: number,
  candidates: EstimateCandidate[]
): LibraryEstimate | null {
  if (!(targetMiles > 0)) return null;
  const usable = candidates.filter(
    (c) =>
      typeof c.totalRate === 'number' &&
      (c.totalRate as number) > 0 &&
      typeof c.miles === 'number' &&
      (c.miles as number) > 0
  );
  if (!usable.length) return null;
  const order: LibMatchTier[] = ['exact_zip', 'city_state', 'state'];
  for (const tier of order) {
    const group = usable.filter((c) => c.tier === tier);
    if (group.length) {
      const perMiles = group.map((c) => (c.totalRate as number) / (c.miles as number));
      const pm = median(perMiles);
      return {
        perMileMedian: round2(pm),
        estimatedTotal: round2(pm * targetMiles),
        sampleSize: group.length,
        tier,
      };
    }
  }
  return null;
}
