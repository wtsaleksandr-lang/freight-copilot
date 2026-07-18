import type { Express, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { createDbClient } from '../db/client.js';
import { drayageQuotes, drayageRates, truckingQuotes, truckingRates, sheetUploads, sheetRates } from '../db/schema.js';

function loc(...parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(', ');
}

export function registerClientQuotePrefillRoute(app: Express): void {
  app.get('/api/client-quotes/prefill/:type/:refId', async (req: Request, res: Response) => {
    const type = String(req.params.type || '');
    const refId = String(req.params.refId || '');
    const db = createDbClient();
    try {
      if (type === 'trucking') {
        const [quote] = await db.select().from(truckingQuotes).where(eq(truckingQuotes.refId, refId));
        if (!quote) return void res.status(404).json({ error: 'Trucking quote not found.' });
        const rates = await db.select().from(truckingRates).where(eq(truckingRates.truckingQuoteId, quote.id));
        return void res.json({
          template: 'import_usa',
          title: 'Trucking quotation',
          pol: loc(quote.pickupCity, quote.pickupState, quote.pickupCountry),
          pod: loc(quote.deliveryCity, quote.deliveryState, quote.deliveryCountry),
          validity: rates.map((r) => r.validUntil).filter(Boolean).sort()[0] || null,
          hiddenMarkupFlat: quote.markupFlat,
          hiddenMarkupPct: quote.markupPct,
          services: rates.map((r) => ({ label: `${r.providerName} · ${quote.equipmentType}`, amount: r.totalCostCents / 100, currency: r.currency, basis: quote.mode.toUpperCase(), note: [r.transitDays ? `${r.transitDays} days` : '', r.notes || ''].filter(Boolean).join(' · '), category: 'firm' })),
        });
      }
      if (type === 'drayage') {
        const [quote] = await db.select().from(drayageQuotes).where(eq(drayageQuotes.refId, refId));
        if (!quote) return void res.status(404).json({ error: 'Drayage quote not found.' });
        const rates = await db.select().from(drayageRates).where(eq(drayageRates.drayageQuoteId, quote.id));
        const origin = quote.originType === 'CY' ? loc(quote.originPortName, quote.originTerminal) : loc(quote.originCity, quote.originState, quote.originCountry);
        const destination = quote.destinationType === 'CY' ? loc(quote.destinationPortName, quote.destinationTerminal) : loc(quote.destinationCity, quote.destinationState, quote.destinationCountry);
        return void res.json({
          template: 'import_usa', title: 'Drayage quotation', pol: origin, pod: destination,
          terminal: quote.originTerminal || quote.destinationTerminal || null,
          hiddenMarkupFlat: quote.markupFlat, hiddenMarkupPct: quote.markupPct,
          services: rates.map((r) => ({ label: `${r.providerName} · ${quote.containerCount} × ${quote.containerType}`, amount: r.totalCostCents / 100, currency: r.currency, basis: 'all-in', note: [r.transitDays ? `${r.transitDays} days` : '', r.freeTimeDays ? `${r.freeTimeDays} free days` : '', r.notes || ''].filter(Boolean).join(' · '), category: 'firm' })),
        });
      }
      if (type === 'ocean') {
        const [upload] = await db.select().from(sheetUploads).where(eq(sheetUploads.refId, refId));
        if (!upload) return void res.status(404).json({ error: 'Ocean quote not found.' });
        const rates = await db.select().from(sheetRates).where(eq(sheetRates.uploadId, upload.id));
        const first = rates[0];
        return void res.json({
          template: 'ocean_comparison', title: 'Ocean freight quotation', pol: first?.pol || null, pod: first?.pod || null,
          hiddenMarkupFlat: upload.markupFlat, hiddenMarkupPct: upload.markupPct,
          validity: rates.map((r) => r.validityTo).filter(Boolean).sort()[0] || null,
          destinationChargesNote: 'COLLECT / excluded from origin total',
          options: rates.map((r, index) => ({ carrier: r.carrierCode, containerType: r.containerType, amount: r.freightTotal, currency: r.freightCurrency, transitDays: r.transitDays, destinationCharges: r.destinationTotal, destinationCurrency: r.destinationCurrency, scheduleStatus: 'Subject to booking confirmation', remarks: r.serviceName || null, recommended: index === 0 })),
        });
      }
      res.status(400).json({ error: 'Type must be ocean, drayage, or trucking.' });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
