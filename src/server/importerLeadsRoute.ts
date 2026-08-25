import type { Express, Request, Response } from 'express';
import { findImporterLeads, toCSV, MAX_LEADS_CAP, type FindImporterLeadsParams } from './importerLeads.js';

/**
 * Importer-Leads admin route. Auth is the app-wide HTTP Basic gate (see app.ts);
 * this endpoint spends paid ImportYeti/Hunter/Anthropic credits, so it must NEVER
 * be exposed without that gate. A hard per-request cap (MAX_LEADS_CAP) bounds
 * spend regardless of what the client asks for.
 *
 *   POST /api/importer-leads         → { leads, creditsRemaining, cost }
 *   POST /api/importer-leads/export  → text/csv download of the same leads
 */

/** Coerce the request body into engine params, applying the hard cap. Only the
 *  documented filters are read; anything else is ignored. */
function readParams(body: Record<string, unknown>): FindImporterLeadsParams {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const requested = Number(body.maxLeads);
  const maxLeads = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 10, MAX_LEADS_CAP));
  return {
    entryPort: str(body.entryPort),
    product: str(body.product),
    hsCode: str(body.hsCode),
    supplierCountry: str(body.supplierCountry),
    maxLeads,
    withEnrichment: body.withEnrichment === true,
    withEmails: body.withEmails === true,
  };
}

/** At least one filter must be present — an unfiltered pull burns credits on
 *  noise. Returns a human-readable reason, or null when the params are usable. */
function validateParams(p: FindImporterLeadsParams): string | null {
  if (!p.entryPort && !p.product && !p.hsCode && !p.supplierCountry) {
    return 'Add at least one filter (entry port, product, HS code, or supplier country) before pulling leads.';
  }
  return null;
}

export function registerImporterLeadsRoute(app: Express): void {
  app.post('/api/importer-leads', async (req: Request, res: Response) => {
    const params = readParams((req.body ?? {}) as Record<string, unknown>);
    const invalid = validateParams(params);
    if (invalid) {
      res.status(400).json({ error: invalid });
      return;
    }
    if (!process.env.IMPORTYETI_API_KEY) {
      res.status(503).json({ error: 'IMPORTYETI_API_KEY is not configured on the server. Add it as a Replit Secret.' });
      return;
    }
    try {
      const result = await findImporterLeads(params);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[api/importer-leads] pull failed:', message);
      res.status(502).json({ error: message });
    }
  });

  app.post('/api/importer-leads/export', async (req: Request, res: Response) => {
    const params = readParams((req.body ?? {}) as Record<string, unknown>);
    const invalid = validateParams(params);
    if (invalid) {
      res.status(400).json({ error: invalid });
      return;
    }
    if (!process.env.IMPORTYETI_API_KEY) {
      res.status(503).json({ error: 'IMPORTYETI_API_KEY is not configured on the server. Add it as a Replit Secret.' });
      return;
    }
    try {
      const { leads } = await findImporterLeads(params);
      const csv = toCSV(leads);
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="importer-leads-${stamp}.csv"`);
      res.send(csv);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[api/importer-leads/export] export failed:', message);
      res.status(502).json({ error: message });
    }
  });
}
