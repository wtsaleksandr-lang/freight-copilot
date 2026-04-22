import { Command } from 'commander';
import { createApp } from '../server/app.js';

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Start the local web dashboard at http://localhost:<port>')
    .option('--port <n>', 'Port to listen on', '3000')
    .action((opts: { port: string }) => {
      const port = parseInt(opts.port, 10);
      if (!Number.isFinite(port)) {
        console.error(`Invalid port: ${opts.port}`);
        process.exit(1);
      }
      const app = createApp();
      app.listen(port, () => {
        console.log('');
        console.log(
          `[serve] Freight Copilot dashboard running at http://localhost:${port}`
        );
        console.log('[serve] Press Ctrl+C to stop.');
        console.log('');
      });
    });
}
