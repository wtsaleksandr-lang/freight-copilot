import type { Express, Request, Response } from 'express';
import { classifyRateFiles } from '../llm/classifyRateFiles.js';
import type { UniversalFileInput } from '../llm/universalFileText.js';

function validateFiles(req: Request, res: Response): UniversalFileInput[] | null {
  const files = (req.body?.files ?? []) as UniversalFileInput[];
  if (!Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: 'Provide at least one file.' });
    return null;
  }
  if (files.length > 20) {
    res.status(400).json({ error: 'Maximum 20 files per batch.' });
    return null;
  }
  if (files.some((file) => !file?.filename || !file?.fileBase64)) {
    res.status(400).json({ error: 'Each file requires filename and base64 content.' });
    return null;
  }
  return files;
}

export function registerUniversalRateIngestionRoute(app: Express): void {
  app.post('/api/rates/classify', async (req: Request, res: Response) => {
    const files = validateFiles(req, res);
    if (!files) return;
    try {
      const classification = await classifyRateFiles(files);
      res.json(classification);
    } catch (error) {
      res.status(422).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
