/**
 * Live session probe for Real Chrome mode. Connects to the user's
 * "Chrome (Freight Copilot)" via CDP, navigates to each carrier's quote
 * URL, and reports whether the form is reachable (logged in) or whether
 * the portal redirected to a login screen.
 *
 * Doubles as a keep-alive: navigating to the quote URL itself counts as
 * portal activity and resets the idle timeout — most carriers expire
 * idle sessions in 20–60 min, so a probe every 10 min keeps the user
 * logged in indefinitely (until absolute session lifetime, ~7 days).
 *
 * Zero AI/LLM cost. Pure deterministic Playwright + URL/selector checks.
 */

import { createBrowserContext } from '../carriers/browserContext.js';

export interface CarrierProbeResult {
  carrierCode: string;
  loggedIn: boolean;
  /** Final URL after navigation. */
  finalUrl: string;
  /** Free-form note (e.g., "redirect to /login", "form rendered"). */
  detail: string;
  /** Probe latency in ms. */
  ms: number;
  /** When the probe ran. */
  checkedAt: string;
}

/**
 * URL each carrier's quote form lives at when logged in. Anything else
 * (different host, /login path, /signin path, /auth path, the public home)
 * is treated as logged-out.
 */
const CARRIER_QUOTE_URLS: Record<string, string> = {
  MSK: 'https://www.maersk.com/book/',
  MSC: 'https://www.mymsc.com/myMSC/instantquote',
  CMA: 'https://www.cma-cgm.com/ebusiness/pricing/instant-Quoting',
  HLC: 'https://www.hapag-lloyd.com/solutions/new-quote/#/simple?language=en',
  ONE: 'https://ecomm.one-line.com/one-ecom/prices/one-quote-booking',
  OOC: 'https://freightsmart.oocl.com/ui/',
};

/**
 * Per-carrier "you're on the form, not the login screen" check. Each
 * carrier has a distinctive selector that only renders post-login.
 */
const QUOTE_FORM_SELECTORS: Record<string, string[]> = {
  MSK: [
    'role=combobox[name=/From \\(City, Country\\/Region\\)/i]',
  ],
  MSC: [
    '[data-test-id^="equipment-sizetype-input-"]',
    '[data-test-id="originDropDown"]',
  ],
  CMA: [
    'div.o-search-port input',
    '#DdlCommodity',
  ],
  HLC: [
    '[data-testid="start-input"]',
  ],
  ONE: [
    'role=combobox',
    '[data-cy="booking-field-value"]',
  ],
  OOC: [
    'div.control-bar input',
  ],
};

/** Loose match of "we got redirected to a login page". */
const LOGIN_URL_PATTERN = /\/(login|signin|sign[-_]?in|auth\b|account\/login)/i;

export async function probeCarrierSession(
  carrierCode: string
): Promise<CarrierProbeResult> {
  const code = carrierCode.toUpperCase();
  const url = CARRIER_QUOTE_URLS[code];
  const checkedAt = new Date().toISOString();
  if (!url) {
    return {
      carrierCode: code,
      loggedIn: false,
      finalUrl: '',
      detail: 'unknown carrier code',
      ms: 0,
      checkedAt,
    };
  }

  const t0 = Date.now();
  let result: CarrierProbeResult = {
    carrierCode: code,
    loggedIn: false,
    finalUrl: '',
    detail: '',
    ms: 0,
    checkedAt,
  };

  let close: (() => Promise<void>) | null = null;
  let page = null;
  try {
    const ctx = await createBrowserContext({ useRealChrome: true });
    close = ctx.close;
    page = await ctx.context.newPage();

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    // Give the SPA a moment to render or redirect.
    await page.waitForTimeout(2500);
    const finalUrl = page.url();
    result.finalUrl = finalUrl;

    if (LOGIN_URL_PATTERN.test(finalUrl)) {
      result.detail = `redirected to login: ${finalUrl}`;
      result.loggedIn = false;
      return result;
    }

    // Try each selector hint; if any one matches in 4s, we're on the form.
    const hints = QUOTE_FORM_SELECTORS[code] ?? [];
    for (const sel of hints) {
      const found = await page
        .locator(sel)
        .first()
        .isVisible({ timeout: 4_000 })
        .catch(() => false);
      if (found) {
        result.loggedIn = true;
        result.detail = `form selector matched: ${sel}`;
        return result;
      }
    }

    // No selector matched and no login redirect — ambiguous, treat as
    // "needs attention" rather than logged in.
    result.loggedIn = false;
    result.detail = 'form not found and no login redirect — ambiguous';
    return result;
  } catch (err) {
    result.detail = `probe error: ${(err as Error).message.slice(0, 200)}`;
    result.loggedIn = false;
    return result;
  } finally {
    result.ms = Date.now() - t0;
    if (page) {
      await page.close().catch(() => undefined);
    }
    if (close) await close();
  }
}

// ---- Live state cache + scheduler ----

const cache = new Map<string, CarrierProbeResult>();

export function getCachedProbeResults(): CarrierProbeResult[] {
  return Array.from(cache.values()).sort((a, b) =>
    a.carrierCode.localeCompare(b.carrierCode)
  );
}

export function getCachedProbeResult(code: string): CarrierProbeResult | null {
  return cache.get(code.toUpperCase()) ?? null;
}

/**
 * Probe every known carrier sequentially. Sequential (not parallel)
 * because they all share the same Chrome instance via CDP and stepping
 * on each other can cause flakiness. Total runtime: ~15–25s for 6 carriers.
 */
export async function probeAllCarriers(): Promise<CarrierProbeResult[]> {
  const codes = Object.keys(CARRIER_QUOTE_URLS);
  const results: CarrierProbeResult[] = [];
  for (const code of codes) {
    try {
      const r = await probeCarrierSession(code);
      cache.set(code, r);
      results.push(r);
      console.log(
        `[sessionProbe] ${code}: ${r.loggedIn ? 'LOGGED IN' : 'LOGGED OUT'} (${r.ms}ms) — ${r.detail}`
      );
    } catch (err) {
      console.error(`[sessionProbe] ${code} fatal:`, err);
    }
  }
  return results;
}

let intervalHandle: NodeJS.Timeout | null = null;

/**
 * Start the background keep-alive loop. Probes every `intervalMs` ms
 * (default 10 min). Idempotent — safe to call multiple times.
 *
 * Runs an initial probe ~5s after startup so the dashboard has data
 * to show on first paint.
 */
export function startKeepAlivePinger(
  intervalMs: number = 10 * 60 * 1000
): void {
  if (intervalHandle) return;
  console.log(
    `[sessionProbe] keep-alive scheduler armed (every ${Math.round(intervalMs / 60000)} min)`
  );
  // First probe shortly after startup
  setTimeout(() => {
    void probeAllCarriers();
  }, 5_000);
  intervalHandle = setInterval(() => {
    void probeAllCarriers();
  }, intervalMs);
}

export function stopKeepAlivePinger(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
