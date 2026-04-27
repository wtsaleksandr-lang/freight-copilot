import { type Page } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDbClient } from '../../db/client.js';
import { carriers, sessions } from '../../db/schema.js';
import { MAERSK_URLS, MAERSK_LABELS } from './selectors.js';
import type { QuoteInput, FetchRatesResult } from '../types.js';
import { createBrowserContext } from '../browserContext.js';
import { detectCaptcha } from '../../captcha/detect.js';
import { CaptchaBlockedError } from '../../captcha/types.js';
import { captureFailure } from '../failureCapture.js';
import { getSolver } from '../../captcha/solver.js';

export type { QuoteInput, FetchRatesResult };

const OUT_DIR = resolve('./samples/maersk');
const DEFAULT_COMMODITY = 'Autoparts';

/** Returns the saved Maersk storageState if present and unexpired, else null.
 *  In real-Chrome mode this is null (the user's Chrome owns the cookies). */
async function loadStoredStateOrNull() {
  const db = createDbClient();
  const [carrier] = await db
    .select()
    .from(carriers)
    .where(eq(carriers.code, 'MSK'));
  if (!carrier) return null;
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.carrierId, carrier.id));
  if (!session || session.expiresAt < new Date()) return null;
  return session.storageState;
}

async function pickFromAutocomplete(
  page: Page,
  labelName: string,
  value: string,
  /** If provided, pick the dropdown option whose text contains this substring (case-insensitive). */
  regionHint?: string,
  /** If `value` (e.g. a LOCODE) produces no options, retry with this. */
  fallbackValue?: string
): Promise<void> {
  const field = page.getByRole('combobox', { name: labelName });

  async function typeAndOptionCount(typed: string): Promise<number> {
    await field.click();
    await field.fill('');
    await field.fill(typed);
    await page.waitForTimeout(1500);
    return page.getByRole('option').count();
  }

  let optionsCount = await typeAndOptionCount(value);
  if (optionsCount === 0 && fallbackValue && fallbackValue !== value) {
    console.warn(
      `[fetchRates] "${value}" produced 0 options for "${labelName}" — retrying with "${fallbackValue}".`
    );
    optionsCount = await typeAndOptionCount(fallbackValue);
  }
  if (optionsCount === 0) {
    throw new Error(
      `No autocomplete options for "${labelName}" after typing "${value}"` +
        (fallbackValue ? ` (and fallback "${fallbackValue}")` : '') +
        '.'
    );
  }

  if (regionHint) {
    const regex = new RegExp(regionHint, 'i');
    const option = page.getByRole('option', { name: regex }).first();
    if ((await option.count()) > 0) {
      await option.click();
      return;
    }
    console.warn(
      `[fetchRates] No option matched "${regionHint}" for "${labelName}" — falling back to first option.`
    );
  }
  // Take the first suggestion.
  await field.press('ArrowDown');
  await field.press('Enter');
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
  // In bundled-Chromium mode we restore the saved Maersk storageState.
  // In real-Chrome mode we use the user's actual Chrome session — they're
  // already logged in via normal browsing.
  const ctxResult = await createBrowserContext({
    storageState: await loadStoredStateOrNull(),
  });
  const { context, usingRealChrome, close } = ctxResult;
  console.log(
    `[fetchRates] ${usingRealChrome ? 'Connected to real Chrome (CDP)' : 'Launched bundled Chromium'}`
  );
  const page = await context.newPage();

  try {
    console.log(`[fetchRates] Navigating to ${MAERSK_URLS.book}`);
    await page.goto(MAERSK_URLS.book, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000); // let SPA render

    // --- Fill location fields ---
    // Prefer the UN/LOCODE if the user picked a known port — it's a 5-char
    // unambiguous match in Maersk's combobox. Falls back to typing the
    // city name (with region hint) if no code was provided.
    const fromPrimary = input.originPortCode || input.origin;
    const fromFallback = input.originPortCode ? input.origin : undefined;
    console.log(
      `[fetchRates] From: ${fromPrimary}` +
        (input.originPortCode ? ` (LOCODE; fallback "${input.origin}")` : '') +
        (input.originRegion ? ` region: ${input.originRegion}` : '')
    );
    await pickFromAutocomplete(
      page,
      MAERSK_LABELS.fromCombobox,
      fromPrimary,
      input.originRegion,
      fromFallback
    );

    const toPrimary = input.destinationPortCode || input.destination;
    const toFallback = input.destinationPortCode
      ? input.destination
      : undefined;
    console.log(
      `[fetchRates] To: ${toPrimary}` +
        (input.destinationPortCode ? ` (LOCODE; fallback "${input.destination}")` : '') +
        (input.destinationRegion ? ` region: ${input.destinationRegion}` : '')
    );
    await pickFromAutocomplete(
      page,
      MAERSK_LABELS.toCombobox,
      toPrimary,
      input.destinationRegion,
      toFallback
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
    // Poll for URL change. If a captcha is detected during the wait, we give up
    // cleanly so the bundle runner can mark this carrier as captcha_blocked
    // and continue with the others — instead of stalling 5 minutes.
    const navStart = Date.now();
    const NAV_MAX_MS = 90_000; // 1.5 min — plenty for a fast site, short enough not to block other carriers
    const CAPTCHA_GRACE_MS = 12_000; // give the page time to render before we look for captcha
    while (Date.now() - navStart < NAV_MAX_MS) {
      if (MAERSK_URLS.sailingsPattern.test(page.url())) break;

      if (Date.now() - navStart > CAPTCHA_GRACE_MS) {
        const sig = await detectCaptcha(page);
        if (sig) {
          console.warn(
            `[fetchRates] Captcha detected: ${sig.type} (${sig.evidence})`
          );
          const solver = getSolver();
          if (solver) {
            // Future: solver.solve(...) + solver.applyToken(...).
            console.warn(
              `[fetchRates] Solver provider "${solver.name}" configured but auto-solve not yet implemented — failing over.`
            );
          }
          await mkdir(OUT_DIR, { recursive: true });
          const failTs = new Date().toISOString().replace(/[:.]/g, '-');
          const failShot = resolve(OUT_DIR, `captcha-${failTs}.png`);
          await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
          throw new CaptchaBlockedError(
            sig.type,
            page.url(),
            `Maersk served a ${sig.type} challenge. Diagnostic: ${failShot}`
          );
        }
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
        `Maersk navigation did not complete within ${NAV_MAX_MS / 1000}s and no captcha was detected (other block).`
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
  } catch (err) {
    await captureFailure(page, 'MSK', (err as Error).message ?? 'unknown');
    throw err;
  } finally {
    // Close just our page; close() handles the browser if we own it.
    await page.close().catch(() => undefined);
    await close();
  }
}
