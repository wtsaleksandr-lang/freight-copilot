import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDbClient } from './client.js';
import { truckingQuotes, truckingRates, type StoredCharge } from './schema.js';

export interface RunTruckingInput {
  mode: 'ftl' | 'ltl';
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
  equipmentType: string; // dryvan, flatbed, reefer, step_deck, etc.
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

export async function runTruckingQuote(
  input: RunTruckingInput
): Promise<TruckingQuoteResult> {
  const refId = generateTruckingRefId();
  const outputFolder = resolve('./quotes/trucking', refId);
  await mkdir(outputFolder, { recursive: true });

  const db = createDbClient();
  const [quote] = await db
    .insert(truckingQuotes)
    .values({
      refId,
      outputFolder,
      mode: input.mode,
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
    })
    .returning({ id: truckingQuotes.id });
  if (!quote) throw new Error('Failed to insert trucking quote');

  await writeFile(
    resolve(outputFolder, 'request.json'),
    JSON.stringify({ refId, input, createdAt: new Date().toISOString() }, null, 2)
  );

  return {
    quoteId: quote.id,
    refId,
    outputFolder,
    ranked: [],
    status: 'pending_rate_sources',
    message:
      'Trucking request saved. Rate sources (DAT, Truckstop, internal sheets, broker portals) are not wired in yet — drop me what you have to plug in.',
  };
}

export async function recordTruckingRates(
  truckingQuoteId: number,
  rates: TruckingRateRow[]
): Promise<void> {
  if (rates.length === 0) return;
  const db = createDbClient();
  const sorted = [...rates].sort((a, b) => a.totalCost - b.totalCost);
  await db.insert(truckingRates).values(
    sorted.map((r, idx) => ({
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
    }))
  );
  await db
    .update(truckingQuotes)
    .set({ status: 'complete' })
    .where(eq(truckingQuotes.id, truckingQuoteId));
}
