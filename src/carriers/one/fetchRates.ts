import { type Page } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDbClient } from '../../db/client.js';
import { carriers, sessions } from '../../db/schema.js';
import {
  ONE_URLS,
  ONE_LABELS,
  ONE_SELECTORS,
  ONE_CONTAINER_LABELS,
} from './selectors.js';
import type { QuoteInput, FetchRatesResult } from '../types.js';
import { createBrowserContext } from '../browserContext.js';
import { detectCaptcha } from '../../captcha/detect.js';
import { CaptchaBlockedError } from '../../captcha/types.js';
import { captureFailure } from '../failureCapture.js';

const OUT_DIR = resolve('./samples/one');
const DEFAULT_COMMODITY = 'parts';

async function loadStoredStateOrNull() {
  const db = createDbClient();
  const [carrier] = await db
    .select()
    .from(carriers)
    .where(eq(carriers.code, 'ONE'));
  if (!carrier) return null;
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.carrierId, carrier.id));
  if (!session || session.expiresAt < new Date()) return null;
  return session.storageState;
}

/**
 * Origin/destination on ONE are Headless UI combobox inputs without an aria
 * label. The recording shows them as the 1st and 2nd combobox role on the
 * quote page, so we address them by index.
 */
async function fillPortByIndex(
  page: Page,
  comboboxIndex: number,
  value: string,
  fieldLabel: string,
  fallbackValue?: string
): Promise<void> {
  // The route comboboxes appear above the equipment/commodity comboboxes.
  // Index 0 = origin, 1 = destination.
  const combo = page.getByRole('combobox').nth(comboboxIndex);
  const opt = page.getByRole('option').first();

  async function typeAndCheck(typed: string): Promise<boolean> {
    console.log(`[fetchRates] ${fieldLabel}: typing "${typed}"`);
    await combo.click();
    await combo.fill('');
    await combo.fill(typed);
    await page.waitForTimeout(1500);
    return opt.isVisible({ timeout: 4_000 }).catch(() => false);
  }

  let visible = await typeAndCheck(value);
  if (!visible && fallbackValue && fallbackValue !== value) {
    console.warn(
      `[fetchRates] ONE returned no suggestion for "${value}" — retrying with "${fallbackValue}".`
    );
    visible = await typeAndCheck(fallbackValue);
  }
  if (!visible) {
    throw new Error(
      `ONE showed no port suggestion for "${value}"` +
        (fallbackValue ? ` (or fallback "${fallbackValue}")` : '') +
        ` in field ${fieldLabel}.`
    );
  }
  await opt.click();
  await page.waitForTimeout(400);
}

async function pickEquipment(page: Page, requested: string): Promise<void> {
  const target = ONE_CONTAINER_LABELS[requested] ?? requested;
  console.log(`[fetchRates] Equipment "${requested}" → ONE label "${target}"`);
  await page
    .getByRole('combobox', { name: ONE_LABELS.equipmentTypeCombobox })
    .first()
    .click();
  await page.waitForTimeout(700);
  const opt = page.getByText(target, { exact: false }).first();
  await opt.waitFor({ state: 'visible', timeout: 8_000 });
  await opt.click();
}

/**
 * Pick the next available date in ONE's vessel-departure calendar. ONE
 * disables past dates and a few non-sailing days; we click the first
 * "available" day cell that isn't disabled.
 */
async function pickFirstAvailableDate(page: Page): Promise<void> {
  console.log('[fetchRates] Opening vessel-date picker...');
  // Click the section label first to scroll it into view (recording does this).
  const sectionLabel = page.getByText(/Vessel Available Date/i).first();
  if (await sectionLabel.isVisible().catch(() => false)) {
    await sectionLabel.click().catch(() => undefined);
    await page.waitForTimeout(400);
  }
  await page.locator(ONE_SELECTORS.bookingFieldValue).first().click();
  await page.waitForTimeout(800);

  const days = page.locator(ONE_SELECTORS.calendarDay);
  const count = await days.count();
  console.log(`[fetchRates] Calendar shows ${count} cells.`);
  for (let i = 0; i < count; i++) {
    const cell = days.nth(i);
    const cls = (await cell.getAttribute('class').catch(() => '')) ?? '';
    if (/disabled|past/i.test(cls)) continue;
    const visible = await cell.isVisible().catch(() => false);
    if (!visible) continue;
    await cell.click();
    console.log(`[fetchRates] Picked calendar cell ${i + 1}.`);
    return;
  }
  throw new Error('No selectable date cell found in the ONE calendar.');
}

