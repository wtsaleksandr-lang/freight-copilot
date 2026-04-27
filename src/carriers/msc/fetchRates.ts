import { type Page } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDbClient } from '../../db/client.js';
import { carriers, sessions } from '../../db/schema.js';
import { MSC_URLS, MSC_SELECTORS, MSC_CONTAINER_PATTERNS } from './selectors.js';
import type { QuoteInput, FetchRatesResult } from '../types.js';
import { createBrowserContext } from '../browserContext.js';
import { detectCaptcha } from '../../captcha/detect.js';
import { CaptchaBlockedError } from '../../captcha/types.js';

const OUT_DIR = resolve('./samples/msc');

async function loadStoredStateOrNull() {
  const db = createDbClient();
  const [carrier] = await db
    .select()
    .from(carriers)
    .where(eq(carriers.code, 'MSC'));
  if (!carrier) return null;
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.carrierId, carrier.id));
  if (!session || session.expiresAt < new Date()) return null;
  return session.storageState;
}

/**
 * MSC's Instant Quote starts with EVERY container size-type checked. We need
 * exactly one selected, so we iterate all equipment checkboxes, read each
 * one's accessible name, and uncheck any that doesn't match the target.
 *
 * Recording observed two click patterns:
 *   - getByRole('checkbox', { name: '40DV' }).click()         (role-based)
 *   - locator('[data-test-id="equipment-sizetype-input-2"]')  (index-based)
 * The role-based name is more stable across portal redesigns; we prefer it.
 */
async function selectOnlyContainer(
  page: Page,
  containerType: string
): Promise<void> {
  // Build a list of patterns that MSC's checkbox label might match for our
  // requested container. Falls back to literal-string match for unknown
  // container types.
  const patterns = MSC_CONTAINER_PATTERNS[containerType] ?? [
    new RegExp('^' + containerType.replace(/[^a-z0-9]/gi, '\\s*') + '\\b', 'i'),
  ];
  console.log(
    `[fetchRates] Filtering containers to "${containerType}" only ` +
      `(patterns: ${patterns.map((p) => p.source).join(', ')})`
  );

  const checkboxes = page.locator(MSC_SELECTORS.equipmentInputPrefix);
  const count = await checkboxes.count();
  if (count === 0) {
    throw new Error(
      `No equipment-sizetype checkboxes found. Selector "${MSC_SELECTORS.equipmentInputPrefix}" may be stale.`
    );
  }

  let kept = 0;
  for (let i = 0; i < count; i++) {
    const cb = checkboxes.nth(i);
    const ariaLabel = (await cb.getAttribute('aria-label').catch(() => null)) ?? '';
    const value = (await cb.getAttribute('value').catch(() => null)) ?? '';
    const label = (ariaLabel || value).trim();
    const isMatch = patterns.some((p) => p.test(label));
    const checked = await cb.isChecked().catch(() => false);

    if (isMatch && !checked) {
      await cb.click();
      kept++;
      console.log(`[fetchRates]   + selected ${label}`);
    } else if (isMatch && checked) {
      kept++;
      console.log(`[fetchRates]   = kept ${label}`);
    } else if (!isMatch && checked) {
      await cb.click();
      console.log(`[fetchRates]   - deselected ${label}`);
    }
  }

  if (kept === 0) {
    // Help future debugging: dump what we did see.
    const seen: string[] = [];
    for (let i = 0; i < count; i++) {
      const cb = checkboxes.nth(i);
      const a = (await cb.getAttribute('aria-label').catch(() => null)) ?? '';
      const v = (await cb.getAttribute('value').catch(() => null)) ?? '';
      seen.push((a || v).trim());
    }
    throw new Error(
      `No MSC checkbox matched "${containerType}". ` +
        `MSC offered: [${seen.filter(Boolean).join(', ')}]. ` +
        'Add a pattern to MSC_CONTAINER_PATTERNS in selectors.ts.'
    );
  }
}

async function pickPort(
  page: Page,
  triggerSelector: string,
  inputSelector: string,
  optionSelector: string,
  search: string,
  fieldLabel: string
): Promise<void> {
  console.log(`[fetchRates] ${fieldLabel}: typing "${search}"`);
  await page.locator(triggerSelector).click();
  const input = page.locator(inputSelector);
  await input.fill(search);
  // Wait for the autocomplete list to populate (option-0 to exist + be visible).
  const option = page.locator(optionSelector);
  await option.waitFor({ state: 'visible', timeout: 15000 });
  await option.click();
}

