export type TruckingConfidence = 'low' | 'medium' | 'high';

export interface TruckingEstimateInput {
  mode: 'ftl' | 'ltl';
  equipmentType: string;
  pickupCity: string;
  pickupState?: string;
  pickupZip?: string;
  pickupCountry?: string;
  deliveryCity: string;
  deliveryState?: string;
  deliveryZip?: string;
  deliveryCountry?: string;
  cargoType?: 'general' | 'hazmat' | 'high_value' | 'reefer';
  hazmat?: boolean;
  tempControlled?: boolean;
  weightKg?: number;
}

export interface TruckingHistoricalRow {
  providerName: string;
  providerCode?: string | null;
  baseRateCents: number;
  totalCostCents: number;
  currency: string;
  transitDays?: number | null;
  ratePerMile?: number | null;
  totalMiles?: number | null;
  parsedAt: Date;
  mode: string;
  equipmentType: string;
  pickupCity: string;
  pickupState?: string | null;
  pickupZip?: string | null;
  pickupCountry?: string | null;
  deliveryCity: string;
  deliveryState?: string | null;
  deliveryZip?: string | null;
  deliveryCountry?: string | null;
  cargoType: string;
  hazmat?: boolean | null;
  tempControlled?: boolean | null;
  weightKg?: number | null;
}

export interface TruckingHistoricalEstimate {
  baseRate: number;
  totalCost: number;
  currency: string;
  transitDays?: number;
  ratePerMile?: number;
  totalMiles?: number;
  confidence: TruckingConfidence;
  sourceCount: number;
  estimateLow: number;
  estimateHigh: number;
  providers: string[];
  newestSourceDate?: string;
  bestMatchScore: number;
}

const HISTORICAL_ESTIMATE_PROVIDER = 'HIST_ESTIMATE';

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalize(a);
  const right = normalize(b);
  return left.length > 0 && left === right;
}

function laneEndScore(target: { city: string; state?: string; zip?: string; country?: string }, historical: { city: string; state?: string | null; zip?: string | null; country?: string | null }): number {
  if (same(target.zip, historical.zip)) return 5;
  if (same(target.city, historical.city) && same(target.state, historical.state)) return 4;
  if (same(target.city, historical.city) && same(target.country, historical.country)) return 3;
  return -100;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index]!;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function mostCommonNumber(values: Array<number | null | undefined>): number | undefined {
  const counts = new Map<number, number>();
  for (const value of values) {
    if (value == null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function buildTruckingHistoricalEstimate(
  input: TruckingEstimateInput,
  rows: TruckingHistoricalRow[]
): TruckingHistoricalEstimate | null {
  const candidates: Array<TruckingHistoricalRow & { score: number }> = [];

  for (const row of rows) {
    if (row.providerCode === HISTORICAL_ESTIMATE_PROVIDER) continue;
    if (!same(input.mode, row.mode)) continue;
    if (!same(input.equipmentType, row.equipmentType)) continue;

    const pickupScore = laneEndScore(
      {
        city: input.pickupCity,
        state: input.pickupState,
        zip: input.pickupZip,
        country: input.pickupCountry ?? 'US',
      },
      {
        city: row.pickupCity,
        state: row.pickupState,
        zip: row.pickupZip,
        country: row.pickupCountry,
      }
    );
    const deliveryScore = laneEndScore(
      {
        city: input.deliveryCity,
        state: input.deliveryState,
        zip: input.deliveryZip,
        country: input.deliveryCountry ?? 'US',
      },
      {
        city: row.deliveryCity,
        state: row.deliveryState,
        zip: row.deliveryZip,
        country: row.deliveryCountry,
      }
    );
    if (pickupScore < 0 || deliveryScore < 0) continue;

    const requiresHazmat = input.hazmat || input.cargoType === 'hazmat';
    if (requiresHazmat && !row.hazmat && row.cargoType !== 'hazmat') continue;
    const requiresTemperature = input.tempControlled || input.cargoType === 'reefer';
    if (requiresTemperature && !row.tempControlled && row.cargoType !== 'reefer') continue;

    if (input.weightKg && row.weightKg && input.weightKg > row.weightKg * 1.15) continue;

    let score = pickupScore + deliveryScore + 2;
    if (requiresHazmat === Boolean(row.hazmat || row.cargoType === 'hazmat')) score += 1;
    if (requiresTemperature === Boolean(row.tempControlled || row.cargoType === 'reefer')) score += 1;
    if (input.weightKg && row.weightKg) {
      const variance = Math.abs(input.weightKg - row.weightKg) / Math.max(input.weightKg, row.weightKg);
      if (variance <= 0.15) score += 1;
    }

    candidates.push({ ...row, score });
  }

  if (candidates.length === 0) return null;

  const bestMatchScore = Math.max(...candidates.map((candidate) => candidate.score));
  const strongest = candidates.filter((candidate) => candidate.score >= bestMatchScore - 1);
  const currencyCounts = new Map<string, number>();
  for (const candidate of strongest) {
    currencyCounts.set(candidate.currency, (currencyCounts.get(candidate.currency) ?? 0) + 1);
  }
  const currency = [...currencyCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const comparable = strongest.filter((candidate) => candidate.currency === currency).slice(0, 20);

  const totals = comparable.map((candidate) => candidate.totalCostCents / 100);
  const bases = comparable.map((candidate) => candidate.baseRateCents / 100);
  const sourceCount = comparable.length;
  const confidence: TruckingConfidence =
    sourceCount >= 5 && bestMatchScore >= 11
      ? 'high'
      : sourceCount >= 3 && bestMatchScore >= 9
        ? 'medium'
        : 'low';
  const newest = comparable
    .map((candidate) => candidate.parsedAt)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return {
    baseRate: median(bases),
    totalCost: median(totals),
    currency,
    transitDays: mostCommonNumber(comparable.map((candidate) => candidate.transitDays)),
    ratePerMile: mostCommonNumber(comparable.map((candidate) => candidate.ratePerMile)),
    totalMiles: mostCommonNumber(comparable.map((candidate) => candidate.totalMiles)),
    confidence,
    sourceCount,
    estimateLow: percentile(totals, 0.25),
    estimateHigh: percentile(totals, 0.75),
    providers: [...new Set(comparable.map((candidate) => candidate.providerName))].slice(0, 5),
    newestSourceDate: newest?.toISOString().slice(0, 10),
    bestMatchScore,
  };
}

export { HISTORICAL_ESTIMATE_PROVIDER };
