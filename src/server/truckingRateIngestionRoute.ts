import type { Express, Request, Response } from 'express';
import { createDbClient } from '../db/client.js';
import { truckingQuotes, truckingRates } from '../db/schema.js';
import { parseTruckingRateFiles } from '../llm/parseTruckingRateFiles.js';
import type { UniversalFileInput } from '../llm/universalFileText.js';

function refId(index: number): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `TI-${day}-${Date.now().toString(36).toUpperCase()}-${index + 1}`;
}

export function registerTruckingRateIngestionRoute(app: Express): void {
  app.post('/api/trucking/rates/ingest', async (req: Request, res: Response) => {
    const files = (req.body?.files ?? []) as UniversalFileInput[];
    if (!Array.isArray(files) || files.length === 0) {
      res.status(400).json({ error: 'Provide at least one file.' });
      return;
    }
    if (files.length > 20) {
      res.status(400).json({ error: 'Maximum 20 files per ingestion batch.' });
      return;
    }
    const invalid = files.find((f) => !f?.filename || !f?.fileBase64);
    if (invalid) {
      res.status(400).json({ error: 'Each file requires filename and base64 content.' });
      return;
    }
    try {
      const parsed = await parseTruckingRateFiles(files);
      const db = createDbClient();
      const saved: Array<{ refId: string; quoteId: number; sourceFilename: string }> = [];
      for (let i = 0; i < parsed.rates.length; i++) {
        const rate = parsed.rates[i]!;
        const ref = refId(i);
        const [quote] = await db.insert(truckingQuotes).values({
          refId: ref,
          outputFolder: `trucking-rate-ingestion/${ref}`,
          mode: rate.mode,
          pickupAddressLine1: rate.pickup_address || rate.pickup_city,
          pickupCity: rate.pickup_city,
          pickupState: rate.pickup_state ?? null,
          pickupZip: rate.pickup_zip ?? null,
          pickupCountry: rate.pickup_country || 'US',
          deliveryAddressLine1: rate.delivery_address || rate.delivery_city,
          deliveryCity: rate.delivery_city,
          deliveryState: rate.delivery_state ?? null,
          deliveryZip: rate.delivery_zip ?? null,
          deliveryCountry: rate.delivery_country || 'US',
          cargoType: rate.cargo_type,
          equipmentType: rate.equipment_type,
          weightKg: rate.weight_kg ? Math.round(rate.weight_kg) : null,
          hazmat: rate.hazmat,
          tempControlled: rate.temp_controlled,
          notes: rate.notes ?? `Imported from ${rate.source_filename}`,
          status: 'complete',
        }).returning({ id: truckingQuotes.id });
        if (!quote) throw new Error('Failed to save imported trucking quote');
        await db.insert(truckingRates).values({
          truckingQuoteId: quote.id,
          providerName: rate.provider_name,
          providerCode: rate.provider_code ?? null,
          charges: rate.charges.map((c) => ({
            name: c.name,
            basis: 'imported',
            quantity: 1,
            unit_price: c.amount,
            total: c.amount,
            currency: c.currency,
          })),
          baseRateCents: Math.round(rate.base_rate * 100),
          totalCostCents: Math.round(rate.total_cost * 100),
          currency: rate.currency,
          transitDays: rate.transit_days ?? null,
          ratePerMile: rate.rate_per_mile ?? null,
          totalMiles: rate.total_miles ?? null,
          validUntil: rate.valid_until ?? null,
          rawSourcePath: rate.source_filename,
          notes: rate.notes ?? null,
          rank: 1,
        });
        saved.push({ refId: ref, quoteId: quote.id, sourceFilename: rate.source_filename });
      }
      res.json({ importedCount: saved.length, saved, warnings: parsed.warnings, files: parsed.normalizedFiles, rates: parsed.rates });
    } catch (err) {
      res.status(422).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