export async function fetchMscRates(
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
      '[fetchRates] WARNING: no MSC session on disk — if MSC redirects to login, run:\n' +
        '   pnpm exec tsx src/index.ts carrier login MSC'
    );
  }
  const page = await context.newPage();

  try {
    console.log(`[fetchRates] Navigating to ${MSC_URLS.instantQuote}`);
    await page.goto(MSC_URLS.instantQuote, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000); // SPA hydration

    // Captcha check before we start interacting.
    const earlyCaptcha = await detectCaptcha(page);
    if (earlyCaptcha) {
      throw new CaptchaBlockedError(
        earlyCaptcha.type,
        page.url(),
        `MSC served a ${earlyCaptcha.type} challenge on page load.`
      );
    }

    await selectOnlyContainer(page, input.containerType);

    // Prefer LOCODE; MSC's autocomplete shows e.g. "CHARLESTON [USCHS]"
    // and matches LOCODE substring queries reliably.
    await pickPort(
      page,
      MSC_SELECTORS.originDropdownTrigger,
      MSC_SELECTORS.originInput,
      MSC_SELECTORS.originFirstOption,
      input.originPortCode || input.origin,
      'Origin'
    );

    await pickPort(
      page,
      MSC_SELECTORS.destinationDropdownTrigger,
      MSC_SELECTORS.destinationInput,
      MSC_SELECTORS.destinationFirstOption,
      input.destinationPortCode || input.destination,
      'Destination'
    );

    await mkdir(OUT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const formShot = resolve(OUT_DIR, `form-filled-${ts}.png`);
    await page.screenshot({ path: formShot, fullPage: true });
    console.log(`[fetchRates] Form screenshot -> ${formShot}`);

    console.log('[fetchRates] Clicking Search Rates...');
    await page.locator(MSC_SELECTORS.searchRateButton).click();

    // Wait for at least one result card to appear, with a captcha check while
    // we wait so we can fail fast if MSC challenges us.
    const NAV_MAX_MS = 90_000;
    const start = Date.now();
    let firstCard = page.locator(MSC_SELECTORS.resultCard).first();
    while (Date.now() - start < NAV_MAX_MS) {
      const visible = await firstCard.isVisible().catch(() => false);
      if (visible) break;
      const sig = await detectCaptcha(page);
      if (sig) {
        const failTs = new Date().toISOString().replace(/[:.]/g, '-');
        const failShot = resolve(OUT_DIR, `captcha-${failTs}.png`);
        await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
        throw new CaptchaBlockedError(
          sig.type,
          page.url(),
          `MSC served a ${sig.type} challenge after Search. Diagnostic: ${failShot}`
        );
      }
      await page.waitForTimeout(2000);
    }
    if (!(await firstCard.isVisible().catch(() => false))) {
      const failShot = resolve(OUT_DIR, `submit-failed-${ts}.png`);
      await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
      throw new Error(
        `MSC results never appeared within ${NAV_MAX_MS / 1000}s. Diagnostic: ${failShot}`
      );
    }
    console.log('[fetchRates] Results visible — letting render settle...');
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    const sailingsHtml = await page.content();
    const htmlPath = resolve(OUT_DIR, `sailings-${ts}.html`);
    const screenshotPath = resolve(OUT_DIR, `sailings-${ts}.png`);
    await writeFile(htmlPath, sailingsHtml);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[fetchRates] Saved HTML -> ${htmlPath}`);
    console.log(`[fetchRates] Saved screenshot -> ${screenshotPath}`);

    let sailingsAriaTree: string;
    try {
      sailingsAriaTree = await page
        .locator(MSC_SELECTORS.resultCard)
        .locator(
          'xpath=ancestor::*[self::main or self::section or self::div][1]'
        )
        .first()
        .ariaSnapshot();
    } catch {
      console.warn(
        '[fetchRates] Could not scope aria tree to results container; falling back to body.'
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
    await page.close().catch(() => undefined);
    await close();
  }
}
