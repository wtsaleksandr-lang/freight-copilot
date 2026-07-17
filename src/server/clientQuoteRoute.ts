import type { Express, Request, Response } from 'express';
import { buildClientQuoteHtml, renderClientQuotePdf, type ClientQuoteInput } from './clientQuoteTemplate.js';

function validate(body: unknown): ClientQuoteInput {
  const input = (body ?? {}) as ClientQuoteInput;
  if (!['import_usa', 'import_canada', 'ocean_comparison'].includes(input.template)) throw new Error('Choose a supported quote template.');
  if (input.template === 'ocean_comparison' && (!Array.isArray(input.options) || input.options.length === 0)) throw new Error('Add at least one carrier rate option.');
  if (input.template !== 'ocean_comparison' && (!Array.isArray(input.services) || input.services.length === 0)) throw new Error('Add at least one service line.');
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
      const safe = (input.title || 'client-quote').replace(/[^a-z0-9._-]/gi, '_');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safe}.pdf"`);
      res.send(pdf);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
