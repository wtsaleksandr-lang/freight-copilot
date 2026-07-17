import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { createDbClient } from './client.js';
import { drayageQuotes, drayageRates, type StoredCharge } from './schema.js';
import {
  normalizeHistoricalCost,
  sameValue,
  scoreDrayageEndpoint,
  weightMatchScore,
} from './drayageEstimateMath.js';

export type EndType = 'CY' | 'DOOR';
export type CargoType = 'general' | 'hazmat' | 'high_value' | 'reefer';

const HISTORICAL_ESTIMATE_PROVIDER = 'HIST_ESTIMATE';

export interface DrayageEnd {
  type: EndType;
  portCode?: string;
  portName?: string;
  terminal?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

export interface RunDrayageInput {
  cargoType: CargoType;
  containerType: string;
  containerCount?: number;
  weightKg?: number;
  origin: DrayageEnd;
  destination: DrayageEnd;
  pickupDate?: string;
  deliveryDate?: string;
  specialEquipment?: string[];
  accessorials?: string[];
  clientName?: string;
  notes?: string;
  markupPct?: number;
  markupFlat?: number;
  intakeText?: string;
}

export interface DrayageRateRow {
  providerName: string;
  providerCode?: string;
  charges?: StoredCharge[];
  baseRate: number;
  totalCost: number;
  currency?: string;
  transitDays?: number;
  validUntil?: string;
  freeTimeDays?: number;
  rawSourcePath?: string;
  notes?: string;
  confidence?: 'low' | 'medium' | 'high';
  sourceCount?: number;
  estimateLow?: number;
  estimateHigh?: number;
  requestedContainerCount?: number;
  exactLaneCount?: number;
  weightMatchedCount?: number;
  newestSourceDate?: string;
}

export interface DrayageQuoteResult {
  quoteId: number;
  refId: string;
  outputFolder: string;
  derivedDirection: 'import' | 'export' | 'mixed';
  ranked: Array<DrayageRateRow & { rank: number }>;
  status: 'pending_rate_sources' | 'complete' | 'failed';
  message: string;
}

interface HistoricalCandidate {
  score: number;
  totalCost: number;
  baseRate: number;
  currency: string;
  transitDays: number | null;
  freeTimeDays: number | null;
  providerName: string;
  parsedAt: Date;
  exactLane: boolean;
  weightMatched: boolean;
}

function generateDrayageRefId(): string {
  const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `D-${yyyymmdd}-${rand}`;
}

function deriveDirection(o: EndType, d: EndType): 'import' | 'export' | 'mixed' {
  if (o === 'CY' && d === 'DOOR') return 'import';
  if (o === 'DOOR' && d === 'CY') return 'export';
  return 'mixed';
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index]!;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[middle - 1]! + sorted[middle]!) / 2;
  return sorted[middle]!;
}

