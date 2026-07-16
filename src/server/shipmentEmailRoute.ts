import type { Express, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createDbClient } from '../db/client.js';
import { shipments } from '../db/schema.js';
import { buildShipmentEmailDraft } from './shipmentEmailDraft.js';

const bodySchema = z.object({
  refId: z.string().trim().min(1),
  type: z.enum(['status_update', 'booking_followup', 'missing_information', 'delay_notice']),
  recipientName: z.string().trim().max(120).optional(),
  extraContext: z.string().trim().max(4000).optional(),
});

export function registerShipmentEmailRoute(app: Express): void {
  app.post('/api/shipments/email-draft', async (req: Request, res: Response) => {
    try {
      const input = bodySchema.parse(req.body);
      const db = createDbClient();
      const [shipment] = await db
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
          operationalStatus: shipments.operationalStatus,
          notes: shipments.notes,
          updatedAt: shipments.updatedAt,
        })
        .from(shipments)
        .where(eq(shipments.refId, input.refId))
        .limit(1);

      if (!shipment) {
        res.status(404).json({ error: `Shipment ${input.refId} was not found.` });
        return;
      }

      const draft = buildShipmentEmailDraft(shipment, input);
      res.json({ shipment: { refId: shipment.refId }, type: input.type, ...draft });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid request.', details: err.issues });
        return;
      }
      console.error('[api/shipments/email-draft] error:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
