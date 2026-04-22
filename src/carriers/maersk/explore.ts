/**
 * One-off exploration script: launches Playwright with the saved Maersk session,
 * navigates to /book/ (the booking details form), and dumps the rendered HTML
 * + a screenshot so we can identify stable selectors for the production
 * fetchRates flow.
 *
 * Usage: pnpm exec tsx src/carriers/maersk/explore.ts
 */
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDbClient } from '../../db/client.js';
import { carriers, sessions } from '../../db/schema.js';

const BOOK_URL = 'https://www.maersk.com/book/';
const OUT_DIR = resolve('./samples/maersk');

async function main() {
  const db = createDbClient();

  const [carrier] = await db
    .select()
    .from(carriers)
    .where(eq(carriers.code, 'MSK'));
  if (!carrier) throw new Error('Maersk carrier row missing');

  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.carrierId, carrier.id));
  if (!session) {
    throw new Error(
      'No saved session for Maersk. Run: pnpm dev maersk login'
    );
  }

  await mkdir(OUT_DIR, { recursive: true });

  console.log('[explore] Launching browser with saved session...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storageState: session.storageState as any,
  });
  const page = await context.newPage();

  console.log(`[explore] Navigating to ${BOOK_URL}`);
  await page.goto(BOOK_URL, { waitUntil: 'domcontentloaded' });

  // Wait a bit for SPA hydration (Maersk site uses heavy client-side rendering)
  console.log('[explore] Waiting 8s for SPA to finish rendering...');
  await page.waitForTimeout(8000);

  // Dump the current URL (in case of redirect to login)
  const finalUrl = page.url();
  console.log(`[explore] Final URL: ${finalUrl}`);

  // Grab the full page HTML
  const html = await page.content();
  const htmlPath = resolve(OUT_DIR, 'book-page-dump.html');
  await writeFile(htmlPath, html);
  console.log(`[explore] Saved HTML (${html.length} bytes) -> ${htmlPath}`);

  // Full-page screenshot
  const pngPath = resolve(OUT_DIR, 'book-page-dump.png');
  await page.screenshot({ path: pngPath, fullPage: true });
  console.log(`[explore] Saved screenshot -> ${pngPath}`);

  // Aria snapshot of the whole <body> (sees through Shadow DOM)
  try {
    const ariaSnapshot = await page.locator('body').ariaSnapshot();
    const axPath = resolve(OUT_DIR, 'book-page-a11y.yaml');
    await writeFile(axPath, ariaSnapshot);
    console.log(`[explore] Saved aria snapshot -> ${axPath}`);
  } catch (e) {
    console.log('[explore] ariaSnapshot unavailable:', (e as Error).message);
  }

  // Probe likely selectors and report what exists
  const probes = [
    { name: 'From field',        locator: page.getByLabel(/^From/i) },
    { name: 'To field',          locator: page.getByLabel(/^To /i) },
    { name: 'Commodity',         locator: page.getByLabel(/commodity/i) },
    { name: 'Container type',    locator: page.getByLabel(/container.*type|container type and size/i) },
    { name: 'Weight per cont.',  locator: page.getByLabel(/cargo weight per container/i) },
    { name: 'I am the price owner', locator: page.getByLabel(/i am the price owner/i) },
    { name: 'Cargo ready date',  locator: page.getByLabel(/when is your cargo ready/i) },
    { name: 'Select tomorrow link', locator: page.getByRole('link', { name: /select tomorrow/i }).or(page.getByRole('button', { name: /select tomorrow/i })) },
    { name: 'Continue to book btn', locator: page.getByRole('button', { name: /continue to book/i }) },
  ];

  console.log('[explore] --- selector probe ---');
  for (const p of probes) {
    const count = await p.locator.count();
    console.log(`  ${count > 0 ? '✓' : '✗'} ${p.name}: ${count} match(es)`);
  }

  // Also dump the page title for sanity
  const title = await page.title();
  console.log(`[explore] Page title: ${title}`);

  await browser.close();
  console.log('[explore] Done.');
}

main().catch((err) => {
  console.error('[explore] failed:', err);
  process.exit(1);
});
