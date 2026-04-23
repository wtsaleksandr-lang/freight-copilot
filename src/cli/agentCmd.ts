import { Command } from 'commander';
import { runAgent } from '../agent/runAgent.js';

export function registerAgentCommand(program: Command): void {
  program
    .command('agent')
    .description('Run the generic web agent — Claude drives a browser to complete a goal on any site')
    .requiredOption('--url <url>', 'Starting URL')
    .requiredOption('--goal <text>', 'What you want the agent to do')
    .option('--max-iterations <n>', 'Maximum turns before giving up', '25')
    .action(async (opts: Record<string, string>) => {
      try {
        const result = await runAgent({
          url: opts.url!,
          goal: opts.goal!,
          maxIterations: parseInt(opts.maxIterations ?? '25', 10),
        });
        console.log('');
        console.log('─────────────────────────────────────────────');
        console.log(`Agent ${result.finished ? 'FINISHED' : 'STOPPED'}`);
        console.log(`  Start URL:   ${result.startUrl}`);
        console.log(`  Final URL:   ${result.finalUrl}`);
        console.log(`  Steps:       ${result.steps.length}`);
        console.log(`  Reason:      ${result.finishReason}`);
      } catch (err) {
        console.error('[agent] failed:', err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}
