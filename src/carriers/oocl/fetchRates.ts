import { type Page } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDbClient } from '../../db/client.js';
import { carriers, sessions } from '../../db/schema.js';
import { OOCL_URLS, OOCL_SELECTORS, OOCL_CONTAINER_LABELS } from './selectors.js';
import type { QuoteInput, FetchRatesResult } from '../types.js';
import { createBrowserContext } from '../browserContext.js';
import { detectCaptcha } from '../../captcha/detect.js';
import { CaptchaBlockedError } from '../../captcha/types.js';

const OUT_DIR = resolve('./samples/ooc');

async function loadStoredStateOrNull() {
  const db = createDbClient();
  const [carrier] = await db
    .select()
    .from(carriers)
    .where(eq(carriers.code, 'OOC'));
  if (!carrier) return null;
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.carrierId, carrier.id));
  if (!session || session.expiresAt < new Date()) return null;
  return session.storageState;
}

/**
 * Type into a port field then click the matching dropdown option. OOCL's
 * suggestions render as `div.location-text` rows; we match by substring.
 * regionHint disambiguates Toronto-Canada vs Toronto-Ohio etc.
 */
async function pickPort(
  page: Page,
  inputSelector: string,
  value: string,
  fieldLabel: string,
  regionHint?: string
): Promise<void> {
  console.log(`[fetchRates] ${fieldLabel}: typing "${value}"`);
  const input = page.locator(inputSelector).first();
  await input.click();
  await input.fill(value);
  await page.waitForTimeout(1500);

  const re = new RegExp(regionHint ?? value, 'i');
  const options = page.locator(OOCL_SELECTORS.locationOption);
  const count = await options.count();
  for (let i = 0; i < count; i++) {
    const opt = options.nth(i);
    const text = (await opt.textContent().catch(() => '')) ?? '';
    if (re.test(text)) {
      console.log(`[fetchRates]   match: "${text.trim()}"`);
      await opt.click();
      return;
    }
  }
  // Fallback: take the first visible option.
  const first = options.first();
  await first.waitFor({ state: 'visible', timeout: 5_000 });
  console.log(
    `[fetchRates]   no regex match; taking first option: "${(await first.textContent())?.trim() ?? ''}"`
  );
  await first.click();
}

async function pickContainerType(page: Page, requested: string): Promise<void> {
  const target = OOCL_CONTAINER_LABELS[requested] ?? requested;
  console.log(`[fetchRates] Container "${requested}" → OOCL label "${target}"`);
  await page.locator(OOCL_SELECTORS.containerTypeTrigger).first().click();
  await page.waitForTimeout(700);
  // Match the OOCL label as a substring of the option's text.
  const opt = page.getByText(target, { exact: false }).first();
  await opt.waitFor({ state: 'visible', timeout: 8_000 });
  await opt.click();
}

