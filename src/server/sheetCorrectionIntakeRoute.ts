import type { Express, Request, Response } from 'express';
import {
  getSheetUploadCurrent,
  updateSheetUpload,
  SheetUploadPatchSchema,
} from '../db/sheetHistory.js';
import {
  extractSheetCorrectionProposals,
  clarifyingQuestions,
  applyClarifyAnswers,
  type SheetCorrectionField,
} from './sheetCorrectionIntake.js';

const ALLOWED_FIELDS = new Set<SheetCorrectionField>([
  'carrierCode',
  'pol',
  'pod',
  'containerType',
  'validityFrom',
  'validityTo',
]);

/**
 * Plain-English correction of a saved ocean rate-sheet upload. Mirrors
 * registerShipmentUpdateIntakeRoute: a preview endpoint proposes field changes
 * (asking clarifying questions through the shared clarify modal when the upload
 * is ambiguous or confidence is low) and an apply endpoint writes the approved
 * changes. Deterministic — no LLM/provider is added.
 */
export function registerSheetCorrectionIntakeRoute(app: Express): void {
  app.post(
    '/api/sheets/correction-preview',
    async (req: Request, res: Response) => {
      try {
        const refId = String(req.body?.refId ?? '').trim();
        const text = String(req.body?.text ?? '').trim();
        const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
        if (!refId || !text) {
          return res
            .status(400)
            .json({ error: 'refId and text are required' });
        }

        const current = await getSheetUploadCurrent(refId);
        if (!current) {
          return res.status(404).json({ error: `Upload ${refId} not found` });
        }

        let proposals = extractSheetCorrectionProposals(text, current);
        if (answers.length > 0) {
          proposals = applyClarifyAnswers(proposals, answers);
        }

        // Any still-ambiguous proposal blocks apply until the user disambiguates
        // through the clarify modal.
        const questions = clarifyingQuestions(proposals);
        if (questions.length > 0) {
          return res.json({
            refId,
            pendingClarification: true,
            questions,
            proposals,
          });
        }

        res.json({ refId, proposals });
      } catch (err) {
        res
          .status(500)
          .json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  app.post(
    '/api/sheets/correction-apply',
    async (req: Request, res: Response) => {
      try {
        const refId = String(req.body?.refId ?? '').trim();
        const selected = Array.isArray(req.body?.updates)
          ? req.body.updates
          : [];
        if (!refId || selected.length === 0) {
          return res
            .status(400)
            .json({ error: 'refId and updates are required' });
        }

        // Translate approved proposals into an upload patch (field replacements).
        const apply = [];
        for (const item of selected) {
          const field = String(item?.field ?? '') as SheetCorrectionField;
          if (!ALLOWED_FIELDS.has(field)) continue;
          const to = item?.to === null ? null : String(item?.to ?? '').trim();
          if (to === '') continue;
          const from =
            item?.from != null && String(item.from).trim() !== ''
              ? String(item.from).trim()
              : undefined;
          apply.push({ field, to, from });
        }
        if (apply.length === 0) {
          return res.status(400).json({ error: 'No valid updates selected' });
        }

        const patch = SheetUploadPatchSchema.parse({ apply });
        const result = await updateSheetUpload(refId, patch);
        if (!result) {
          return res.status(404).json({ error: `Upload ${refId} not found` });
        }
        res.json({
          refId,
          updated: result.updated,
          updatedFields: Array.from(new Set(apply.map((a) => a.field))),
        });
      } catch (err) {
        res
          .status(500)
          .json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );
}
