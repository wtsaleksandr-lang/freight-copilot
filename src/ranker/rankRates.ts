import type { RateOption, RankedRateOption } from '../types.js';

const CLOSE_PCT = 3;

/**
 * Rank rate options by headline price (ascending). Excludes options without a price.
 * Flags options within 3% of the lowest as "close_to_lowest" — worth a manual look.
 *
 * Intentionally currency-agnostic: Maersk Spot headline prices are typically all USD
 * for the same lane; if currencies differ we still sort numerically (with a warning
 * added in a future iteration).
 */
export function rankRates(rates: RateOption[]): RankedRateOption[] {
  const withPrice = rates.filter(
    (r): r is RateOption & { headline_price_amount: number } =>
      r.headline_price_amount != null && r.headline_price_amount > 0
  );

  const sorted = [...withPrice].sort(
    (a, b) => a.headline_price_amount - b.headline_price_amount
  );

  if (sorted.length === 0) return [];

  const lowest = sorted[0]!.headline_price_amount;

  return sorted.map((r, idx) => {
    const delta = r.headline_price_amount - lowest;
    const deltaPct = lowest > 0 ? (delta / lowest) * 100 : 0;
    return {
      ...r,
      rank: idx + 1,
      delta_from_lowest: delta,
      delta_pct: deltaPct,
      close_to_lowest: idx > 0 && deltaPct <= CLOSE_PCT,
    };
  });
}

export function formatRankedTable(ranked: RankedRateOption[]): string {
  if (ranked.length === 0) return '(no rates with prices found)';

  const rows = ranked.map((r) => {
    const price = r.headline_price_amount ?? 0;
    const currency = r.headline_price_currency ?? '';
    const priceStr = `${currency} ${price.toLocaleString()}`;
    const delta =
      r.rank === 1
        ? '—'
        : `+${r.delta_from_lowest.toFixed(0)} (+${r.delta_pct.toFixed(1)}%)`;
    const transit = r.transit_days != null ? `${r.transit_days}d` : '?';
    const flags: string[] = [];
    if (r.rollable) flags.push('Rollable');
    if (r.close_to_lowest) flags.push('≈lowest');
    const flagStr = flags.join(', ');

    return [
      `#${r.rank}`,
      r.sailing_date ?? '?',
      transit,
      r.vessel_voyage ?? '?',
      r.service_name,
      priceStr,
      delta,
      flagStr,
    ];
  });

  const headers = ['Rank', 'Sailing', 'Transit', 'Vessel/Voyage', 'Service', 'Price', 'Δ', 'Flags'];
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length))
  );
  const pad = (s: string, w: number) => s.padEnd(w);
  const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i]!)).join('  ');

  return [
    line(headers),
    line(widths.map((w) => '─'.repeat(w))),
    ...rows.map((r) => line(r)),
  ].join('\n');
}
