import { Command } from 'commander';
import { registerMaerskCommands } from './cli/loginCmd.js';
import { registerQuoteCommand } from './cli/quoteCmd.js';
import { registerParseCommand } from './cli/parseCmd.js';
import { registerHistoryCommands } from './cli/historyCmd.js';
import { registerServeCommand } from './cli/serveCmd.js';

const program = new Command();

program
  .name('freight-copilot')
  .description('Retrieve and rank ocean freight rates from carrier portals')
  .version('0.0.1');

program
  .command('ping')
  .description('Smoke test — verify the CLI runs')
  .action(() => {
    console.log('[freight-copilot] pong');
  });

registerMaerskCommands(program);
registerQuoteCommand(program);
registerParseCommand(program);
registerHistoryCommands(program);
registerServeCommand(program);

program.parse();
