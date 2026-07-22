import { Command } from 'commander';
import { createApp } from '../server/app.js';
import { closeDbPool } from '../db/client.js';
import { networkInterfaces } from 'node:os';

function localIPs(): string[] {
  const nets = networkInterfaces();
  const ips: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] ?? []) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  return ips;
}

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Start the local web dashboard')
    .option('--port <n>', 'Port to listen on', '3000')
    .option(
      '--host <host>',
      'Bind address. "localhost" (default, this PC only) or "0.0.0.0" (reachable from your LAN / Tailscale).',
      'localhost'
    )
    .action((opts: { port: string; host: string }) => {
      const port = parseInt(opts.port, 10);
      if (!Number.isFinite(port)) {
        console.error(`Invalid port: ${opts.port}`);
        process.exit(1);
      }
      const host = opts.host;
      const app = createApp();
      const server = app.listen(port, host, () => {
        console.log('');
        if (host === '0.0.0.0') {
          console.log(`[serve] Dashboard listening on all interfaces, port ${port}.`);
          console.log('[serve] Reachable URLs:');
          console.log(`[serve]   http://localhost:${port}        (this PC)`);
          for (const ip of localIPs()) {
            console.log(`[serve]   http://${ip}:${port}    (LAN / Tailscale)`);
          }
        } else {
          console.log(
            `[serve] Dashboard running at http://localhost:${port} (this PC only)`
          );
          console.log('[serve] For LAN/phone access, restart with: pnpm dev serve --host 0.0.0.0');
        }
        console.log('[serve] Press Ctrl+C to stop.');
        console.log('');
      });

      const shutdown = (signal: string): void => {
        console.log(`\n[serve] ${signal} received; shutting down.`);
        server.close(() => {
          void closeDbPool()
            .catch((error) => console.error('[serve] Pool close failed:', error))
            .finally(() => process.exit(0));
        });
        setTimeout(() => process.exit(0), 5_000).unref();
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    });
}
