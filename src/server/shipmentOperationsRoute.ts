import type { Express, Request, Response } from 'express';
import {
  getShipmentOperations,
  listOpenFollowUps,
  replaceShipmentOperations,
  type ShipmentContainerInput,
  type ShipmentFollowUpInput,
} from '../db/shipmentOperations.js';

function cleanRef(req: Request): string {
  const raw = req.params.refId;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim() : '';
}

function validDate(value: unknown): boolean {
  return value == null || value === '' || /^\d{4}-\d{2}-\d{2}$/.test(String(value));
}

export function registerShipmentOperationsRoute(app: Express): void {
  app.get('/api/shipments/follow-ups/open', async (_req: Request, res: Response) => {
    try {
      res.json({ followUps: await listOpenFollowUps() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/shipments/:refId/operations', async (req: Request, res: Response) => {
    const refId = cleanRef(req);
    if (!refId) return void res.status(400).json({ error: 'refId required' });
    try {
      const result = await getShipmentOperations(refId);
      if (!result) return void res.status(404).json({ error: 'Shipment not found' });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put('/api/shipments/:refId/operations', async (req: Request, res: Response) => {
    const refId = cleanRef(req);
    if (!refId) return void res.status(400).json({ error: 'refId required' });
    const containers = (req.body?.containers ?? []) as ShipmentContainerInput[];
    const followUps = (req.body?.followUps ?? []) as ShipmentFollowUpInput[];
    if (!Array.isArray(containers) || !Array.isArray(followUps)) {
      return void res.status(400).json({ error: 'containers and followUps must be arrays' });
    }
    if (containers.length > 100 || followUps.length > 100) {
      return void res.status(400).json({ error: 'Maximum 100 containers and 100 follow-ups per shipment' });
    }
    const badDate = containers.some((item) => ![item.etd, item.eta, item.actualDeparture, item.actualArrival, item.lastFreeDay, item.emptyReturnDate].every(validDate))
      || followUps.some((item) => !validDate(item.dueDate));
    if (badDate) return void res.status(400).json({ error: 'Dates must use YYYY-MM-DD format' });
    const cleanedFollowUps = followUps.filter((item) => item?.title?.trim());
    try {
      const result = await replaceShipmentOperations(refId, containers, cleanedFollowUps);
      if (!result) return void res.status(404).json({ error: 'Shipment not found' });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
