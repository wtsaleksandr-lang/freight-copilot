import express from 'express';
import { resolve } from 'node:path';
import { registerApiRoutes } from './routes.js';
import { loadEnv } from '../config.js';
import { startKeepAlivePinger } from './sessionProbe.js';

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Optional HTTP Basic auth — enabled when BASIC_AUTH_USER + BASIC_AUTH_PASS
  // are both set in .env. Strongly recommended when exposing past localhost.
  const env = loadEnv();
  if (env.BASIC_AUTH_USER && env.BASIC_AUTH_PASS) {
    const expected =
      'Basic ' +
      Buffer.from(`${env.BASIC_AUTH_USER}:${env.BASIC_AUTH_PASS}`).toString('base64');
    app.use((req, res, next) => {
      const got = req.header('authorization') ?? '';
      if (got === expected) return next();
      res
        .status(401)
        .set('WWW-Authenticate', 'Basic realm="freight-copilot"')
        .send('Authentication required');
    });
    console.log('[app] HTTP Basic auth enabled');
  }

  registerApiRoutes(app);

  // Serve the single-page dashboard from /public.
  const publicDir = resolve(process.cwd(), 'src/server/public');
  app.use(express.static(publicDir));

  // Serve bundle artifacts (screenshots, HTML proof, aria tree, parsed
  // JSON) so the dashboard can link to them. Behind Basic auth — same
  // middleware applies. Not user-uploadable, just read-only proof.
  const quotesDir = resolve(process.cwd(), 'quotes');
  app.use('/quotes-files', express.static(quotesDir));

  // Real Chrome mode: start the keep-alive pinger that probes each
  // carrier's quote URL every 10 min. Two effects:
  //  - Navigation alone counts as portal activity → idle timer resets,
  //    so the user stays logged in much longer than the carrier's
  //    typical 20–60 min idle expiry.
  //  - Each probe records logged-in / logged-out state, served at
  //    /api/sessions/probe so the dashboard's per-carrier badges
  //    reflect live reality (not just the stored expires_at).
  // No tokens, no LLM — pure Playwright nav + selector check.
  if (env.USE_REAL_CHROME) {
    startKeepAlivePinger();
  }

  return app;
}
