import type { Express, Request, Response } from 'express';
import { eq, inArray } from 'drizzle-orm';
import { createDbClient } from '../db/client.js';
import {
  carriers as carriersTable,
  quoteBundles,
  quotes,
  rateSnapshots,
} from '../db/schema.js';

/**
 * Correct bundle-detail route.
 *
 * The original V1 route only loaded snapshots for the first child quote in a
 * multi-carrier bundle. Registering this handler before the legacy route makes
 * the API return every carrier result while keeping the existing response
 * shape compatible with the dashboard.
 */
export function registerBundleDetailRoute(app: Express): void {
  app.get('/api/bundles/:refId', async (req: Request, res: Response) => {
    const rawRefId = req.params.refId;
    const refId = Array.isArray(rawRefId) ? rawRefId[0] : rawRefId;
    if (!refId) {
      res.status(400).json({ error: 'Invalid refId' });
      return;
    }

    try {
      const db = createDbClient();
      const [bundle] = await db
        .select()
        .from(quoteBundles)
        .where(eq(quoteBundles.refId, refId));

      if (!bundle) {
        res.status(404).json({ error: 'Bundle not found' });
        return;
      }

      const childQuotes = await db
        .select({ id: quotes.id })
        .from(quotes)
        .where(eq(quotes.bundleId, bundle.id));

      if (childQuotes.length === 0) {
        res.json({ bundle, rateSnapshots: [] });
        return;
      }

      const quoteIds = childQuotes.map((row) => row.id);
      const snapshots = await db
        .select({
          quoteId: rateSnapshots.quoteId,
          rank: rateSnapshots.rank,
          serviceName: rateSnapshots.serviceName,
          sailingDate: rateSnapshots.sailingDate,
          vesselVoyage: rateSnapshots.vesselVoyage,
          transitDays: rateSnapshots.transitDays,
          detentionFreetimeDays: rateSnapshots.detentionFreetimeDays,
          demurrageFreetimeDays: rateSnapshots.demurrageFreetimeDays,
          rollable: rateSnapshots.rollable,
          currency: rateSnapshots.currency,
          totalCostCents: rateSnapshots.totalCostCents,
          charges: rateSnapshots.charges,
          destinationCharges: rateSnapshots.destinationCharges,
          destinationTotal: rateSnapshots.destinationTotal,
          destinationCurrency: rateSnapshots.destinationCurrency,
          carrierCode: carriersTable.code,
          carrierName: carriersTable.name,
        })
        .from(rateSnapshots)
        .leftJoin(
          carriersTable,
          eq(carriersTable.id, rateSnapshots.carrierId)
        )
        .where(inArray(rateSnapshots.quoteId, quoteIds))
        .orderBy(carriersTable.code, rateSnapshots.rank);

      res.json({ bundle, rateSnapshots: snapshots });
    } catch (err) {
      console.error('[api/bundles/:refId] error:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
