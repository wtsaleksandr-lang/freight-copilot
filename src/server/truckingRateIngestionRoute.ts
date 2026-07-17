import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { createDbClient } from '../db/client.js';
import { truckingQuotes, truckingRates } from '../db/schema.js';
import { parseTruckingRateFiles, type ParsedTruckingRate } from '../llm/parseTruckingRateFiles.js';
import type { UniversalFileInput } from '../llm/universalFileText.js';
import { reviewTruckingRates, type ReviewedTruckingRate } from './truckingIngestionReview.js';

interface PendingPreview {
  createdAt: number;
  rates: ReviewedTruckingRate[];
  warnings: string[];
  files: Array<{ filename: string; kind: string; warnings: string[] }>;
}

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const previews = new Map<string, PendingPreview>();

function refId(index: number): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `TI-${day}-${Date.now().toString(36).toUpperCase()}-${index + 1}`;
}

function cleanExpiredPreviews(): void {
  const cutoff = Date.now() - PREVIEW_TTL_MS;
  for (const [id, preview] of previews) {
    if (preview.createdAt < cutoff) previews.delete(id);
  }
}

function validateFiles(req: Request, res: Response): UniversalFileInput[] | null {
  const files = (req.body?.files ?? []) as UniversalFileInput[];
  if (!Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: 'Provide at least one file.' });
    return null;
  }
  if (files.length > 20) {
    res.status(400).json({ error: 'Maximum 20 files per ingestion batch.' });
    return null;
  }
  const invalid = files.find((file) => !file?.filename || !file?.fileBase64);
  if (invalid) {
    res.status(400).json({ error: 'Each file requires filename and base64 content.' });
    return null;
  }
  return files;
}

async function saveApprovedRates(rates: ParsedTruckingRate[]) {
  const db = createDbClient();
  const saved: Array<{ refId: string; quoteId: number; sourceFilename: string }> = [];

  for (let i = 0; i < rates.length; i++) {
    const rate = rates[i]!;
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
      charges: rate.charges.map((charge) => ({
        name: charge.name,
        basis: 'imported',
        quantity: 1,
        unit_price: charge.amount,
        total: charge.amount,
        currency: charge.currency,
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
  return saved;
}

export function registerTruckingRateIngestionRoute(app: Express): void {
  app.post('/api/trucking/rates/ingest-preview', async (req: Request, res: Response) => {
    const files = validateFiles(req, res);
    if (!files) return;
    try {
      cleanExpiredPreviews();
      const parsed = await parseTruckingRateFiles(files);
      const reviewed = reviewTruckingRates(parsed.rates);
      const previewId = randomUUID();
      previews.set(previewId, {
        createdAt: Date.now(),
        rates: reviewed,
        warnings: parsed.warnings,
        files: parsed.normalizedFiles,
      });
      res.json({
        previewId,
        expiresInMinutes: PREVIEW_TTL_MS / 60000,
        rates: reviewed,
        warnings: parsed.warnings,
        files: parsed.normalizedFiles,
        readyCount: reviewed.filter((rate) => rate.readyToImport).length,
        blockedCount: reviewed.filter((rate) => !rate.readyToImport).length,
      });
    } catch (err) {
      res.status(422).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/trucking/rates/ingest-apply', async (req: Request, res: Response) => {
    cleanExpiredPreviews();
    const previewId = String(req.body?.previewId ?? '');
    const selectedIndexes = req.body?.selectedIndexes as unknown;
    if (!previewId || !Array.isArray(selectedIndexes)) {
      res.status(400).json({ error: 'previewId and selectedIndexes are required.' });
      return;
    }
    const preview = previews.get(previewId);
    if (!preview) {
      res.status(409).json({ error: 'This preview expired or no longer exists. Extract the files again.' });
      return;
    }
    const uniqueIndexes = [...new Set(selectedIndexes)]
      .filter((value): value is number => Number.isInteger(value) && value >= 0 && value < preview.rates.length);
    const selected = uniqueIndexes.map((index) => preview.rates[index]!).filter((rate) => rate.readyToImport);
    if (selected.length === 0) {
      res.status(400).json({ error: 'Select at least one import-ready rate.' });
      return;
    }
    try {
      const saved = await saveApprovedRates(selected);
      previews.delete(previewId);
      res.json({ importedCount: saved.length, saved });
    } catch (err) {
      res.status(422).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Compatibility endpoint: now returns a preview and never saves automatically.
  app.post('/api/trucking/rates/ingest', async (req: Request, res: Response) => {
    const files = validateFiles(req, res);
    if (!files) return;
    try {
      cleanExpiredPreviews();
      const parsed = await parseTruckingRateFiles(files);
      const reviewed = reviewTruckingRates(parsed.rates);
      const previewId = randomUUID();
      previews.set(previewId, { createdAt: Date.now(), rates: reviewed, warnings: parsed.warnings, files: parsed.normalizedFiles });
      res.json({
        previewOnly: true,
        previewId,
        rates: reviewed,
        warnings: parsed.warnings,
        files: parsed.normalizedFiles,
        message: 'Review and approve selected rates before they are saved.',
      });
    } catch (err) {
      res.status(422).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
