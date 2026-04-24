import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getCarrier, listCarriers } from '../carriers/registry.js';

/**
 * `record` command — wraps Playwright Codegen so you can capture a workflow
 * without typing it out step-by-step. The output is ready-to-use Playwright
 * code that Claude can convert into a fetchRates adapter.
 */
export function registerRecordCommand(program: Command): void {
  program
    .command('record')
    .description(
      'Open Playwright Codegen to record a browser workflow. ' +
        'Do your normal clicks and typing — generated code is saved to samples/<code>/recorded.ts.'
    )
    .option(
      '--carrier <code>',
      'Registered carrier code (MSK, MSC, CMA, HLC, ONE, OOC, ZIM). Uses its home URL.'
    )
    .option(
      '--url <url>',
      'Starting URL (alternative to --carrier, for arbitrary sites)'
    )
    .option(
      '--lang <lang>',
      'Output language: javascript, python, playwright-test, csharp, java',
      'javascript'
    )
    .option('--out <file>', 'Override output file path')
    .action(async (opts: Record<string, string>) => {
      let startUrl: string;
      let outFile: string;
      let label: string;

      if (opts.carrier) {
        let carrier;
        try {
          carrier = getCarrier(opts.carrier);
        } catch (err) {
          console.error('[record]', err instanceof Error ? err.message : err);
          console.error('\nKnown carrier codes:');
          for (const c of listCarriers()) {
            console.error(`  ${c.code.padEnd(4)} ${c.name}`);
          }
          process.exit(1);
        }
        startUrl = carrier.homeUrl;
        const dir = resolve('./samples', carrier.code.toLowerCase());
        await mkdir(dir, { recursive: true });
        outFile = opts.out ?? resolve(dir, 'recorded.ts');
        label = `${carrier.name} (${carrier.code})`;
      } else if (opts.url) {
        startUrl = opts.url;
        const dir = resolve('./samples', '_misc');
        await mkdir(dir, { recursive: true });
        outFile = opts.out ?? resolve(dir, `recorded-${Date.now()}.ts`);
        label = startUrl;
      } else {
        console.error(
          'Provide --carrier <CODE> or --url <URL>.\nExample: pnpm dev record --carrier MSC'
        );
        process.exit(1);
      }

      const lang = opts.lang ?? 'javascript';

      console.log('');
      console.log('─────────────────────────────────────────────────────────────');
      console.log(` Recording workflow for: ${label}`);
      console.log(` Starting URL: ${startUrl}`);
      console.log('');
      console.log(' Playwright Codegen will open two windows:');
      console.log('   1. A Chromium browser navigated to the URL above');
      console.log('   2. A "Playwright Inspector" panel showing live code');
      console.log('');
      console.log(' Do your normal workflow (login, search, click through).');
      console.log(' Every action is recorded as Playwright code in real time.');
      console.log(' Close the browser window when finished.');
      console.log('');
      console.log(` Recording saves to:`);
      console.log(`   ${outFile}`);
      console.log('─────────────────────────────────────────────────────────────');
      console.log('');

      // Spawn the playwright CLI — shell: true makes `pnpm` resolve correctly on Windows.
      const proc = spawn(
        'pnpm',
        [
          'exec',
          'playwright',
          'codegen',
          '--output',
          outFile,
          '--target',
          lang,
          startUrl,
        ],
        { stdio: 'inherit', shell: true }
      );

      await new Promise<void>((done) => {
        proc.on('close', (code) => {
          console.log('');
          if (code === 0) {
            console.log(`[record] Recording saved: ${outFile}`);
            console.log('');
            console.log('Next step — when onboarding the carrier, share this file with Claude:');
            console.log(`  1. Open the file and review what was captured.`);
            console.log(`  2. In a conversation with Claude, say: "Use ${outFile} to build the ${label} adapter."`);
            console.log(`  3. Claude writes src/carriers/<code>/fetchRates.ts + selectors.ts from the recording.`);
          } else {
            console.log(`[record] Playwright codegen exited with code ${code}.`);
          }
          done();
        });
      });
    });
}
