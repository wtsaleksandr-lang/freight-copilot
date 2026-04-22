import { chromium } from 'playwright';
import * as readline from 'node:readline/promises';
import { eq } from 'drizzle-orm';
import { createDbClient } from '../../db/client.js';
import { carriers, sessions } from '../../db/schema.js';

const MAERSK_START_URL = 'https://www.maersk.com/';
const SESSION_TTL_DAYS = 7;

export async function maerskLogin(): Promise<void> {
  const db = createDbClient();

  const [carrier] = await db
    .select()
    .from(carriers)
    .where(eq(carriers.code, 'MSK'));

  if (!carrier) {
    throw new Error(
      'Maersk row missing from carriers table. Run: pnpm exec tsx src/db/seed.ts'
    );
  }

  console.log('[login] Launching Chromium...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log(`[login] Opening ${MAERSK_START_URL}`);
  await page.goto(MAERSK_START_URL);

  console.log('');
  console.log('─────────────────────────────────────────────────────────────');
  console.log(' Log in to Maersk in the browser window that just opened.');
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
    `[login] Session saved for ${carrier.name}. Expires: ${expiresAt.toISOString()}`
  );

  await browser.close();
}
