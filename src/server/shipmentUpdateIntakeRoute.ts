import type { Express, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { createDbClient } from '../db/client.js';
import { shipments } from '../db/schema.js';
import {
  extractShipmentUpdateProposals,
  type ShipmentUpdateField,
} from './shipmentUpdateIntake.js';

const ALLOWED_FIELDS = new Set<ShipmentUpdateField>([
  'bookingRef',
  'carrierPreference',
  'operationalStatus',
  'pol',
  'pod',
  'containerType',
  'containerQuantity',
  'notes',
]);

export function registerShipmentUpdateIntakeRoute(app: Express): void {
  app.post('/api/shipments/update-preview', async (req: Request, res: Response) => {
    try {
      const refId = String(req.body?.refId ?? '').trim();
      const text = String(req.body?.text ?? '').trim();
      if (!refId || !text) return res.status(400).json({ error: 'refId and text are required' });

      const db = createDbClient();
      const rows = await db.select().from(shipments).where(eq(shipments.refId, refId)).limit(1);
      const shipment = rows[0];
      if (!shipment) return res.status(404).json({ error: `Shipment ${refId} not found` });

      const proposals = extractShipmentUpdateProposals(text, shipment);
      res.json({
        refId,
        expectedUpdatedAt: shipment.updatedAt.toISOString(),
        proposals,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/shipments/update-apply', async (req: Request, res: Response) => {
    try {
      const refId = String(req.body?.refId ?? '').trim();
      const expectedUpdatedAt = String(req.body?.expectedUpdatedAt ?? '').trim();
      const selected = Array.isArray(req.body?.updates) ? req.body.updates : [];
      if (!refId || !expectedUpdatedAt || selected.length === 0) {
        return res.status(400).json({ error: 'refId, expectedUpdatedAt and updates are required' });
      }

      const db = createDbClient();
      const rows = await db.select().from(shipments).where(eq(shipments.refId, refId)).limit(1);
      const shipment = rows[0];
      if (!shipment) return res.status(404).json({ error: `Shipment ${refId} not found` });
      if (shipment.updatedAt.toISOString() !== expectedUpdatedAt) {
        return res.status(409).json({ error: 'Shipment changed after preview. Generate a new preview before applying.' });
      }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      for (const item of selected) {
        const field = String(item?.field ?? '') as ShipmentUpdateField;
        if (!ALLOWED_FIELDS.has(field)) continue;
        if (field === 'containerQuantity') {
          const value = Number(item?.value);
          if (Number.isInteger(value) && value > 0) patch[field] = value;
        } else {
          const value = String(item?.value ?? '').trim();
          if (value) patch[field] = value;
        }
      }
      if (Object.keys(patch).length === 1) return res.status(400).json({ error: 'No valid updates selected' });

      const updated = await db.update(shipments).set(patch).where(eq(shipments.refId, refId)).returning();
      res.json({ refId, updatedFields: Object.keys(patch).filter((key) => key !== 'updatedAt'), shipment: updated[0] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
