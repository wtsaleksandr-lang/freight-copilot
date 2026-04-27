import { type Page } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDbClient } from '../../db/client.js';
import { carriers, sessions } from '../../db/schema.js';
import {
  CMA_URLS,
  CMA_SELECTORS,
  CMA_CONTAINER_INDEX,
  CMA_COMMODITY_DEFAULT,
  CMA_CUSTOMER_ROLE_DEFAULT,
} from './selectors.js';
import type { QuoteInput, FetchRatesResult } from '../types.js';
import { createBrowserContext } from '../browserContext.js';
import { detectCaptcha } from '../../captcha/detect.js';
import { CaptchaBlockedError } from '../../captcha/types.js';
import { captureFailure } from '../failureCapture.js';

const OUT_DIR = resolve('./samples/cma');

async function loadStoredStateOrNull() {
  const db = createDbClient();
  const [carrier] = await db
    .select()
    .from(carriers)
    .where(eq(carriers.code, 'CMA'));
  if (!carrier) return null;
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.carrierId, carrier.id));
  if (!session || session.expiresAt < new Date()) return null;
  return session.storageState;
}

async function pickPort(
  page: Page,
  inputSelector: string,
  resultSelector: string,
  value: string,
  fieldLabel: string,
  fallbackValue?: string
): Promise<void> {
  const input = page.locator(inputSelector).first();
  const opt = page.locator(resultSelector).first();

  async function typeAndCheck(typed: string): Promise<boolean> {
    console.log(`[fetchRates] ${fieldLabel}: typing "${typed}"`);
    await input.click();
    await input.fill('');
    await input.fill(typed);
    await page.waitForTimeout(1500);
    return opt.isVisible({ timeout: 4_000 }).catch(() => false);
  }

  let visible = await typeAndCheck(value);
  if (!visible && fallbackValue && fallbackValue !== value) {
    console.warn(
      `[fetchRates] CMA returned no port suggestion for "${value}" — retrying with "${fallbackValue}".`
    );
    visible = await typeAndCheck(fallbackValue);
  }
  if (!visible) {
    throw new Error(
      `CMA showed no port suggestion for "${value}"` +
        (fallbackValue ? ` (or fallback "${fallbackValue}")` : '') +
        ` in field ${fieldLabel}.`
    );
  }
  await opt.click();
  await page.waitForTimeout(500);
}

async function pickFromCmaDropdown(
  page: Page,
  triggerSelector: string,
  optionText: string,
  fieldLabel: string
): Promise<void> {
  console.log(`[fetchRates] ${fieldLabel}: choosing "${optionText}"`);
  await page.locator(triggerSelector).click();
  await page.waitForTimeout(700);
  // Element Plus renders dropdown options in a popper outside the trigger;
  // we match by visible text rather than by the dynamic #el-id-* anchors.
  const opt = page.getByText(optionText, { exact: false }).first();
  await opt.waitFor({ state: 'visible', timeout: 8_000 });
  await opt.click();
  await page.waitForTimeout(400);
}

