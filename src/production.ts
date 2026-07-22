import { createApp } from './server/app.js';
import { closeDbPool } from './db/client.js';

function parsePort(value: string | undefined): number {
  const port = Number.parseInt(value || '3000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${value ?? ''}`);
  }
  return port;
}

const host = process.env.HOST?.trim() || '0.0.0.0';
const port = parsePort(process.env.PORT);
const app = createApp();

const server = app.listen(port, host, () => {
  console.log(`[production] LoadMode listening on http://${host}:${port}`);
  console.log('[production] Readiness check: /api/health/ready');
});

function shutdown(signal: string): void {
  console.log(`[production] ${signal} received; closing server.`);
  server.close((error) => {
    // Drain the shared PostgreSQL pool before exiting so in-flight queries
    // finish and connections are released cleanly on redeploy/restart.
    void closeDbPool()
      .catch((poolError) => console.error('[production] Pool close failed:', poolError))
      .finally(() => {
        if (error) {
          console.error('[production] Shutdown failed:', error);
          process.exit(1);
        }
        process.exit(0);
      });
  });

  setTimeout(() => {
    console.error('[production] Forced shutdown after timeout.');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
