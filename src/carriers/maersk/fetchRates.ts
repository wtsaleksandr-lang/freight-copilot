import { chromium, type Page } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDbClient } from '../../db/client.js';
import { carriers, sessions } from '../../db/schema.js';
import { MAERSK_URLS, MAERSK_LABELS } from './selectors.js';

export interface QuoteInput {
  origin: string;
  /** Country/region substring to disambiguate `origin` in the autocomplete, e.g. "New Jersey" or "United States". */
  originRegion?: string;
  destination: string;
  /** Country/region substring to disambiguate `destination`, e.g. "Belgium". */
  destinationRegion?: string;
  containerType: string;
  cargoWeightKg: number;
  commodity?: string;
}

export interface FetchRatesResult {
  finalUrl: string;
  /** Full rendered HTML of the page (may miss Shadow DOM content — kept for debugging). */
  sailingsHtml: string;
  /** YAML-ish aria tree of the sailings section. Sees through Shadow DOM. THIS is what the LLM parses. */
  sailingsAriaTree: string;
  htmlPath: string;
  ariaTreePath: string;
  screenshotPath: string;
}

const OUT_DIR = resolve('./samples/maersk');
const DEFAULT_COMMODITY = 'Autoparts';

async function loadSession() {
  const db = createDbClient();

  const [carrier] = await db
    .select()
    .from(carriers)
    .where(eq(carriers.code, 'MSK'));
  if (!carrier) throw new Error('Maersk row missing from carriers table.');

  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.carrierId, carrier.id));
  if (!session) {
    throw new Error('No saved Maersk session. Run: pnpm dev maersk login');
  }
  if (session.expiresAt < new Date()) {
    throw new Error(
      'Maersk session expired. Run: pnpm dev maersk login'
    );
  }

  return { carrier, session };
}

async function pickFromAutocomplete(
  page: Page,
  labelName: string,
  value: string,
  /** If provided, pick the dropdown option whose text contains this substring (case-insensitive). */
  regionHint?: string
): Promise<void> {
  const field = page.getByRole('combobox', { name: labelName });
  await field.click();
  await field.fill(value);
  await page.waitForTimeout(1500); // wait for suggestions

  if (regionHint) {
    const regex = new RegExp(regionHint, 'i');
    const option = page.getByRole('option', { name: regex }).first();
    const count = await option.count();
    if (count === 0) {
      throw new Error(
        `No autocomplete option matched "${regionHint}" for field "${labelName}" after typing "${value}". ` +
          `Try a different region hint or a more specific search term.`
      );
    }
    await option.click();
  } else {
    // No region hint: take the first suggestion (fine for unambiguous names).
    await field.press('ArrowDown');
    await field.press('Enter');
  }
}

async function waitForEnabled(page: Page, labelName: string, timeoutMs = 15000) {
  const start = Date.now();
  const field = page.getByRole('combobox', { name: labelName });
  while (Date.now() - start < timeoutMs) {
    const disabled = await field.isDisabled().catch(() => true);
    if (!disabled) return;
    await page.waitForTimeout(300);
  }
  throw new Error(`Timed out waiting for "${labelName}" to become enabled`);
}

async function waitForLocatorEnabled(
  page: Page,
  locator: ReturnType<Page['locator']>,
  label: string,
  timeoutMs = 20000
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const disabled = await locator.isDisabled().catch(() => true);
    if (!disabled) return;
    await page.waitForTimeout(300);
  }
  throw new Error(`Timed out waiting for "${label}" to become enabled`);
}

/** Polls until no "Getting products and prices" placeholders are left (or a cap is hit). */
async function waitForSailingsQuiescent(page: Page, maxMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const loading = await page
      .getByText(/getting products and prices/i)
      .count();
    if (loading === 0) return;
    await page.waitForTimeout(1000);
  }
  console.warn(
    '[fetchRates] Some sailings still loading after timeout — continuing anyway.'
  );
}

/** Clicks "Search more sailing options" until all batches are loaded. */
async function loadAllSailings(page: Page): Promise<void> {
  const MAX_ITERS = 10;
  for (let i = 0; i < MAX_ITERS; i++) {
    const btn = page
      .getByRole('button', { name: /search more sailing options/i })
      .first();
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) {
      console.log('[fetchRates] No "Search more" button — all sailings loaded.');
      return;
    }
    const disabled = await btn.isDisabled().catch(() => true);
    if (disabled) {
      console.log('[fetchRates] "Search more" is disabled — all sailings loaded.');
      return;
    }
    console.log(`[fetchRates] Loading more sailings (batch ${i + 1})...`);
    await btn.click();
    await page.waitForTimeout(1500);
    await waitForSailingsQuiescent(page);
  }
  console.warn(
    `[fetchRates] Hit ${MAX_ITERS}-batch safety cap; some sailings may remain unloaded.`
  );
}

