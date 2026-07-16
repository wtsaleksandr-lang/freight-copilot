import type { Express, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { createDbClient } from '../db/client.js';
import { carriers, quotes, rateSnapshots } from '../db/schema.js';
import { validateQuoteRate } from './quoteValidation.js';

export function registerQuoteValidationRoute(app: Express): void {
  app.get('/api/quotes/:id/validation', async (req: Request, res: Response) => {
    const rawId = req.params.id;
    const id = Number.parseInt(Array.isArray(rawId) ? rawId[0] ?? '' : rawId ?? '', 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid quote id' });
      return;
    }

    try {
      const db = createDbClient();
      const [quote] = await db.select().from(quotes).where(eq(quotes.id, id));
      if (!quote) {
        res.status(404).json({ error: 'Quote not found' });
        return;
      }

      const rows = await db
        .select({
          id: rateSnapshots.id,
          rank: rateSnapshots.rank,
          carrierCode: carriers.code,
          serviceName: rateSnapshots.serviceName,
          sailingDate: rateSnapshots.sailingDate,
          validUntil: rateSnapshots.validUntil,
          transitDays: rateSnapshots.transitDays,
          detentionFreetimeDays: rateSnapshots.detentionFreetimeDays,
          demurrageFreetimeDays: rateSnapshots.demurrageFreetimeDays,
          currency: rateSnapshots.currency,
          totalCostCents: rateSnapshots.totalCostCents,
          charges: rateSnapshots.charges,
          destinationCharges: rateSnapshots.destinationCharges,
          destinationTotal: rateSnapshots.destinationTotal,
          destinationCurrency: rateSnapshots.destinationCurrency,
          headlineMismatch: rateSnapshots.headlineMismatch,
          rawHtmlRef: rateSnapshots.rawHtmlRef,
        })
        .from(rateSnapshots)
        .leftJoin(carriers, eq(carriers.id, rateSnapshots.carrierId))
        .where(eq(rateSnapshots.quoteId, id))
        .orderBy(rateSnapshots.rank);

      const options = rows.map((row) => ({
        rateSnapshotId: row.id,
        rank: row.rank,
        carrierCode: row.carrierCode,
        validation: validateQuoteRate(row),
      }));
      const readyCount = options.filter((option) => option.validation.ready).length;

      res.json({
        quoteId: quote.id,
        ready: options.length > 0 && readyCount === options.length,
        readyCount,
        optionCount: options.length,
        options,
      });
    } catch (err) {
      console.error('[api/quotes/:id/validation] error:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
