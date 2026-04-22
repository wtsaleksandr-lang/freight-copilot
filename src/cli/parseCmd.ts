import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { parseRates } from '../llm/parseRates.js';
import { rankRates, formatRankedTable } from '../ranker/rankRates.js';

export function registerParseCommand(program: Command): void {
  program
    .command('parse')
    .description(
      'Parse a saved aria-tree YAML file with Claude (no browser fetch). Useful for iterating on parsing cheaply.'
    )
    .argument('<file>', 'Path to a .yaml file produced by a previous `quote` run')
    .action(async (file: string) => {
      try {
        const content = await readFile(file, 'utf8');
        console.log(`[parse] Loaded ${content.length} bytes from ${file}`);
        const rates = await parseRates(content);
        const ranked = rankRates(rates);
        console.log('');
        console.log(formatRankedTable(ranked));
        console.log('');
        console.log(
          `(${rates.length} option(s) parsed, ${ranked.length} ranked with price)`
        );
      } catch (err) {
        console.error('[parse] failed:', err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}
