import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  /**
   * Standard PostgreSQL connection string. Works with ANY standard Postgres —
   * Replit-managed Postgres, Neon-hosted Postgres, or a self-hosted/local
   * instance. Required: data persists outside the server filesystem so
   * redeploys don't wipe shipments / quotes / settings. SSL is negotiated from
   * the URL's sslmode (e.g. `?sslmode=require` for managed cloud Postgres,
   * `?sslmode=disable` for a plaintext local instance).
   */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (a standard PostgreSQL connection string)'),
  /**
   * Master key for encrypting app-stored provider credentials (AES-256-GCM),
   * as 64 hex chars or a 32-byte base64 value. Distinct from SESSION_SECRET.
   * Optional here (validated + enforced in secretsCrypto): REQUIRED in
   * production — the app refuses to auto-generate an ephemeral key there.
   */
  SECRETS_MASTER_KEY: z.string().optional(),
  /** Optional env fallbacks for additional AI providers (vault takes precedence). */
  OPENAI_API_KEY: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
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
  /**
   * AI provider. 'anthropic' (default) or 'gemini'. Decides which API
   * the parse pipelines hit. Both share the same prompt-shape — the
   * adapter layer translates tool-use, file format, and response
   * parsing per provider. Set the matching API key:
   *   AI_PROVIDER=anthropic  (default)  → ANTHROPIC_API_KEY
   *   AI_PROVIDER=gemini                → GEMINI_API_KEY
   */
  AI_PROVIDER: z
    .enum(['anthropic', 'gemini'])
    .default('anthropic'),
  /**
   * Primary model. Default = Claude Haiku 4.5 — cheap & fast, vision-
   * capable, handles 95%+ of this app's workload. The validator-and-
   * retry loop (validateExtraction.ts) automatically falls back to
   * AI_MODEL_FALLBACK when math doesn't reconcile, so the tail of
   * tricky multi-page rate sheets still gets Sonnet-quality output.
   *
   * Per-provider examples:
   *   AI_PROVIDER=anthropic AI_MODEL=claude-haiku-4-5-20251001
   *   AI_PROVIDER=anthropic AI_MODEL=claude-sonnet-4-6
   *   AI_PROVIDER=anthropic AI_MODEL=claude-opus-4-7
   *   AI_PROVIDER=gemini    AI_MODEL=gemini-2.0-flash
   *   AI_PROVIDER=gemini    AI_MODEL=gemini-1.5-pro
   */
  AI_MODEL: z.string().min(1).default('claude-haiku-4-5-20251001'),
  /**
   * Fallback model — used only when the validator catches a math /
   * consistency error in the primary's output. Should be stronger
   * than AI_MODEL. Default = Sonnet 4.6.
   *
   * Setting equal to AI_MODEL disables the fallback (single-pass).
   */
  AI_MODEL_FALLBACK: z.string().min(1).default('claude-sonnet-4-6'),
  /** Google AI Studio key (for AI_PROVIDER=gemini). */
  GEMINI_API_KEY: z.string().optional(),
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
