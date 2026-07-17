import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { createDbClient } from './client.js';
import { truckingQuotes, truckingRates, type StoredCharge } from './schema.js';
import {
  buildTruckingHistoricalEstimate,
  HISTORICAL_ESTIMATE_PROVIDER,
} from './truckingHistoricalEstimate.js';

export interface RunTruckingInput {
  mode: 'ftl' | 'ltl';
  cargoType?: 'general' | 'hazmat' | 'high_value' | 'reefer';
  pickupAddressLine1: string;
  pickupCity: string;
  pickupState?: string;
  pickupZip?: string;
  pickupCountry?: string;
  deliveryAddressLine1: string;
  deliveryCity: string;
  deliveryState?: string;
  deliveryZip?: string;
  deliveryCountry?: string;
  equipmentType: string;
  weightKg?: number;
  lengthFt?: number;
  widthFt?: number;
  heightFt?: number;
  pieces?: number;
  hazmat?: boolean;
  tempControlled?: boolean;
  tempMinF?: number;
  tempMaxF?: number;
  pickupDate?: string;
  deliveryDate?: string;
  commodity?: string;
  clientName?: string;
  notes?: string;
  markupPct?: number;
  markupFlat?: number;
}

export interface TruckingRateRow {
  providerName: string;
  providerCode?: string;
  charges?: StoredCharge[];
  baseRate: number;
  totalCost: number;
  currency?: string;
  transitDays?: number;
  ratePerMile?: number;
  totalMiles?: number;
  validUntil?: string;
  rawSourcePath?: string;
  notes?: string;
  confidence?: 'low' | 'medium' | 'high';
  sourceCount?: number;
  estimateLow?: number;
  estimateHigh?: number;
}

export interface TruckingQuoteResult {
  quoteId: number;
  refId: string;
  outputFolder: string;
  ranked: Array<TruckingRateRow & { rank: number }>;
  status: 'pending_rate_sources' | 'complete' | 'failed';
  message: string;
}

function generateTruckingRefId(): string {
  const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `T-${yyyymmdd}-${rand}`;
}

async function buildHistoricalRate(input: RunTruckingInput): Promise<TruckingRateRow | null> {
  const db = createDbClient();
  const rows = await db
    .select({
      providerName: truckingRates.providerName,
      providerCode: truckingRates.providerCode,
      baseRateCents: truckingRates.baseRateCents,
      totalCostCents: truckingRates.totalCostCents,
      currency: truckingRates.currency,
      transitDays: truckingRates.transitDays,
      ratePerMile: truckingRates.ratePerMile,
      totalMiles: truckingRates.totalMiles,
      parsedAt: truckingRates.parsedAt,
      mode: truckingQuotes.mode,
      equipmentType: truckingQuotes.equipmentType,
      pickupCity: truckingQuotes.pickupCity,
      pickupState: truckingQuotes.pickupState,
      pickupZip: truckingQuotes.pickupZip,
      pickupCountry: truckingQuotes.pickupCountry,
      deliveryCity: truckingQuotes.deliveryCity,
      deliveryState: truckingQuotes.deliveryState,
      deliveryZip: truckingQuotes.deliveryZip,
      deliveryCountry: truckingQuotes.deliveryCountry,
      cargoType: truckingQuotes.cargoType,
      hazmat: truckingQuotes.hazmat,
      tempControlled: truckingQuotes.tempControlled,
      weightKg: truckingQuotes.weightKg,
    })
    .from(truckingRates)
    .innerJoin(truckingQuotes, eq(truckingRates.truckingQuoteId, truckingQuotes.id))
    .orderBy(desc(truckingRates.parsedAt))
    .limit(300);

  const estimate = buildTruckingHistoricalEstimate(input, rows);
  if (!estimate) return null;

  const charges: StoredCharge[] = [{
    name: 'Historical trucking estimate',
    basis: `Median of ${estimate.sourceCount} verified matching rate${estimate.sourceCount === 1 ? '' : 's'}`,
    quantity: 1,
    unit_price: estimate.totalCost,
    total: estimate.totalCost,
    currency: estimate.currency,
  }];

  return {
    providerName: 'Historical lane estimate',
    providerCode: HISTORICAL_ESTIMATE_PROVIDER,
    charges,
    baseRate: estimate.baseRate,
    totalCost: estimate.totalCost,
    currency: estimate.currency,
    transitDays: estimate.transitDays,
    ratePerMile: estimate.ratePerMile,
    totalMiles: estimate.totalMiles,
    confidence: estimate.confidence,
    sourceCount: estimate.sourceCount,
    estimateLow: estimate.estimateLow,
    estimateHigh: estimate.estimateHigh,
    notes: [
      `${estimate.confidence.toUpperCase()} confidence historical estimate; verify with a trucker before quoting as firm.`,
      `Interquartile range: ${estimate.currency} ${estimate.estimateLow.toFixed(2)}–${estimate.estimateHigh.toFixed(2)}.`,
      `Sources: ${estimate.providers.join(', ')}.`,
      estimate.newestSourceDate ? `Newest supporting rate: ${estimate.newestSourceDate}.` : '',
    ].filter(Boolean).join(' '),
  };
}

