import type { Express, Request, Response } from 'express';
import { buildExecutionPlan, getAiRoutingProfile, listAiPresets, saveAiRoutingProfile } from './aiRoutingService.js';

export function registerAiRoutingRoute(app: Express): void {
  app.get('/api/ai-routing', async (_req: Request, res: Response) => {
    try {
      const active = await getAiRoutingProfile();
      res.json({ active, presets: listAiPresets() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put('/api/ai-routing', async (req: Request, res: Response) => {
    try {
      const profile = await saveAiRoutingProfile(req.body);
      res.json({ profile });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/ai-routing/plan', async (req: Request, res: Response) => {
    try {
      const profile = await getAiRoutingProfile();
      res.json(buildExecutionPlan(profile, req.body ?? {}));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
