import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDbClient } from './client.js';
import { drayageQuotes, drayageRates, type StoredCharge } from './schema.js';
import { eq } from 'drizzle-orm';

export type EndType = 'CY' | 'DOOR';
export type CargoType = 'general' | 'hazmat' | 'high_value' | 'reefer';

export interface DrayageEnd {
  type: EndType;
  /** When type === 'CY' */
  portCode?: string;
  portName?: string;
  terminal?: string;
  /** When type === 'DOOR' */
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

  await writeFile(
    resolve(outputFolder, 'request.json'),
    JSON.stringify({ refId, input, createdAt: new Date().toISOString() }, null, 2)
  );

  return {
    quoteId: quote.id,
    refId,
    outputFolder,
    derivedDirection: deriveDirection(input.origin.type, input.destination.type),
    ranked: [],
    status: 'pending_rate_sources',
    message:
      'Drayage request saved. No automation is wired in yet — drop me your provider workflow (record it via the Record tab) or rate sheets and we will activate the Run button.',
  };
}

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
