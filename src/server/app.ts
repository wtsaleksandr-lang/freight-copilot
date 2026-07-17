import express from 'express';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { registerApiRoutes } from './routes.js';
import { registerBundleDetailRoute } from './bundleDetailRoute.js';
import { registerQuoteValidationRoute } from './quoteValidationRoute.js';
import { registerShipmentReportRoute } from './shipmentReportRoute.js';
import { registerShipmentEmailRoute } from './shipmentEmailRoute.js';
import { registerShipmentUpdateIntakeRoute } from './shipmentUpdateIntakeRoute.js';
import { registerTruckingRateIngestionRoute } from './truckingRateIngestionRoute.js';
import { registerDrayageRateIngestionRoute } from './drayageRateIngestionRoute.js';
import { loadEnv } from '../config.js';
import { startKeepAlivePinger } from './sessionProbe.js';

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  const env = loadEnv();
  if (env.BASIC_AUTH_USER && env.BASIC_AUTH_PASS) {
    const expected = 'Basic ' + Buffer.from(`${env.BASIC_AUTH_USER}:${env.BASIC_AUTH_PASS}`).toString('base64');
    app.use((req, res, next) => {
      const got = req.header('authorization') ?? '';
      if (got === expected) return next();
      res.status(401).set('WWW-Authenticate', 'Basic realm="freight-copilot"').send('Authentication required');
    });
    console.log('[app] HTTP Basic auth enabled');
  }

  registerBundleDetailRoute(app);
  registerQuoteValidationRoute(app);
  registerShipmentReportRoute(app);
  registerShipmentEmailRoute(app);
  registerShipmentUpdateIntakeRoute(app);
  registerTruckingRateIngestionRoute(app);
  registerDrayageRateIngestionRoute(app);
  registerApiRoutes(app);

  const publicDir = resolve(process.cwd(), 'src/server/public');
  app.get('/', async (_req, res, next) => {
    try {
      const indexPath = resolve(publicDir, 'index.html');
      const source = await readFile(indexPath, 'utf8');
      const html = source
        .replace('<link rel="stylesheet" href="/style.css">', '<link rel="stylesheet" href="/style.css">\n  <link rel="stylesheet" href="/freshness-ui.css">')
        .replace('<script src="/app.js"></script>', '<script src="/freshness-ui.js"></script>\n  <script src="/shipment-report-ui.js"></script>\n  <script src="/shipment-email-ui.js"></script>\n  <script src="/shipment-update-ui.js"></script>\n  <script src="/trucking-estimate-ui.js"></script>\n  <script src="/trucking-ingestion-ui.js"></script>\n  <script src="/drayage-ingestion-ui.js"></script>\n  <script src="/app.js"></script>');
      res.type('html').send(html);
    } catch (err) { next(err); }
  });
  app.use(express.static(publicDir));

  app.use('/quotes-files', express.static(resolve(process.cwd(), 'quotes')));
  app.use('/parsed-sheets-files', express.static(resolve(process.cwd(), 'parsed-sheets')));
  app.use('/shipments-files', express.static(resolve(process.cwd(), 'shipments-files')));
  app.use('/drayage-rates-files', express.static(resolve(process.cwd(), 'drayage-rates-files')));

  void (async () => {
    try {
      const { startScheduledAgentTick } = await import('./scheduledAgentsService.js');
      startScheduledAgentTick();
    } catch (err) { console.warn('[app] scheduled-agents tick failed to start:', err); }
  })();

  if (env.USE_REAL_CHROME) startKeepAlivePinger(5 * 60 * 1000);
  return app;
}
