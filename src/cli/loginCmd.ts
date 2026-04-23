import { Command } from 'commander';
import { getCarrier, listCarriers } from '../carriers/registry.js';

export function registerMaerskCommands(program: Command): void {
  // Legacy: `maersk login` still works — delegates to the registry.
  const maersk = program
    .command('maersk')
    .description('Maersk carrier commands (shortcut for `carrier login MSK`)');

  maersk
    .command('login')
    .description('Open a browser, log in to Maersk, and save the session')
    .action(async () => {
      try {
        await getCarrier('MSK').login();
      } catch (err) {
        console.error('[maersk login] failed:', err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  // New: generic `carrier` command group for all supported carriers.
  const carrierCmd = program
    .command('carrier')
    .description('Work with any registered carrier (MSK, MSC, CMA, HLC, ONE, OOC, ZIM)');

  carrierCmd
    .command('login <code>')
    .description('Log in to a carrier in a headed browser and save the session')
    .action(async (codeRaw: string) => {
      try {
        const carrier = getCarrier(codeRaw);
        console.log(`[carrier login] ${carrier.name} (${carrier.code}) — opening browser...`);
        await carrier.login();
      } catch (err) {
        console.error('[carrier login] failed:', err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  carrierCmd
    .command('list')
    .description('List all known carriers and whether they are active')
    .action(() => {
      const rows = listCarriers();
      const widths = {
        code: Math.max(4, ...rows.map((c) => c.code.length)),
        name: Math.max(4, ...rows.map((c) => c.name.length)),
        url: Math.max(8, ...rows.map((c) => c.homeUrl.length)),
      };
      console.log('');
      console.log(
        'Code'.padEnd(widths.code) + '  ' +
          'Name'.padEnd(widths.name) + '  ' +
          'Home URL'.padEnd(widths.url) + '  Status'
      );
      console.log(
        '-'.repeat(widths.code) + '  ' +
          '-'.repeat(widths.name) + '  ' +
          '-'.repeat(widths.url) + '  ------'
      );
      for (const c of rows) {
        const status = c.isActive ? 'active' : 'onboarding pending';
        console.log(
          c.code.padEnd(widths.code) + '  ' +
            c.name.padEnd(widths.name) + '  ' +
            c.homeUrl.padEnd(widths.url) + '  ' +
            status
        );
      }
      console.log('');
    });
}