export async function fetchCmaRates(
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
      '[fetchRates] WARNING: no CMA session on disk — if CMA redirects to login, run:\n' +
        '   pnpm exec tsx src/index.ts carrier login CMA'
    );
  }
  const page = await context.newPage();

  try {
    console.log(`[fetchRates] Navigating to ${CMA_URLS.spotOn}`);
    // Try the direct SpotOn URL first; if it 404s or redirects to home, fall
    // back to the menu walk that the recording captured.
    await page.goto(CMA_URLS.spotOn, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    if (!CMA_URLS.spotOnPattern.test(page.url())) {
      console.log(
        '[fetchRates] Direct SpotOn URL did not land — using menu walk fallback.'
      );
      await page.goto(CMA_URLS.home, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      await page.getByRole('link', { name: /AI My CMA CGM/i }).click();
      await page.waitForTimeout(800);
      await page.getByRole('link', { name: /^SpotOn$/i }).click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(4000);
    }

    const earlyCaptcha = await detectCaptcha(page);
    if (earlyCaptcha) {
      throw new CaptchaBlockedError(
        earlyCaptcha.type,
        page.url(),
        `CMA served a ${earlyCaptcha.type} challenge on page load.`
      );
    }

    await pickPort(
      page,
      CMA_SELECTORS.originInput,
      CMA_SELECTORS.originFirstOption,
      input.originPortCode || input.origin,
      'Origin',
      input.originPortCode ? input.origin : undefined
    );
    await pickPort(
      page,
      CMA_SELECTORS.destinationInput,
      CMA_SELECTORS.destinationFirstOption,
      input.destinationPortCode || input.destination,
      'Destination',
      input.destinationPortCode ? input.destination : undefined
    );

    // Container — pick the size tile by mapped index, then click "Add".
    const idx = CMA_CONTAINER_INDEX[input.containerType];
    if (!idx) {
      throw new Error(
        `No CMA container index mapping for "${input.containerType}". ` +
          'Add an entry to CMA_CONTAINER_INDEX in selectors.ts.'
      );
    }
    console.log(
      `[fetchRates] Container "${input.containerType}" → CMA tile #${idx}`
    );
    await page.locator(CMA_SELECTORS.containerAddButton(idx)).first().click();
    await page.waitForTimeout(700);

    // Weight (only the active .is-checked tile exposes its weight input).
    console.log(`[fetchRates] Weight: ${input.cargoWeightKg} kg`);
    const weight = page.locator(CMA_SELECTORS.weightInput).first();
    await weight.click();
    await weight.fill(String(input.cargoWeightKg));

    // Departure date — CMA's inland flow needs this set; if missing,
    // the form silently rejects the submit. Pick the first non-disabled
    // calendar cell (= "earliest available" sailing).
    const dateTrigger = page.locator(CMA_SELECTORS.departureDateTrigger).first();
    if (await dateTrigger.isVisible().catch(() => false)) {
      console.log('[fetchRates] Setting earliest-available departure date...');
      await dateTrigger.click();
      await page.waitForTimeout(700);
      const firstAvailableDay = page
        .locator(CMA_SELECTORS.calendarDayCell)
        .first();
      const ok = await firstAvailableDay
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (ok) {
        await firstAvailableDay.click();
        await page.waitForTimeout(400);
      } else {
        console.warn('[fetchRates] No calendar cell visible — leaving date blank.');
      }
    }

    await pickFromCmaDropdown(
      page,
      CMA_SELECTORS.commodityDropdown,
      input.commodity ?? CMA_COMMODITY_DEFAULT,
      'Commodity'
    );
    await pickFromCmaDropdown(
      page,
      CMA_SELECTORS.customerRoleDropdown,
      CMA_CUSTOMER_ROLE_DEFAULT,
      'Customer Role'
    );

    await mkdir(OUT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const formShot = resolve(OUT_DIR, `form-filled-${ts}.png`);
    await page.screenshot({ path: formShot, fullPage: true });
    console.log(`[fetchRates] Form screenshot -> ${formShot}`);

    console.log('[fetchRates] Clicking Get My Quote...');
    await page.locator(CMA_SELECTORS.submitButton).click();

    // Wait for the first sailing card or a captcha.
    const NAV_MAX_MS = 90_000;
    const start = Date.now();
    const sailing = page.locator(CMA_SELECTORS.firstSailingCard).first();
    while (Date.now() - start < NAV_MAX_MS) {
      const visible = await sailing.isVisible().catch(() => false);
      if (visible) break;
      const sig = await detectCaptcha(page);
      if (sig) {
        const failTs = new Date().toISOString().replace(/[:.]/g, '-');
        const failShot = resolve(OUT_DIR, `captcha-${failTs}.png`);
        await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
        throw new CaptchaBlockedError(
          sig.type,
          page.url(),
          `CMA served a ${sig.type} challenge after Search. Diagnostic: ${failShot}`
        );
      }
      await page.waitForTimeout(2000);
    }
    if (!(await sailing.isVisible().catch(() => false))) {
      const failShot = resolve(OUT_DIR, `submit-failed-${ts}.png`);
      await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
      throw new Error(
        `CMA results never appeared within ${NAV_MAX_MS / 1000}s. Diagnostic: ${failShot}`
      );
    }

    // Click into the first sailing so the rate breakdown is in view.
    console.log('[fetchRates] Opening first sailing...');
    await sailing.click();
    await page.waitForTimeout(2500);

    const finalUrl = page.url();
    const sailingsHtml = await page.content();
    const htmlPath = resolve(OUT_DIR, `sailings-${ts}.html`);
    const screenshotPath = resolve(OUT_DIR, `sailings-${ts}.png`);
    await writeFile(htmlPath, sailingsHtml);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[fetchRates] Saved HTML -> ${htmlPath}`);

    let sailingsAriaTree: string;
    try {
      sailingsAriaTree = await page.locator('section.results').first().ariaSnapshot();
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
    await captureFailure(page, 'CMA', (err as Error).message ?? 'unknown');
    throw err;
  } finally {
    await page.close().catch(() => undefined);
    await close();
  }
}
