import type { Express, Request, Response } from 'express';
import { buildClientQuoteHtml, renderClientQuotePdf, type ClientQuoteInput } from './clientQuoteTemplate.js';

const SUPPORTED_TEMPLATES = ['import_usa', 'import_canada', 'export_clearance', 'ocean_comparison'] as const;

function validate(body: unknown): ClientQuoteInput {
  const input = (body ?? {}) as ClientQuoteInput;
  if (!SUPPORTED_TEMPLATES.includes(input.template as (typeof SUPPORTED_TEMPLATES)[number])) {
    throw new Error('Choose a supported quote template.');
  }
  if (input.template === 'ocean_comparison') {
    if (!Array.isArray(input.options) || input.options.length === 0) {
      throw new Error('Add at least one carrier rate option.');
    }
    input.options.forEach((option, index) => {
      if (!option.carrier?.trim()) throw new Error(`Carrier option ${index + 1} needs a carrier name.`);
      if (!Number.isFinite(option.amount)) throw new Error(`Carrier option ${index + 1} needs a valid rate.`);
      if (option.transitDays != null && !Number.isFinite(option.transitDays)) throw new Error(`Carrier option ${index + 1} has an invalid transit time.`);
      if (option.destinationCharges != null && !Number.isFinite(option.destinationCharges)) throw new Error(`Carrier option ${index + 1} has invalid destination charges.`);
    });
  } else {
    if (!Array.isArray(input.services) || input.services.length === 0) {
      throw new Error('Add at least one service line.');
    }
    input.services.forEach((line, index) => {
      if (!line.label?.trim()) throw new Error(`Service line ${index + 1} needs a description.`);
      if (line.amount != null && !Number.isFinite(line.amount)) throw new Error(`Service line ${index + 1} has an invalid amount.`);
    });
  }
  if (input.hiddenMarkupFlat != null && !Number.isFinite(input.hiddenMarkupFlat)) throw new Error('Hidden flat markup must be numeric.');
  if (input.hiddenMarkupPct != null && !Number.isFinite(input.hiddenMarkupPct)) throw new Error('Hidden percentage markup must be numeric.');
  return input;
}

export function registerClientQuoteRoute(app: Express): void {
  app.post('/api/client-quotes/preview', (req: Request, res: Response) => {
    try {
      res.type('html').send(buildClientQuoteHtml(validate(req.body)));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/client-quotes/pdf', async (req: Request, res: Response) => {
    try {
      const input = validate(req.body);
      const pdf = await renderClientQuotePdf(input);
      const safe = (input.title || 'client-quote').replace(/[^a-z0-9._-]/gi, '_') || 'client-quote';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safe}.pdf"`);
      res.send(pdf);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
