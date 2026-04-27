import { eq } from 'drizzle-orm';
import { createDbClient } from './client.js';
import { carriers, quotes, rateSnapshots, type StoredCharge } from './schema.js';
import type { RankedRateOption, RateCharge } from '../types.js';

export interface PersistQuoteInput {
  origin: string;
  destination: string;
  containerType: string;
  requestedDate: string;
  notes?: string;
  carrierCode: string;
  ranked: RankedRateOption[];
  rawHtmlRef?: string;
}

function toStored(c: RateCharge): StoredCharge {
  return {
    name: c.name,
    basis: c.basis,
    quantity: c.quantity,
    unit_price: c.unit_price,
    total: c.total,
    currency: c.currency,
  };
}

export async function persistQuote(input: PersistQuoteInput): Promise<number> {
  const db = createDbClient();

  const [carrier] = await db
    .select()
    .from(carriers)
    .where(eq(carriers.code, input.carrierCode));
  if (!carrier) throw new Error(`Carrier ${input.carrierCode} not seeded in DB`);

  const [quote] = await db
    .insert(quotes)
    .values({
      origin: input.origin,
      destination: input.destination,
      containerType: input.containerType,
      requestedDate: input.requestedDate,
      notes: input.notes,
    })
    .returning({ id: quotes.id });
  if (!quote) throw new Error('Failed to insert quote');

  if (input.ranked.length > 0) {
    await db.insert(rateSnapshots).values(
      input.ranked.map((r) => {
        const totalCents = Math.round(r.freight_total * 100);
        return {
          quoteId: quote.id,
          carrierId: carrier.id,
          serviceName: r.service_name,
          sailingDate: r.sailing_date,
          vesselVoyage: r.vessel_voyage,
          transitDays: r.transit_days,
          validUntil: null,
          detentionFreetimeDays: r.detention_freetime_days,
          demurrageFreetimeDays: r.demurrage_freetime_days,
          rollable: r.rollable,
          baseFreightCents: totalCents,
          charges: r.freight_charges.map(toStored),
          destinationCharges: r.destination_charges.map(toStored),
          totalCostCents: totalCents,
          currency: r.freight_currency,
          destinationTotal: r.destination_total || null,
          destinationCurrency: r.destination_currency,
          headlineMismatch: r.headline_mismatch,
          rawHtmlRef: input.rawHtmlRef ?? null,
          rank: r.rank,
        };
      })
    );
  }

  return quote.id;
}
