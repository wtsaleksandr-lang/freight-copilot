import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  DATABASE_FILE: z.string().min(1).default('./data/freight-copilot.db'),
  /**
   * If "true", record/quote/agent connect to a real Chrome you've launched
   * with --remote-debugging-port=9222 (use the "Chrome (Freight Copilot)"
   * desktop shortcut). Bypasses bot-detection on hostile sites
   * (Hapag, CMA, etc.) by using your actual Chrome fingerprint + cookies.
   */
  USE_REAL_CHROME: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  /**
   * Optional. If both BASIC_AUTH_USER and BASIC_AUTH_PASS are set, the
   * dashboard requires HTTP Basic auth. Strongly recommended any time you
   * expose the server beyond localhost (--host 0.0.0.0, Tailscale, tunnels).
   */
  BASIC_AUTH_USER: z.string().optional(),
  BASIC_AUTH_PASS: z.string().optional(),
  /**
   * Optional. Base URL of a running DelayPredict instance, e.g.
   * http://localhost:5001. When set, the Shipments tab joins each row
   * with DelayPredict's tracking status by personal_ref → refId.
   * If unset, the status column shows "Not tracked" for every row.
   */
  DELAYPREDICT_URL: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[config] Invalid environment variables:');
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    console.error('\nCopy .env.example to .env and fill in the values.');
    process.exit(1);
  }
  return result.data;
}
