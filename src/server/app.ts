import express from 'express';
import { resolve } from 'node:path';
import { registerApiRoutes } from './routes.js';

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  registerApiRoutes(app);

  // Serve the single-page dashboard from /public.
  // In dev (tsx) cwd is the project root, so this works without a build step.
  const publicDir = resolve(process.cwd(), 'src/server/public');
  app.use(express.static(publicDir));

  return app;
}
