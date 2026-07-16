import type { Express, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { createDbClient } from '../db/client.js';
import { carriers, quotes, rateSnapshots } from '../db/schema.js';
import { evaluateRateFreshness } from './quoteValidation.js';

export function registerQuoteValidationRoute(app: Express): void {
  // Kept at the existing URL for compatibility with any current callers.
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
          validUntil: rateSnapshots.validUntil,
          parsedAt: rateSnapshots.parsedAt,
        })
        .from(rateSnapshots)
        .leftJoin(carriers, eq(carriers.id, rateSnapshots.carrierId))
        .where(eq(rateSnapshots.quoteId, id))
        .orderBy(rateSnapshots.rank);

      const options = rows.map((row) => ({
        rateSnapshotId: row.id,
        rank: row.rank,
        carrierCode: row.carrierCode,
        serviceName: row.serviceName,
        freshness: evaluateRateFreshness({
          validUntil: row.validUntil,
          parsedAt: row.parsedAt,
        }),
      }));

      res.json({
        quoteId: quote.id,
        options,
        summary: {
          green: options.filter((option) => option.freshness.color === 'green').length,
          yellow: options.filter((option) => option.freshness.color === 'yellow').length,
          red: options.filter((option) => option.freshness.color === 'red').length,
          gray: options.filter((option) => option.freshness.color === 'gray').length,
        },
      });
    } catch (err) {
      console.error('[api/quotes/:id/validation] error:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
