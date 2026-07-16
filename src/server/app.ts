import express from 'express';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { registerApiRoutes } from './routes.js';
import { registerBundleDetailRoute } from './bundleDetailRoute.js';
import { registerQuoteValidationRoute } from './quoteValidationRoute.js';
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

  // Focused routes are registered before the legacy all-in-one route module.
  registerBundleDetailRoute(app);
  registerQuoteValidationRoute(app);
  registerApiRoutes(app);

  // Serve the single-page dashboard from /public. The root response injects
  // the small freshness UI layer before app.js so it can observe quote API
  // responses and decorate the existing rate tables without rewriting the
  // large legacy dashboard script.
  const publicDir = resolve(process.cwd(), 'src/server/public');
  app.get('/', async (_req, res, next) => {
    try {
      const indexPath = resolve(publicDir, 'index.html');
      const source = await readFile(indexPath, 'utf8');
      const html = source
        .replace(
          '<link rel="stylesheet" href="/style.css">',
          '<link rel="stylesheet" href="/style.css">\n  <link rel="stylesheet" href="/freshness-ui.css">'
        )
        .replace(
          '<script src="/app.js"></script>',
          '<script src="/freshness-ui.js"></script>\n  <script src="/app.js"></script>'
        );
      res.type('html').send(html);
    } catch (err) {
      next(err);
    }
  });
  app.use(express.static(publicDir));

  // Serve bundle artifacts (screenshots, HTML proof, aria tree, parsed
  // JSON) so the dashboard can link to them. Behind Basic auth — same
  // middleware applies. Not user-uploadable, just read-only proof.
  const quotesDir = resolve(process.cwd(), 'quotes');
  app.use('/quotes-files', express.static(quotesDir));

  // Same pattern for offline rate-sheet parsing — let the dashboard link
  // back to the source PDF/image and the parsed JSON.
  const parsedSheetsDir = resolve(process.cwd(), 'parsed-sheets');
  app.use('/parsed-sheets-files', express.static(parsedSheetsDir));

  // Source files for the personal shipment board (email screenshots /
  // PDFs the user dropped to populate a row).
  const shipmentsDir = resolve(process.cwd(), 'shipments-files');
  app.use('/shipments-files', express.static(shipmentsDir));

  // Source files for the drayage rate library — provider rate sheets,
  // emails, screenshots the user uploaded for the AI to extract from.
  const drayageRatesDir = resolve(process.cwd(), 'drayage-rates-files');
  app.use('/drayage-rates-files', express.static(drayageRatesDir));

  // Real Chrome mode: start the keep-alive pinger that probes each
  // carrier's quote URL every 10 min. Two effects:
  //  - Navigation alone counts as portal activity → idle timer resets,
  //    so the user stays logged in much longer than the carrier's
  //    typical 20–60 min idle expiry.
  //  - Each probe records logged-in / logged-out state, served at
  //    /api/sessions/probe so the dashboard's per-carrier badges
  //    reflect live reality (not just the stored expires_at).
  // No tokens, no LLM — pure Playwright nav + selector check.
  // Background tick that fires due scheduled-agent tasks. Cheap —
  // one DB scan per minute, no AI work unless something is due.
  void (async () => {
    try {
      const { startScheduledAgentTick } = await import(
        './scheduledAgentsService.js'
      );
      startScheduledAgentTick();
    } catch (err) {
      console.warn('[app] scheduled-agents tick failed to start:', err);
    }
  })();

  if (env.USE_REAL_CHROME) {
    // 5-min cadence — ONE Line's idle timeout is shorter than 10 min in
    // practice (we observed it logged out between 10-min probes). At 5
    // min the probe still completes in ~30s for 6 carriers, well under
    // the cycle, and keeps even aggressive portals alive.
    startKeepAlivePinger(5 * 60 * 1000);
  }

  return app;
}
