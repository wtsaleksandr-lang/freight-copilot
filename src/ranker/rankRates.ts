import type { RateOption, RankedRateOption, RateCharge } from '../types.js';

const CLOSE_PCT = 3;
const HEADLINE_MISMATCH_PCT = 2;

/**
 * Deterministic sum of a list of charges, in their dominant currency.
 * If charges span multiple currencies (rare for Freight rows; common for
 * Destination), we sum each currency separately and return the largest bucket.
 */
function sumCharges(
  charges: RateCharge[]
): { total: number; currency: string | null } {
  if (charges.length === 0) return { total: 0, currency: null };
  const byCurrency = new Map<string, number>();
  for (const c of charges) {
    byCurrency.set(c.currency, (byCurrency.get(c.currency) ?? 0) + c.total);
  }
  // Pick the currency with the largest absolute total.
  let bestCcy = '';
  let bestTotal = -Infinity;
  for (const [ccy, t] of byCurrency) {
    if (t > bestTotal) {
      bestTotal = t;
      bestCcy = ccy;
    }
  }
  return { total: Math.round(bestTotal), currency: bestCcy || null };
}

/**
 * Rank rate options by FREIGHT cost (sum of itemized Freight charges if available;
 * falls back to headline price).
 *
 * Why prefer the breakdown sum: it matches what the user computes manually and
 * stays correct even when Maersk's headline is shown in a different currency
 * or includes non-freight items.
 */
export function rankRates(rates: RateOption[]): RankedRateOption[] {
  const ranked: RankedRateOption[] = rates
    .map((r) => {
      const freight = sumCharges(r.freight_charges);
      const dest = sumCharges(r.destination_charges);

      // Decide our rankable cost: prefer breakdown sum if we have it, else headline.
      const haveBreakdown = r.freight_charges.length > 0 && freight.total > 0;
      const rankCost = haveBreakdown
        ? freight.total
        : r.headline_price_amount ?? 0;
      const rankCcy = haveBreakdown
        ? freight.currency ?? r.headline_price_currency ?? 'USD'
        : r.headline_price_currency ?? 'USD';

      // Detect drift: breakdown vs headline mismatch >2%.
      let mismatch = false;
      if (
        haveBreakdown &&
        r.headline_price_amount != null &&
        r.headline_price_amount > 0
      ) {
        const diff = Math.abs(freight.total - r.headline_price_amount);
        const pct = (diff / r.headline_price_amount) * 100;
        if (pct > HEADLINE_MISMATCH_PCT) mismatch = true;
      }

      return {
        ...r,
        // Initial values; rank/delta filled in after sort.
        rank: 0,
        delta_from_lowest: 0,
        delta_pct: 0,
        close_to_lowest: false,
        freight_total: rankCost,
        freight_currency: rankCcy,
        destination_total: dest.total,
        destination_currency: dest.currency,
        headline_mismatch: mismatch,
      };
    })
    .filter((r) => r.freight_total > 0);

  ranked.sort((a, b) => a.freight_total - b.freight_total);

  if (ranked.length === 0) return [];

  const lowest = ranked[0]!.freight_total;
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i]!;
    r.rank = i + 1;
    r.delta_from_lowest = r.freight_total - lowest;
    r.delta_pct = lowest > 0 ? (r.delta_from_lowest / lowest) * 100 : 0;
    r.close_to_lowest = i > 0 && r.delta_pct <= CLOSE_PCT;
  }
  return ranked;
}

export function formatRankedTable(ranked: RankedRateOption[]): string {
  if (ranked.length === 0) return '(no rates with prices found)';

  const rows = ranked.map((r) => {
    const priceStr = `${r.freight_currency} ${r.freight_total.toLocaleString()}`;
    const delta =
      r.rank === 1
        ? '—'
        : `+${r.delta_from_lowest.toFixed(0)} (+${r.delta_pct.toFixed(1)}%)`;
    const transit = r.transit_days != null ? `${r.transit_days}d` : '?';
    const dnd =
      r.detention_freetime_days != null || r.demurrage_freetime_days != null
        ? `${r.detention_freetime_days ?? '?'}d/${r.demurrage_freetime_days ?? '?'}d`
        : '—';
    const flags: string[] = [];
    if (r.rollable) flags.push('Rollable');
    if (r.close_to_lowest) flags.push('≈lowest');
    if (r.headline_mismatch) flags.push('!mismatch');
    const flagStr = flags.join(', ');

    return [
      `#${r.rank}`,
      r.sailing_date ?? '?',
      transit,
      dnd,
      r.vessel_voyage ?? '?',
      r.service_name,
      priceStr,
      delta,
      flagStr,
    ];
  });

  const headers = [
    'Rank',
    'Sailing',
    'Transit',
    'Det/Dem',
    'Vessel/Voyage',
    'Service',
    'Freight',
    'Δ',
    'Flags',
  ];
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

export function formatBreakdown(r: RankedRateOption): string {
  if (r.freight_charges.length === 0 && r.destination_charges.length === 0) {
    return '  (no breakdown captured for this sailing)';
  }
  const lines: string[] = [];
  if (r.freight_charges.length > 0) {
    lines.push('  Freight charges (your cost):');
    for (const c of r.freight_charges) {
      lines.push(`    - ${c.name.padEnd(40)}  ${c.currency} ${c.total.toFixed(2)}`);
    }
    lines.push(`    ${'TOTAL'.padEnd(42)}  ${r.freight_currency} ${r.freight_total.toLocaleString()}`);
  }
  if (r.destination_charges.length > 0) {
    lines.push('');
    lines.push('  Destination charges (on collect, paid by receiver):');
    for (const c of r.destination_charges) {
      lines.push(`    - ${c.name.padEnd(40)}  ${c.currency} ${c.total.toFixed(2)}`);
    }
    if (r.destination_currency) {
      lines.push(
        `    ${'TOTAL'.padEnd(42)}  ${r.destination_currency} ${r.destination_total.toLocaleString()}`
      );
    }
  }
  return lines.join('\n');
}