function mostCommonNumber(values: Array<number | null>): number | undefined {
  const counts = new Map<number, number>();
  for (const value of values) {
    if (value == null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

async function buildHistoricalEstimate(input: RunDrayageInput): Promise<DrayageRateRow | null> {
  const db = createDbClient();
  const requestedCount = Math.max(1, input.containerCount ?? 1);
  const rows = await db
    .select({
      providerName: drayageRates.providerName,
      providerCode: drayageRates.providerCode,
      baseRateCents: drayageRates.baseRateCents,
      totalCostCents: drayageRates.totalCostCents,
      currency: drayageRates.currency,
      transitDays: drayageRates.transitDays,
      freeTimeDays: drayageRates.freeTimeDays,
      parsedAt: drayageRates.parsedAt,
      cargoType: drayageQuotes.cargoType,
      containerType: drayageQuotes.containerType,
      containerCount: drayageQuotes.containerCount,
      weightKg: drayageQuotes.weightKg,
      originType: drayageQuotes.originType,
      originPortCode: drayageQuotes.originPortCode,
      originPortName: drayageQuotes.originPortName,
      originTerminal: drayageQuotes.originTerminal,
      originCity: drayageQuotes.originCity,
      originState: drayageQuotes.originState,
      originZip: drayageQuotes.originZip,
      originCountry: drayageQuotes.originCountry,
      destinationType: drayageQuotes.destinationType,
      destinationPortCode: drayageQuotes.destinationPortCode,
      destinationPortName: drayageQuotes.destinationPortName,
      destinationTerminal: drayageQuotes.destinationTerminal,
      destinationCity: drayageQuotes.destinationCity,
      destinationState: drayageQuotes.destinationState,
      destinationZip: drayageQuotes.destinationZip,
      destinationCountry: drayageQuotes.destinationCountry,
    })
    .from(drayageRates)
    .innerJoin(drayageQuotes, eq(drayageRates.drayageQuoteId, drayageQuotes.id))
    .orderBy(desc(drayageRates.parsedAt))
    .limit(500);

  const candidates: HistoricalCandidate[] = [];
  for (const row of rows) {
    if (row.providerCode === HISTORICAL_ESTIMATE_PROVIDER) continue;
    if (!sameValue(input.containerType, row.containerType)) continue;

    const originScore = scoreDrayageEndpoint(input.origin, {
      type: row.originType as EndType,
      portCode: row.originPortCode,
      portName: row.originPortName,
      terminal: row.originTerminal,
      city: row.originCity,
      state: row.originState,
      zip: row.originZip,
      country: row.originCountry,
    });
    const destinationScore = scoreDrayageEndpoint(input.destination, {
      type: row.destinationType as EndType,
      portCode: row.destinationPortCode,
      portName: row.destinationPortName,
      terminal: row.destinationTerminal,
      city: row.destinationCity,
      state: row.destinationState,
      zip: row.destinationZip,
      country: row.destinationCountry,
    });
    if (originScore < 0 || destinationScore < 0) continue;

    if (input.cargoType === 'hazmat' && row.cargoType !== 'hazmat') continue;
    if (input.cargoType === 'reefer' && row.cargoType !== 'reefer') continue;

    const historicalCount = Math.max(1, row.containerCount ?? 1);
    const weightScore = weightMatchScore(input.weightKg, requestedCount, row.weightKg, historicalCount);
    if (weightScore < 0) continue;

    let score = originScore + destinationScore + weightScore;
    if (row.cargoType === input.cargoType) score += 2;
    const exactLane = originScore >= 5 && destinationScore >= 5;
    if (exactLane) score += 1;

    candidates.push({
      score,
      totalCost: normalizeHistoricalCost(row.totalCostCents / 100, historicalCount, requestedCount),
      baseRate: normalizeHistoricalCost(row.baseRateCents / 100, historicalCount, requestedCount),
      currency: row.currency,
      transitDays: row.transitDays,
      freeTimeDays: row.freeTimeDays,
      providerName: row.providerName,
      parsedAt: row.parsedAt,
      exactLane,
      weightMatched: weightScore > 0,
    });
  }

  if (candidates.length === 0) return null;

  const bestScore = Math.max(...candidates.map((candidate) => candidate.score));
  const strongest = candidates.filter((candidate) => candidate.score >= bestScore - 2);
  const currencyCounts = new Map<string, number>();
  for (const candidate of strongest) {
    currencyCounts.set(candidate.currency, (currencyCounts.get(candidate.currency) ?? 0) + 1);
  }
  const currency = [...currencyCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const comparable = strongest.filter((candidate) => candidate.currency === currency).slice(0, 30);

  const totals = comparable.map((candidate) => candidate.totalCost);
  const bases = comparable.map((candidate) => candidate.baseRate);
  const totalCost = median(totals);
  const baseRate = median(bases);
  const estimateLow = percentile(totals, 0.25);
  const estimateHigh = percentile(totals, 0.75);
  const sourceCount = comparable.length;
  const exactLaneCount = comparable.filter((candidate) => candidate.exactLane).length;
  const weightMatchedCount = comparable.filter((candidate) => candidate.weightMatched).length;
  const confidence: 'low' | 'medium' | 'high' =
    sourceCount >= 5 && exactLaneCount >= 3 && bestScore >= 12
      ? 'high'
      : sourceCount >= 3 && bestScore >= 9
        ? 'medium'
        : 'low';
  const providers = [...new Set(comparable.map((candidate) => candidate.providerName))].slice(0, 5);
  const newestSource = comparable.map((candidate) => candidate.parsedAt).sort((a, b) => b.getTime() - a.getTime())[0];
  const newestSourceDate = newestSource?.toISOString().slice(0, 10);

  const charges: StoredCharge[] = [
    {
      name: 'Historical drayage estimate',
      basis: `Median of ${sourceCount} normalized verified rate${sourceCount === 1 ? '' : 's'} for ${requestedCount} container${requestedCount === 1 ? '' : 's'}`,
      quantity: requestedCount,
      unit_price: totalCost / requestedCount,
      total: totalCost,
      currency,
    },
  ];

  return {
    providerName: 'Historical lane estimate',
    providerCode: HISTORICAL_ESTIMATE_PROVIDER,
    charges,
    baseRate,
    totalCost,
    currency,
    transitDays: mostCommonNumber(comparable.map((candidate) => candidate.transitDays)),
    freeTimeDays: mostCommonNumber(comparable.map((candidate) => candidate.freeTimeDays)),
    confidence,
    sourceCount,
    estimateLow,
    estimateHigh,
    requestedContainerCount: requestedCount,
    exactLaneCount,
    weightMatchedCount,
    newestSourceDate,
    notes: [
      `${confidence.toUpperCase()} confidence estimate; verify with a drayage provider before quoting as firm.`,
      `Normalized to ${requestedCount} container${requestedCount === 1 ? '' : 's'}.`,
      `Interquartile range: ${currency} ${estimateLow.toFixed(2)}–${estimateHigh.toFixed(2)}.`,
      `${exactLaneCount} exact lane match${exactLaneCount === 1 ? '' : 'es'}; ${weightMatchedCount} weight-compatible match${weightMatchedCount === 1 ? '' : 'es'}.`,
      `Sources: ${providers.join(', ')}.`,
      newestSourceDate ? `Newest supporting rate: ${newestSourceDate}.` : '',
    ].filter(Boolean).join(' '),
  };
}

export async function runDrayageQuote(input: RunDrayageInput): Promise<DrayageQuoteResult> {
  const refId = generateDrayageRefId();
  const outputFolder = resolve('./quotes/drayage', refId);
  await mkdir(outputFolder, { recursive: true });

  const db = createDbClient();
  const [quote] = await db
    .insert(drayageQuotes)
    .values({
      refId,
      outputFolder,
      cargoType: input.cargoType,
      containerType: input.containerType,
      containerCount: input.containerCount ?? 1,
      weightKg: input.weightKg ?? null,
      originType: input.origin.type,
      originPortCode: input.origin.portCode ?? null,
      originPortName: input.origin.portName ?? null,
      originTerminal: input.origin.terminal ?? null,
      originAddressLine1: input.origin.addressLine1 ?? null,
      originCity: input.origin.city ?? null,
      originState: input.origin.state ?? null,
      originZip: input.origin.zip ?? null,
      originCountry: input.origin.country ?? null,
      destinationType: input.destination.type,
      destinationPortCode: input.destination.portCode ?? null,
      destinationPortName: input.destination.portName ?? null,
      destinationTerminal: input.destination.terminal ?? null,
      destinationAddressLine1: input.destination.addressLine1 ?? null,
      destinationCity: input.destination.city ?? null,
      destinationState: input.destination.state ?? null,
      destinationZip: input.destination.zip ?? null,
      destinationCountry: input.destination.country ?? null,
      pickupDate: input.pickupDate ?? null,
      deliveryDate: input.deliveryDate ?? null,
      specialEquipment: input.specialEquipment ?? null,
      accessorials: input.accessorials ?? null,
      clientName: input.clientName ?? null,
      notes: input.notes ?? null,
      markupPct: input.markupPct ?? 0,
      markupFlat: input.markupFlat ?? 0,
      intakeText: input.intakeText ?? null,
      status: 'pending_rate_sources',
    })
    .returning({ id: drayageQuotes.id });
  if (!quote) throw new Error('Failed to insert drayage quote');

  await writeFile(resolve(outputFolder, 'request.json'), JSON.stringify({ refId, input, createdAt: new Date().toISOString() }, null, 2));

  const estimate = await buildHistoricalEstimate(input);
  if (estimate) {
    await recordDrayageRates(quote.id, [estimate]);
    await writeFile(resolve(outputFolder, 'historical-estimate.json'), JSON.stringify({ refId, estimate, createdAt: new Date().toISOString() }, null, 2));
    return {
      quoteId: quote.id,
      refId,
      outputFolder,
      derivedDirection: deriveDirection(input.origin.type, input.destination.type),
      ranked: [{ ...estimate, rank: 1 }],
      status: 'complete',
      message: 'Historical estimate generated from normalized verified lane rates. This is not a live provider quote; review confidence, range, container normalization, and source date before sending it to a client.',
    };
  }

  return {
    quoteId: quote.id,
    refId,
    outputFolder,
    derivedDirection: deriveDirection(input.origin.type, input.destination.type),
    ranked: [],
    status: 'pending_rate_sources',
    message: 'Drayage request saved, but no sufficiently similar verified lane rates were found. Add a provider quote or rate sheet before quoting the client.',
  };
}

export async function recordDrayageRates(drayageQuoteId: number, rates: DrayageRateRow[]): Promise<void> {
  if (rates.length === 0) return;
  const db = createDbClient();
  const sorted = [...rates].sort((a, b) => a.totalCost - b.totalCost);
  await db.insert(drayageRates).values(
    sorted.map((r, idx) => ({
      drayageQuoteId,
      providerName: r.providerName,
      providerCode: r.providerCode ?? null,
      charges: r.charges ?? null,
      baseRateCents: Math.round(r.baseRate * 100),
      totalCostCents: Math.round(r.totalCost * 100),
      currency: r.currency ?? 'USD',
      transitDays: r.transitDays ?? null,
      validUntil: r.validUntil ?? null,
      freeTimeDays: r.freeTimeDays ?? null,
      rawSourcePath: r.rawSourcePath ?? null,
      notes: r.notes ?? null,
      rank: idx + 1,
    }))
  );
  await db.update(drayageQuotes).set({ status: 'complete' }).where(eq(drayageQuotes.id, drayageQuoteId));
}
