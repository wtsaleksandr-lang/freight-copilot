import type { Express, Request, Response } from 'express';
import { asc, desc, eq, ilike, or } from 'drizzle-orm';
import { createDbClient } from '../db/client.js';
import { shipments } from '../db/schema.js';
import { buildShipmentStatusReport } from './shipmentReport.js';

export function registerShipmentReportRoute(app: Express): void {
  app.get('/api/shipments/report', async (req: Request, res: Response) => {
    try {
      const customer = String(req.query.customer ?? '').trim();
      const refId = String(req.query.refId ?? '').trim();
      const scope = String(req.query.scope ?? 'active').trim();
      const db = createDbClient();

      const rows = await db
        .select({
          refId: shipments.refId,
          customerName: shipments.customerName,
          shipperName: shipments.shipperName,
          receiverName: shipments.receiverName,
          fpol: shipments.fpol,
          pol: shipments.pol,
          pod: shipments.pod,
          containerType: shipments.containerType,
          containerQuantity: shipments.containerQuantity,
          cargoName: shipments.cargoName,
          carrierPreference: shipments.carrierPreference,
          bookingRef: shipments.bookingRef,
          shipmentType: shipments.shipmentType,
          operationalStatus: shipments.operationalStatus,
          notes: shipments.notes,
          updatedAt: shipments.updatedAt,
        })
        .from(shipments)
        .where(
          refId
            ? eq(shipments.refId, refId)
            : customer
              ? or(
                  ilike(shipments.customerName, `%${customer}%`),
                  ilike(shipments.shipperName, `%${customer}%`),
                  ilike(shipments.receiverName, `%${customer}%`)
                )
              : undefined
        )
        .orderBy(asc(shipments.customerName), desc(shipments.updatedAt));

      const filtered = refId || scope === 'all'
        ? rows
        : rows.filter((row) => {
            const status = (row.operationalStatus ?? '').toLowerCase();
            return !['shipped', 'completed', 'closed', 'delivered'].includes(status);
          });

      const report = buildShipmentStatusReport(filtered);
      res.json({ scope, customer: customer || null, refId: refId || null, ...report });
    } catch (err) {
      console.error('[api/shipments/report] error:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}