export async function runTruckingQuote(input: RunTruckingInput): Promise<TruckingQuoteResult> {
  const refId = generateTruckingRefId();
  const outputFolder = resolve('./quotes/trucking', refId);
  await mkdir(outputFolder, { recursive: true });

  const db = createDbClient();
  const [quote] = await db.insert(truckingQuotes).values({
    refId,
    outputFolder,
    mode: input.mode,
    cargoType: input.cargoType ?? 'general',
    pickupAddressLine1: input.pickupAddressLine1,
    pickupCity: input.pickupCity,
    pickupState: input.pickupState ?? null,
    pickupZip: input.pickupZip ?? null,
    pickupCountry: input.pickupCountry ?? 'US',
    deliveryAddressLine1: input.deliveryAddressLine1,
    deliveryCity: input.deliveryCity,
    deliveryState: input.deliveryState ?? null,
    deliveryZip: input.deliveryZip ?? null,
    deliveryCountry: input.deliveryCountry ?? 'US',
    equipmentType: input.equipmentType,
    weightKg: input.weightKg ?? null,
    lengthFt: input.lengthFt ?? null,
    widthFt: input.widthFt ?? null,
    heightFt: input.heightFt ?? null,
    pieces: input.pieces ?? null,
    hazmat: input.hazmat ?? false,
    tempControlled: input.tempControlled ?? false,
    tempMinF: input.tempMinF ?? null,
    tempMaxF: input.tempMaxF ?? null,
    pickupDate: input.pickupDate ?? null,
    deliveryDate: input.deliveryDate ?? null,
    commodity: input.commodity ?? null,
    clientName: input.clientName ?? null,
    notes: input.notes ?? null,
    markupPct: input.markupPct ?? 0,
    markupFlat: input.markupFlat ?? 0,
    status: 'pending_rate_sources',
  }).returning({ id: truckingQuotes.id });
  if (!quote) throw new Error('Failed to insert trucking quote');

  await writeFile(resolve(outputFolder, 'request.json'), JSON.stringify({ refId, input, createdAt: new Date().toISOString() }, null, 2));

  const historical = await buildHistoricalRate(input);
  if (!historical) {
    return {
      quoteId: quote.id,
      refId,
      outputFolder,
      ranked: [],
      status: 'pending_rate_sources',
      message: 'Trucking request saved. No sufficiently similar verified historical rates were found; obtain a live trucker quote.',
    };
  }

  await recordTruckingRates(quote.id, [historical]);
  await writeFile(resolve(outputFolder, 'historical-estimate.json'), JSON.stringify(historical, null, 2));

  return {
    quoteId: quote.id,
    refId,
    outputFolder,
    ranked: [{ ...historical, rank: 1 }],
    status: 'complete',
    message: 'Historical trucking estimate generated. It is directional only and must be verified with a trucker before being quoted as firm.',
  };
}

export async function recordTruckingRates(truckingQuoteId: number, rates: TruckingRateRow[]): Promise<void> {
  if (rates.length === 0) return;
  const db = createDbClient();
  const sorted = [...rates].sort((a, b) => a.totalCost - b.totalCost);
  await db.insert(truckingRates).values(sorted.map((r, idx) => ({
    truckingQuoteId,
    providerName: r.providerName,
    providerCode: r.providerCode ?? null,
    charges: r.charges ?? null,
    baseRateCents: Math.round(r.baseRate * 100),
    totalCostCents: Math.round(r.totalCost * 100),
    currency: r.currency ?? 'USD',
    transitDays: r.transitDays ?? null,
    ratePerMile: r.ratePerMile ?? null,
    totalMiles: r.totalMiles ?? null,
    validUntil: r.validUntil ?? null,
    rawSourcePath: r.rawSourcePath ?? null,
    notes: r.notes ?? null,
    rank: idx + 1,
  })));
  await db.update(truckingQuotes).set({ status: 'complete' }).where(eq(truckingQuotes.id, truckingQuoteId));
}
