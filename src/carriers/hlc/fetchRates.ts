import { type Page } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDbClient } from '../../db/client.js';
import { carriers, sessions } from '../../db/schema.js';
import { HLC_URLS, HLC_TESTIDS, HLC_CONTAINER_LABELS } from './selectors.js';
import type { QuoteInput, FetchRatesResult } from '../types.js';
import { createBrowserContext } from '../browserContext.js';
import { detectCaptcha } from '../../captcha/detect.js';
import { CaptchaBlockedError } from '../../captcha/types.js';

const OUT_DIR = resolve('./samples/hlc');

async function loadStoredStateOrNull() {
  const db = createDbClient();
  const [carrier] = await db
    .select()
    .from(carriers)
    .where(eq(carriers.code, 'HLC'));
  if (!carrier) return null;
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.carrierId, carrier.id));
  if (!session || session.expiresAt < new Date()) return null;
  return session.storageState;
}

/**
 * Type into a HL location field and click the matching autocomplete result.
 * The dropdown items render as plain text rows; we match on a substring of
 * the typed query (case-insensitive) and prefer an exact-segment match.
 */
async function fillLocation(
  page: Page,
  testidSelector: string,
  value: string,
  fieldLabel: string,
  regionHint?: string
): Promise<void> {
  console.log(`[fetchRates] ${fieldLabel}: typing "${value}"`);
  const input = page.locator(testidSelector);
  await input.click();
  await input.fill(value);
  await page.waitForTimeout(1500);

  if (regionHint) {
    const re = new RegExp(regionHint, 'i');
    const opt = page.getByText(re).first();
    if ((await opt.count()) > 0) {
      await opt.click();
      return;
    }
    console.warn(
      `[fetchRates] No HL option matched "${regionHint}" for "${fieldLabel}" — falling back to first match.`
    );
  }
  // Take the first visible suggestion that contains the typed value.
  const upperFirstWord = value.split(/[\s,]/)[0]?.toUpperCase() ?? value;
  const opt = page.getByText(new RegExp(upperFirstWord, 'i')).first();
  await opt.waitFor({ state: 'visible', timeout: 10_000 });
  await opt.click();
}

async function pickContainerType(page: Page, requested: string): Promise<void> {
  const target = HLC_CONTAINER_LABELS[requested] ?? requested;
  console.log(`[fetchRates] Container: "${requested}" → HL label "${target}"`);
  await page.locator(HLC_TESTIDS.containerInput).click();
  await page.waitForTimeout(700);
  const opt = page.getByText(target, { exact: false }).first();
  await opt.waitFor({ state: 'visible', timeout: 8_000 });
  await opt.click();
}

export async function fetchHlcRates(
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
      '[fetchRates] WARNING: no HLC session on disk — if HL redirects to login, run:\n' +
        '   pnpm exec tsx src/index.ts carrier login HLC'
    );
  }
  const page = await context.newPage();

  try {
    console.log(`[fetchRates] Navigating to ${HLC_URLS.newQuote}`);
    await page.goto(HLC_URLS.newQuote, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000); // SPA hydration

    const earlyCaptcha = await detectCaptcha(page);
    if (earlyCaptcha) {
      throw new CaptchaBlockedError(
        earlyCaptcha.type,
        page.url(),
        `HLC served a ${earlyCaptcha.type} challenge on page load.`
      );
    }

    await fillLocation(
      page,
      HLC_TESTIDS.startInput,
      input.originPortCode || input.origin,
      'Origin',
      input.originPortCode ? undefined : input.originRegion
    );
    await fillLocation(
      page,
      HLC_TESTIDS.endInput,
      input.destinationPortCode || input.destination,
      'Destination',
      input.destinationPortCode ? undefined : input.destinationRegion
    );
    await pickContainerType(page, input.containerType);

    console.log(`[fetchRates] Weight: ${input.cargoWeightKg} kg`);
    const weight = page.locator(HLC_TESTIDS.weightInput);
    await weight.click();
    await weight.fill(String(input.cargoWeightKg));

    await mkdir(OUT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const formShot = resolve(OUT_DIR, `form-filled-${ts}.png`);
    await page.screenshot({ path: formShot, fullPage: true });
    console.log(`[fetchRates] Form screenshot -> ${formShot}`);

    console.log('[fetchRates] Clicking search submit...');
    await page.locator(HLC_TESTIDS.searchSubmit).click();

    // Wait for an offer-card select button to render (or a captcha to show up).
    const NAV_MAX_MS = 90_000;
    const start = Date.now();
    const offerBtn = page.locator(HLC_TESTIDS.offerSelect).first();
    while (Date.now() - start < NAV_MAX_MS) {
      const visible = await offerBtn.isVisible().catch(() => false);
      if (visible) break;
      const sig = await detectCaptcha(page);
      if (sig) {
        const failTs = new Date().toISOString().replace(/[:.]/g, '-');
        const failShot = resolve(OUT_DIR, `captcha-${failTs}.png`);
        await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
        throw new CaptchaBlockedError(
          sig.type,
          page.url(),
          `HLC served a ${sig.type} challenge after Search. Diagnostic: ${failShot}`
        );
      }
      await page.waitForTimeout(2000);
    }
    if (!(await offerBtn.isVisible().catch(() => false))) {
      const failShot = resolve(OUT_DIR, `submit-failed-${ts}.png`);
      await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
      throw new Error(
        `HLC results never appeared within ${NAV_MAX_MS / 1000}s. Diagnostic: ${failShot}`
      );
    }
    console.log('[fetchRates] Offers visible — letting render settle...');
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
      sailingsAriaTree = await page
        .locator(HLC_TESTIDS.offerSelect)
        .first()
        .locator('xpath=ancestor::*[self::main or self::section][1]')
        .first()
        .ariaSnapshot();
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
  } finally {
    await page.close().catch(() => undefined);
    await close();
  }
}
