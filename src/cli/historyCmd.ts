import { Command } from 'commander';
import { desc, eq } from 'drizzle-orm';
import { createDbClient } from '../db/client.js';
import { quotes, rateSnapshots } from '../db/schema.js';

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function padRow(cells: string[], widths: number[]): string {
  return cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
}

export function registerHistoryCommands(program: Command): void {
  program
    .command('history')
    .description('List the most recent quotes')
    .option('--limit <n>', 'Number of quotes to show', '20')
    .action(async (opts: { limit: string }) => {
      const db = createDbClient();
      const limit = parseInt(opts.limit, 10);
      const rows = await db
        .select()
        .from(quotes)
        .orderBy(desc(quotes.createdAt))
        .limit(limit);

      if (rows.length === 0) {
        console.log('(no quotes yet — run `pnpm dev quote --from ... --to ...`)');
        return;
      }

      const headers = ['ID', 'Created', 'Lane', 'Container'];
      const data = rows.map((q) => [
        `#${q.id}`,
        fmtDate(q.createdAt),
        `${q.origin} → ${q.destination}`,
        q.containerType,
      ]);
      const widths = headers.map((h, i) =>
        Math.max(h.length, ...data.map((r) => r[i]!.length))
      );

      console.log('');
      console.log(padRow(headers, widths));
      console.log(padRow(widths.map((w) => '─'.repeat(w)), widths));
      for (const r of data) console.log(padRow(r, widths));
      console.log('');
    });

  program
    .command('show')
    .description('Show full details for a past quote')
    .argument('<id>', 'Quote ID from `history`')
    .action(async (idStr: string) => {
      const db = createDbClient();
      const id = parseInt(idStr, 10);
      if (!Number.isFinite(id)) {
        console.error(`Invalid quote id: ${idStr}`);
        process.exit(1);
      }

      const [quote] = await db.select().from(quotes).where(eq(quotes.id, id));
      if (!quote) {
        console.error(`Quote #${id} not found.`);
        process.exit(1);
      }

      const snaps = await db
        .select()
        .from(rateSnapshots)
        .where(eq(rateSnapshots.quoteId, id))
        .orderBy(rateSnapshots.rank);

      console.log('');
      console.log(`Quote #${quote.id}: ${quote.origin} → ${quote.destination}`);
      console.log(`  Container:      ${quote.containerType}`);
      console.log(`  Requested:      ${quote.requestedDate}`);
      console.log(`  Created:        ${fmtDate(quote.createdAt)}`);
      if (quote.notes) console.log(`  Notes:          ${quote.notes}`);
      console.log('');

      if (snaps.length === 0) {
        console.log('  (no rate snapshots captured)');
        return;
      }

      console.log('Rate options (ranked by total freight cost):');
      for (const s of snaps) {
        const price = (s.totalCostCents / 100).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        console.log(
          `  #${s.rank}  ${s.sailingDate ?? '?'}  ` +
            `${s.currency} ${price}  ` +
            `${s.serviceName}  ` +
            `(${s.transitDays ?? '?'}d)`
        );
      }
      console.log('');
      if (snaps[0]?.rawHtmlRef) {
        console.log(`Raw HTML: ${snaps[0].rawHtmlRef}`);
      }
    });
}