export async function fetchOneRates(
  input: QuoteInput
): Promise<FetchRatesResult> {
  const storedState = await loadStoredStateOrNull();
  const ctxResult = await createBrowserContext({ storageState: storedState });
  const { context, usingRealChrome, close } = ctxResult;
  console.log(
    `[fetchRates] ${usingRealChrome ? 'Connected to real Chrome (CDP)' : 'Launched bundled Chromium'}`
  );
  if (!usingRealChrome && !storedState) {
    console.warn(
      '[fetchRates] WARNING: no ONE session on disk — if ONE redirects to login, run:\n' +
        '   pnpm exec tsx src/index.ts carrier login ONE'
    );
  }
  const page = await context.newPage();

  try {
    // Direct deep-link to the quote form. Skips the PRICES menu walk
    // entirely (which depended on post-login chrome that's session-fragile).
    console.log(`[fetchRates] Navigating to ${ONE_URLS.quoteForm}`);
    await page.goto(ONE_URLS.quoteForm, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4500);

    const earlyCaptcha = await detectCaptcha(page);
    if (earlyCaptcha) {
      throw new CaptchaBlockedError(
        earlyCaptcha.type,
        page.url(),
        `ONE served a ${earlyCaptcha.type} challenge on the quote page.`
      );
    }

    await fillPortByIndex(
      page,
      0,
      input.originPortCode || input.origin,
      'Origin',
      input.originPortCode ? input.origin : undefined
    );
    await fillPortByIndex(
      page,
      1,
      input.destinationPortCode || input.destination,
      'Destination',
      input.destinationPortCode ? input.destination : undefined
    );

    // Cargo Owner radio is the user's "price owner" choice (vs. NVOCC).
    console.log('[fetchRates] Selecting Cargo Owner role...');
    await page.getByLabel(ONE_LABELS.cargoOwnerRadio).first().click();
    await page.waitForTimeout(400);

    await pickEquipment(page, input.containerType);

    // Cargo weight — ONE displays the value with thousands separators, but
    // the underlying input accepts a raw number.
    console.log(`[fetchRates] Weight: ${input.cargoWeightKg} kg`);
    const weight = page.locator(ONE_SELECTORS.cargoWeightInput).first();
    await weight.click({ clickCount: 2 });
    await weight.fill(String(input.cargoWeightKg));

    // Commodity.
    const commodity = input.commodity ?? DEFAULT_COMMODITY;
    console.log(`[fetchRates] Commodity: ${commodity}`);
    const commodityField = page
      .getByRole('combobox', { name: ONE_LABELS.commodityCombobox })
      .first();
    await commodityField.click();
    await commodityField.fill(commodity);
    await page.waitForTimeout(1200);
    // ONE allows free text — pressing Enter accepts the typed value.
    await commodityField.press('Enter').catch(() => undefined);

    await pickFirstAvailableDate(page);
    // Tap the loading-indicator backdrop to close the picker (recording trick).
    const backdrop = page.locator(ONE_SELECTORS.loadingIndicator).first();
    if (await backdrop.isVisible().catch(() => false)) {
      await backdrop.click({ force: true }).catch(() => undefined);
    }
    await page.waitForTimeout(600);

    await mkdir(OUT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const formShot = resolve(OUT_DIR, `form-filled-${ts}.png`);
    await page.screenshot({ path: formShot, fullPage: true });
    console.log(`[fetchRates] Form screenshot -> ${formShot}`);

    console.log('[fetchRates] Clicking GetQuote...');
    await page.getByRole('button', { name: ONE_LABELS.getQuote }).first().click();

    // Wait for the summary container or a captcha.
    const NAV_MAX_MS = 90_000;
    const start = Date.now();
    const summary = page.locator(ONE_SELECTORS.summaryView).first();
    while (Date.now() - start < NAV_MAX_MS) {
      const visible = await summary.isVisible().catch(() => false);
      if (visible) break;
      const sig = await detectCaptcha(page);
      if (sig) {
        const failTs = new Date().toISOString().replace(/[:.]/g, '-');
        const failShot = resolve(OUT_DIR, `captcha-${failTs}.png`);
        await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
        throw new CaptchaBlockedError(
          sig.type,
          page.url(),
          `ONE served a ${sig.type} challenge after GetQuote. Diagnostic: ${failShot}`
        );
      }
      await page.waitForTimeout(2000);
    }
    if (!(await summary.isVisible().catch(() => false))) {
      const failShot = resolve(OUT_DIR, `submit-failed-${ts}.png`);
      await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
      throw new Error(
        `ONE results never appeared within ${NAV_MAX_MS / 1000}s. Diagnostic: ${failShot}`
      );
    }
    console.log('[fetchRates] Summary visible — letting render settle...');
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    const sailingsHtml = await page.content();
    const htmlPath = resolve(OUT_DIR, `sailings-${ts}.html`);
    const screenshotPath = resolve(OUT_DIR, `sailings-${ts}.png`);
    await writeFile(htmlPath, sailingsHtml);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[fetchRates] Saved HTML -> ${htmlPath}`);

    let sailingsAriaTree: string;
    try {
      sailingsAriaTree = await page.locator(ONE_SELECTORS.summaryView).first().ariaSnapshot();
    } catch {
      console.warn('[fetchRates] Could not scope aria tree; using body.');
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
    await captureFailure(page, 'ONE', (err as Error).message ?? 'unknown');
    throw err;
  } finally {
    await page.close().catch(() => undefined);
    await close();
  }
}