export async function fetchOoclRates(
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
      '[fetchRates] WARNING: no OOCL session on disk — if FreightSmart redirects to login, run:\n' +
        '   pnpm exec tsx src/index.ts carrier login OOC'
    );
  }
  const page = await context.newPage();

  try {
    console.log(`[fetchRates] Navigating to ${OOCL_URLS.home}`);
    await page.goto(OOCL_URLS.home, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4500);

    const earlyCaptcha = await detectCaptcha(page);
    if (earlyCaptcha) {
      throw new CaptchaBlockedError(
        earlyCaptcha.type,
        page.url(),
        `OOCL served a ${earlyCaptcha.type} challenge on page load.`
      );
    }

    await pickPort(
      page,
      OOCL_SELECTORS.originInput,
      input.origin,
      'Origin',
      input.originRegion
    );
    await pickPort(
      page,
      OOCL_SELECTORS.destinationInput,
      input.destination,
      'Destination',
      input.destinationRegion
    );
    await pickContainerType(page, input.containerType);

    // Container quantity — default to 1 (we quote per-container).
    console.log('[fetchRates] Setting quantity to 1...');
    const qty = page.locator(OOCL_SELECTORS.quantityInput).first();
    await qty.click({ clickCount: 2 });
    await qty.fill('1');

    await mkdir(OUT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const formShot = resolve(OUT_DIR, `form-filled-${ts}.png`);
    await page.screenshot({ path: formShot, fullPage: true });
    console.log(`[fetchRates] Form screenshot -> ${formShot}`);

    console.log('[fetchRates] Clicking Get Quote...');
    await page.getByRole('button', { name: /^Get Quote$/i }).first().click();
    await page.waitForTimeout(3000);

    // Sometimes OOCL shows a "no e-quote yet — click HERE to create one"
    // banner before the actual results table appears. Click HERE if present.
    const hereLink = page.locator(OOCL_SELECTORS.noEquoteHereLink).first();
    if (await hereLink.isVisible().catch(() => false)) {
      console.log('[fetchRates] Clicking "here" link to create e-quote...');
      await hereLink.click();
      await page.waitForTimeout(2500);
    }

    // Wait for an e-quote button to appear in the results. They have names
    // like "00023910EQGTA000045" — we match by regex.
    const NAV_MAX_MS = 90_000;
    const start = Date.now();
    const equoteBtn = page
      .getByRole('button', { name: /^\d{6,}EQ[A-Z0-9]+/ })
      .first();
    while (Date.now() - start < NAV_MAX_MS) {
      const visible = await equoteBtn.isVisible().catch(() => false);
      if (visible) break;
      const sig = await detectCaptcha(page);
      if (sig) {
        const failTs = new Date().toISOString().replace(/[:.]/g, '-');
        const failShot = resolve(OUT_DIR, `captcha-${failTs}.png`);
        await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
        throw new CaptchaBlockedError(
          sig.type,
          page.url(),
          `OOCL served a ${sig.type} challenge after Get Quote. Diagnostic: ${failShot}`
        );
      }
      await page.waitForTimeout(2000);
    }
    if (!(await equoteBtn.isVisible().catch(() => false))) {
      const failShot = resolve(OUT_DIR, `no-equote-${ts}.png`);
      await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
      throw new Error(
        `OOCL did not return an e-quote within ${NAV_MAX_MS / 1000}s. ` +
          'This lane may not be supported (OOCL FreightSmart is Canada-only ' +
          'in practice). Diagnostic: ' +
          failShot
      );
    }

    // Click the e-quote — OOCL opens the detail in a NEW TAB. Race the
    // popup event against an in-place navigation in case behavior varies.
    console.log('[fetchRates] Clicking first e-quote — expecting new tab...');
    const newPagePromise = context
      .waitForEvent('page', { timeout: 15_000 })
      .catch(() => null);
    await equoteBtn.click();
    const popup = await newPagePromise;

    let detailPage: Page = page;
    if (popup) {
      console.log('[fetchRates] New tab opened — switching to it.');
      await popup.waitForLoadState('domcontentloaded').catch(() => undefined);
      await popup.waitForTimeout(3500);
      detailPage = popup;
    } else {
      // Fall back: same-tab navigation. Wait briefly for the URL to match.
      await page
        .waitForURL(OOCL_URLS.detailPattern, { timeout: 10_000 })
        .catch(() => undefined);
      await page.waitForTimeout(2500);
    }
    if (!OOCL_URLS.detailPattern.test(detailPage.url())) {
      console.warn(
        `[fetchRates] Detail page URL didn't match pattern; got: ${detailPage.url()} — proceeding anyway.`
      );
    }

    const finalUrl = detailPage.url();
    const sailingsHtml = await detailPage.content();
    const htmlPath = resolve(OUT_DIR, `sailings-${ts}.html`);
    const screenshotPath = resolve(OUT_DIR, `sailings-${ts}.png`);
    await writeFile(htmlPath, sailingsHtml);
    await detailPage.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[fetchRates] Saved HTML -> ${htmlPath}`);

    let sailingsAriaTree: string;
    try {
      sailingsAriaTree = await detailPage.locator('body').ariaSnapshot();
    } catch {
      console.warn('[fetchRates] aria snapshot failed; using empty.');
      sailingsAriaTree = '';
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
    await page.close().catch(() => undefined);
    await close();
  }
}
