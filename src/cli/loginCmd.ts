import { Command } from 'commander';
import { maerskLogin } from '../carriers/maersk/login.js';

export function registerMaerskCommands(program: Command): void {
  const maersk = program
    .command('maersk')
    .description('Maersk carrier commands');

  maersk
    .command('login')
    .description('Open a browser, log in to Maersk, and save the session')
    .action(async () => {
      try {
        await maerskLogin();
      } catch (err) {
        console.error(
          '[maersk login] failed:',
          err instanceof Error ? err.message : err
        );
        process.exit(1);
      }
    });
}
