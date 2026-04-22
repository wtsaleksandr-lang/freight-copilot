import { eq } from 'drizzle-orm';
import { createDbClient } from './client.js';
import { carriers, quotes, rateSnapshots } from './schema.js';
import type { RankedRateOption } from '../types.js';

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
        const cents =
          r.headline_price_amount != null
            ? Math.round(r.headline_price_amount * 100)
            : 0;
        return {
          quoteId: quote.id,
          carrierId: carrier.id,
          serviceName: r.service_name,
          sailingDate: r.sailing_date,
          transitDays: r.transit_days,
          validUntil: null,
          baseFreightCents: cents,
          charges: null,
          totalCostCents: cents,
          currency: r.headline_price_currency ?? 'USD',
          rawHtmlRef: input.rawHtmlRef ?? null,
          rank: r.rank,
        };
      })
    );
  }

  return quote.id;
}
