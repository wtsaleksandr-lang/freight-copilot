import { Command } from 'commander';
import { fetchMaerskRates } from '../carriers/maersk/fetchRates.js';
import { parseRates } from '../llm/parseRates.js';
import { rankRates, formatRankedTable } from '../ranker/rankRates.js';
import { persistQuote } from '../db/persistQuote.js';

export function registerQuoteCommand(program: Command): void {
  program
    .command('quote')
    .description('Fetch ocean freight rates for a lane (Maersk only in V1)')
    .requiredOption('--from <city>', 'Origin city/port, e.g. "Newark"')
    .requiredOption('--to <city>', 'Destination city/port, e.g. "Antwerp"')
    .option(
      '--from-region <text>',
      'Disambiguator for From autocomplete, e.g. "New Jersey" or "United States"'
    )
    .option(
      '--to-region <text>',
      'Disambiguator for To autocomplete, e.g. "Belgium"'
    )
    .option(
      '--container <type>',
      'Container type label used by Maersk',
      '20 Dry Standard'
    )
    .option('--weight <kg>', 'Cargo weight per container in kg', '10000')
    .option('--commodity <name>', 'Commodity name', 'Autoparts')
    .option('--no-parse', 'Fetch rates but skip Claude parsing + DB save (for debugging the fetch)')
    .action(async (opts: Record<string, string | boolean>) => {
      try {
        const result = await fetchMaerskRates({
          origin: opts.from as string,
          originRegion: opts.fromRegion as string | undefined,
          destination: opts.to as string,
          destinationRegion: opts.toRegion as string | undefined,
          containerType: opts.container as string,
          cargoWeightKg: parseInt(opts.weight as string, 10),
          commodity: opts.commodity as string | undefined,
        });
        console.log(`[quote] Captured ${result.sailingsAriaTree.length} bytes of aria tree.`);

        if (opts.parse === false) {
          console.log('');
          console.log('─────────────────────────────────────────────');
          console.log('Fetch-only mode — skipping parse and DB save.');
          console.log(`  HTML:       ${result.htmlPath}`);
          console.log(`  Aria tree:  ${result.ariaTreePath}`);
          console.log(`  Screenshot: ${result.screenshotPath}`);
          console.log('');
          console.log(`Run \`pnpm dev parse "${result.ariaTreePath}"\` to test parsing.`);
          return;
        }

        const rates = await parseRates(result.sailingsAriaTree);
        const ranked = rankRates(rates);

        const today = new Date().toISOString().slice(0, 10);
        const quoteId = await persistQuote({
          origin: opts.from as string,
          destination: opts.to as string,
          containerType: opts.container as string,
          requestedDate: today,
          carrierCode: 'MSK',
          ranked,
          rawHtmlRef: result.htmlPath,
        });

        console.log('');
        console.log('─────────────────────────────────────────────');
        console.log(
          `Quote #${quoteId}: ${opts.from as string} → ${opts.to as string} (${opts.container as string})`
        );
        console.log('─────────────────────────────────────────────');
        console.log('');
        console.log(formatRankedTable(ranked));
        console.log('');
        console.log(
          `(${rates.length} option(s) parsed, ${ranked.length} ranked by price, saved as quote #${quoteId})`
        );
        console.log('');
        console.log(`  Raw HTML:       ${result.htmlPath}`);
        console.log(`  Aria tree:      ${result.ariaTreePath}`);
        console.log(`  Screenshot:     ${result.screenshotPath}`);
      } catch (err) {
        console.error(
          '[quote] failed:',
          err instanceof Error ? err.message : err
        );
        process.exit(1);
      }
    });
}