/** Expands the "Price breakdown & details" accordion on every sailing card. */
async function expandAllBreakdowns(page: Page): Promise<void> {
  const articles = page.locator('article');
  const count = await articles.count();
  console.log(`[fetchRates] Expanding breakdown on ${count} sailing(s)...`);

  for (let i = 0; i < count; i++) {
    const article = articles.nth(i);
    const expander = article
      .getByText(/price breakdown & details/i)
      .first();
    const visible = await expander.isVisible().catch(() => false);
    if (!visible) continue;
    try {
      await expander.scrollIntoViewIfNeeded();
      await expander.click();
      await page.waitForTimeout(500); // let the panel animate in
    } catch (e) {
      console.warn(
        `[fetchRates] Could not expand breakdown for sailing #${i + 1}: ${(e as Error).message}`
      );
    }
  }
  // Let any final network calls for destination charges settle
  await page.waitForTimeout(1500);
}

export async function fetchMaerskRates(
  input: QuoteInput
): Promise<FetchRatesResult> {
  const { session } = await loadSession();

  console.log('[fetchRates] Launching browser (headed)...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storageState: session.storageState as any,
  });
  const page = await context.newPage();

  try {
    console.log(`[fetchRates] Navigating to ${MAERSK_URLS.book}`);
    await page.goto(MAERSK_URLS.book, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000); // let SPA render

    // --- Fill location fields ---
    console.log(
      `[fetchRates] From: ${input.origin}` +
        (input.originRegion ? ` (region: ${input.originRegion})` : '')
    );
    await pickFromAutocomplete(
      page,
      MAERSK_LABELS.fromCombobox,
      input.origin,
      input.originRegion
    );

    console.log(
      `[fetchRates] To: ${input.destination}` +
        (input.destinationRegion ? ` (region: ${input.destinationRegion})` : '')
    );
    await pickFromAutocomplete(
      page,
      MAERSK_LABELS.toCombobox,
      input.destination,
      input.destinationRegion
    );

    // --- Commodity (autocomplete too) ---
    const commodity = input.commodity ?? DEFAULT_COMMODITY;
    console.log(`[fetchRates] Commodity: ${commodity}`);
    const commodityField = page.getByLabel(/commodity/i).first();
    await commodityField.click();
    await commodityField.fill(commodity);
    await page.waitForTimeout(1500);
    await commodityField.press('ArrowDown');
    await commodityField.press('Enter');

    // --- Container type (enabled only after origin/dest set) ---
    console.log('[fetchRates] Waiting for container type to enable...');
    await waitForEnabled(page, MAERSK_LABELS.containerTypeCombobox);

    console.log(`[fetchRates] Container type: ${input.containerType}`);
    await pickFromAutocomplete(
      page,
      MAERSK_LABELS.containerTypeCombobox,
      input.containerType
    );

    // --- Weight ---
    console.log(`[fetchRates] Cargo weight: ${input.cargoWeightKg} kg`);
    const weightField = page.getByRole('textbox', {
      name: MAERSK_LABELS.cargoWeightTextbox,
    });
    await weightField.click();
    await weightField.fill(String(input.cargoWeightKg));

    // --- Price owner ---
    // The radio is progressively enabled after prior fields are filled, and
    // the <input> is visually hidden behind a styled wrapper. We wait for
    // it to become enabled, then click it via JS evaluate to bypass
    // Playwright's visibility/viewport checks.
    console.log('[fetchRates] Waiting for price owner radio to enable...');
    const priceOwner = page.getByLabel(MAERSK_LABELS.priceOwnerRadio);
    await waitForLocatorEnabled(page, priceOwner, 'I am the price owner');

    console.log('[fetchRates] Selecting "I am the price owner" (via JS click)');
    await priceOwner.evaluate((el) => {
      (el as HTMLInputElement).click();
    });
    await page.waitForTimeout(500);

    // --- Cargo ready date ---
    // The form pre-fills a default date. We try the "Select tomorrow" shortcut,
    // but it's disabled if the current value already covers tomorrow.
    const selectTomorrow = page
      .getByRole('link', { name: MAERSK_LABELS.selectTomorrow })
      .or(page.getByRole('button', { name: MAERSK_LABELS.selectTomorrow }))
      .first();
    const tomorrowDisabled = await selectTomorrow
      .getAttribute('aria-disabled')
      .catch(() => null);
    if (tomorrowDisabled === 'true') {
      console.log('[fetchRates] "Select tomorrow" is disabled — date default is already valid, skipping.');
    } else {
      console.log('[fetchRates] Clicking "Select tomorrow"');
      await selectTomorrow.click();
    }

    // Take a screenshot of the filled form BEFORE submitting, for debugging
    await mkdir(OUT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const formShot = resolve(OUT_DIR, `form-filled-${ts}.png`);
    await page.screenshot({ path: formShot, fullPage: true });
    console.log(`[fetchRates] Form screenshot -> ${formShot}`);

    // --- Submit ---
    const continueBtn = page.getByRole('button', {
      name: MAERSK_LABELS.continueToBook,
    });
    console.log('[fetchRates] Waiting for "Continue to book" to enable...');
    await waitForLocatorEnabled(page, continueBtn, 'Continue to book', 20000);
    console.log('[fetchRates] Clicking "Continue to book"');
    await continueBtn.click();

    console.log('[fetchRates] Waiting for /book/sailings navigation...');
    // Poll for URL change. Maersk sometimes shows a captcha ("click the thing
    // capable of being folded" etc.) when it thinks we're automated. Since the
    // browser is headed and visible, the user can solve it by hand — we just
    // keep waiting (up to 5 minutes) for the URL to change.
    const navStart = Date.now();
    const NAV_MAX_MS = 5 * 60_000;
    let navPrompted = false;
    while (Date.now() - navStart < NAV_MAX_MS) {
      if (MAERSK_URLS.sailingsPattern.test(page.url())) break;
      if (Date.now() - navStart > 15_000 && !navPrompted) {
        console.log('');
        console.log('─────────────────────────────────────────────────────────────');
        console.log(' WAITING — Maersk may be showing a bot-check / captcha.');
        console.log(' Look at the Chrome window that opened and solve it by hand.');
        console.log(' As soon as you pass, the script will continue automatically.');
        console.log('─────────────────────────────────────────────────────────────');
        console.log('');
        navPrompted = true;
      }
      await page.waitForTimeout(2000);
    }
    if (!MAERSK_URLS.sailingsPattern.test(page.url())) {
      await mkdir(OUT_DIR, { recursive: true });
      const failTs = new Date().toISOString().replace(/[:.]/g, '-');
      const failShot = resolve(OUT_DIR, `submit-failed-${failTs}.png`);
      await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
      console.error(`[fetchRates] Submit never navigated. URL still: ${page.url()}`);
      console.error(`[fetchRates] Diagnostic screenshot -> ${failShot}`);
      throw new Error(
        'Maersk navigation did not complete within 5 minutes (captcha not solved or other block).'
      );
    }
    console.log('[fetchRates] Navigation succeeded.');
    console.log('[fetchRates] Sailings page loaded, letting initial render settle...');
    await page.waitForTimeout(4000);

    // Phase 6.1: Load every sailing by looping "Search more sailing options"
    await waitForSailingsQuiescent(page);
    await loadAllSailings(page);

    // Phase 6.2: Expand "Price breakdown & details" on every sailing card so the
    // breakdown tables (Freight charges + Destination charges) appear in the aria tree.
    await expandAllBreakdowns(page);

    const finalUrl = page.url();
    console.log(`[fetchRates] Final URL: ${finalUrl}`);

    const sailingsHtml = await page.content();
    const htmlPath = resolve(OUT_DIR, `sailings-${ts}.html`);
    const screenshotPath = resolve(OUT_DIR, `sailings-${ts}.png`);
    await writeFile(htmlPath, sailingsHtml);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[fetchRates] Saved HTML -> ${htmlPath}`);
    console.log(`[fetchRates] Saved screenshot -> ${screenshotPath}`);

    // Aria tree of the sailings section — this is what the LLM parses.
    // Scope to the "Select sailing" heading's nearest container if possible,
    // otherwise fall back to body.
    let sailingsAriaTree: string;
    try {
      sailingsAriaTree = await page
        .getByRole('heading', { name: /select sailing/i })
        .locator('xpath=ancestor::*[self::main or self::section or self::div][1]')
        .first()
        .ariaSnapshot();
    } catch {
      console.warn(
        '[fetchRates] Could not scope aria tree to "Select sailing" container; falling back to body.'
      );
      sailingsAriaTree = await page.locator('body').ariaSnapshot();
    }
    const ariaTreePath = resolve(OUT_DIR, `sailings-${ts}.yaml`);
    await writeFile(ariaTreePath, sailingsAriaTree);
    console.log(
      `[fetchRates] Saved aria tree (${sailingsAriaTree.length} bytes) -> ${ariaTreePath}`
    );

    return {
      finalUrl,
      sailingsHtml,
      sailingsAriaTree,
      htmlPath,
      ariaTreePath,
      screenshotPath,
    };
  } finally {
    await browser.close();
  }
}
