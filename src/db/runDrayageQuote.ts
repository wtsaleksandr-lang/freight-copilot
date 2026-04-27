import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDbClient } from './client.js';
import { drayageQuotes, drayageRates, type StoredCharge } from './schema.js';
import { eq } from 'drizzle-orm';

export interface RunDrayageInput {
  direction: 'import' | 'export';
  portCode: string;
  portName?: string;
  addressLine1: string;
  city: string;
  state?: string;
  zip?: string;
  country?: string;
  containerType: string;
  containerCount?: number;
  weightKg?: number;
  pickupDate?: string;
  deliveryDate?: string;
  specialEquipment?: string[];
  accessorials?: string[];
  clientName?: string;
  notes?: string;
  markupPct?: number;
  markupFlat?: number;
}

export interface DrayageRateRow {
  providerName: string;
  providerCode?: string;
  charges?: StoredCharge[];
  baseRate: number; // major units (USD)
  totalCost: number; // major units
  currency?: string;
  transitDays?: number;
  validUntil?: string;
  freeTimeDays?: number;
  rawSourcePath?: string;
  notes?: string;
}

export interface DrayageQuoteResult {
  quoteId: number;
  refId: string;
  outputFolder: string;
  ranked: Array<DrayageRateRow & { rank: number }>;
  /** Empty until rate sources are wired in. */
  status: 'pending_rate_sources' | 'complete' | 'failed';
  message: string;
}

function generateDrayageRefId(): string {
  const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `D-${yyyymmdd}-${rand}`;
}

/**
 * Foundation runner: persists the drayage quote, creates an output folder,
 * and returns "no rate sources configured yet". Real provider integrations
 * (Maersk Inland, MSC inland, Schneider drayage, local trucker rate sheets,
 * marketplaces) plug in here later.
 */
export async function runDrayageQuote(
  input: RunDrayageInput
): Promise<DrayageQuoteResult> {
  const refId = generateDrayageRefId();
  const outputFolder = resolve('./quotes/drayage', refId);
  await mkdir(outputFolder, { recursive: true });

  const db = createDbClient();
  const [quote] = await db
    .insert(drayageQuotes)
    .values({
      refId,
      outputFolder,
      direction: input.direction,
      portCode: input.portCode,
      portName: input.portName ?? null,
      addressLine1: input.addressLine1,
      city: input.city,
      state: input.state ?? null,
      zip: input.zip ?? null,
      country: input.country ?? 'US',
      containerType: input.containerType,
      containerCount: input.containerCount ?? 1,
      weightKg: input.weightKg ?? null,
      pickupDate: input.pickupDate ?? null,
      deliveryDate: input.deliveryDate ?? null,
      specialEquipment: input.specialEquipment ?? null,
      accessorials: input.accessorials ?? null,
      clientName: input.clientName ?? null,
      notes: input.notes ?? null,
      markupPct: input.markupPct ?? 0,
      markupFlat: input.markupFlat ?? 0,
      status: 'pending_rate_sources',
    })
    .returning({ id: drayageQuotes.id });
  if (!quote) throw new Error('Failed to insert drayage quote');

  await writeFile(
    resolve(outputFolder, 'request.json'),
    JSON.stringify({ refId, input, createdAt: new Date().toISOString() }, null, 2)
  );

  // V1: no rate sources are wired in yet. We persist the request with an
  // empty result set + a clear status. When you feed in rate data later
  // (carrier inland portals, provider rate sheets, etc.), populate
  // drayage_rates rows here and update status to 'complete'.
  return {
    quoteId: quote.id,
    refId,
    outputFolder,
    ranked: [],
    status: 'pending_rate_sources',
    message:
      'Drayage request saved. Rate sources are not wired in yet — drop me your provider rate sheets / portal flow / API access and we will activate them.',
  };
}

/** Helper for once you DO have rates to insert (called from a future provider integration). */
export async function recordDrayageRates(
  drayageQuoteId: number,
  rates: DrayageRateRow[]
): Promise<void> {
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
  await db
    .update(drayageQuotes)
    .set({ status: 'complete' })
    .where(eq(drayageQuotes.id, drayageQuoteId));
}
