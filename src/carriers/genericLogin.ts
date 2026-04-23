import { chromium } from 'playwright';
import * as readline from 'node:readline/promises';
import { eq } from 'drizzle-orm';
import { createDbClient } from '../db/client.js';
import { carriers, sessions } from '../db/schema.js';

const SESSION_TTL_DAYS = 7;

export interface GenericLoginParams {
  carrierCode: string;
  carrierName: string;
  homeUrl: string;
  /** Optional detection hint shown to the user (e.g., "look for your name in the top-right"). */
  loggedInHint?: string;
}

/**
 * Generic headed-login flow. Works for any carrier portal:
 *  - launch visible Chromium
 *  - navigate to homeUrl
 *  - wait for the user to log in manually (+ solve 2FA/captcha if needed)
 *  - capture storageState (cookies + localStorage) and upsert to `sessions` table
 */
export async function genericLogin(params: GenericLoginParams): Promise<void> {
  const db = createDbClient();

  const [carrier] = await db
    .select()
    .from(carriers)
    .where(eq(carriers.code, params.carrierCode));
  if (!carrier) {
    throw new Error(
      `Carrier ${params.carrierCode} missing from carriers table. Run: pnpm exec tsx src/db/seed.ts`
    );
  }

  console.log(`[login] Launching Chromium for ${params.carrierName}...`);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log(`[login] Opening ${params.homeUrl}`);
  await page.goto(params.homeUrl);

  console.log('');
  console.log('─────────────────────────────────────────────────────────────');
  console.log(` Log in to ${params.carrierName} in the browser window that just opened.`);
  if (params.loggedInHint) {
    console.log(` Tip: ${params.loggedInHint}`);
  }
  console.log(' Handle any 2FA / captcha prompts as you normally would.');
  console.log(' Once you are fully logged in, come back to this terminal');
  console.log(' and press ENTER to save your session.');
  console.log('─────────────────────────────────────────────────────────────');
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  await rl.question('Press ENTER once logged in (or Ctrl+C to cancel)... ');
  rl.close();

  console.log('[login] Capturing session state...');
  const storageState = await context.storageState();
  const cookieCount = storageState.cookies?.length ?? 0;
  const originCount = storageState.origins?.length ?? 0;
  console.log(
    `[login] Captured ${cookieCount} cookies across ${originCount} origin(s).`
  );
  if (cookieCount === 0) {
    console.warn(
      '[login] WARNING: No cookies were captured. Did login actually complete?'
    );
  }

  const expiresAt = new Date(
    Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000
  );
  const now = new Date();

  await db
    .insert(sessions)
    .values({
      carrierId: carrier.id,
      storageState,
      lastUsedAt: now,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: sessions.carrierId,
      set: {
        storageState,
        lastUsedAt: now,
        expiresAt,
      },
    });

  console.log(
    `[login] Session saved for ${params.carrierName}. Expires: ${expiresAt.toISOString()}`
  );
  await browser.close();
}
