import type { Express, Request, Response } from 'express';
import { createDbClient } from '../db/client.js';
import { shipments } from '../db/schema.js';
import { parseShipmentBriefing, type BriefingFile, type BriefingMediaType } from '../llm/parseShipmentBriefing.js';
import { normalizeUniversalFile, type UniversalFileInput } from '../llm/universalFileText.js';
import { chooseShipmentMatch } from './shipmentDocumentMatcher.js';

const FIELD_MAP = {
  bookingRef: 'booking_ref', carrierPreference: 'carrier_preference', pol: 'pol', pod: 'pod',
  containerType: 'container_type', containerQuantity: 'container_quantity', notes: 'notes',
} as const;

function toBriefingFile(file: UniversalFileInput): BriefingFile {
  const normalized = normalizeUniversalFile(file);
  if (normalized.kind === 'text') return { filename: normalized.filename, mediaType: 'text/plain', textContent: normalized.text ?? '' };
  return { filename: normalized.filename, mediaType: normalized.mediaType as BriefingMediaType, fileBase64: normalized.fileBase64 };
}

export function registerShipmentDocumentIntakeRoute(app: Express): void {
  app.post('/api/shipments/document-preview', async (req: Request, res: Response) => {
    const files = (req.body?.files ?? []) as UniversalFileInput[];
    const chosenRefId = String(req.body?.refId ?? '').trim();
    if (!Array.isArray(files) || files.length === 0) return void res.status(400).json({ error: 'Provide at least one file.' });
    if (files.length > 20) return void res.status(400).json({ error: 'Maximum 20 files per batch.' });
    try {
      const briefing = await parseShipmentBriefing(files.map(toBriefingFile), [], 'MATCHING AND UPDATE PREVIEW ONLY: extract shipment identifiers and operational fields. Do not extract or infer money fields. Be conservative.');
      const db = createDbClient();
      const rows = await db.select().from(shipments);
      const forced = chosenRefId ? rows.find((row) => row.refId === chosenRefId) : null;
      const decision = forced ? { status: 'matched' as const, match: { shipment: forced, score: 999, evidence: ['user-selected shipment'] }, ranked: [] } : chooseShipmentMatch({
        internalRef: briefing.our_reference_number,
        bookingRef: briefing.booking_ref,
        customerName: briefing.customer_name,
        shipperName: briefing.shipper_name,
        receiverName: briefing.receiver_name,
        carrierPreference: briefing.carrier_preference,
        pol: briefing.pol,
        pod: briefing.pod,
        containerType: briefing.container_type,
      }, rows);
      if (decision.status !== 'matched') {
        return void res.json({
          matchStatus: decision.status,
          extracted: briefing,
          candidates: decision.ranked.map((item) => ({ refId: item.shipment.refId, score: item.score, evidence: item.evidence, customerName: item.shipment.customerName, bookingRef: item.shipment.bookingRef, pol: item.shipment.pol, pod: item.shipment.pod })),
        });
      }
      const shipment = decision.match.shipment;
      const proposals = Object.entries(FIELD_MAP).flatMap(([field, source]) => {
        const proposedValue = briefing[source as keyof typeof briefing];
        const currentValue = shipment[field as keyof typeof shipment];
        if (proposedValue == null || proposedValue === '' || String(proposedValue) === String(currentValue ?? '')) return [];
        return [{ field, currentValue, proposedValue, confidence: decision.match.score >= 100 ? 'high' : 'medium', evidence: decision.match.evidence.join(', ') || 'document extraction' }];
      });
      res.json({
        matchStatus: 'matched',
        refId: shipment.refId,
        match: { score: decision.match.score, evidence: decision.match.evidence },
        expectedUpdatedAt: shipment.updatedAt.toISOString(),
        proposals,
        extracted: briefing,
      });
    } catch (error) {
      res.status(422).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
