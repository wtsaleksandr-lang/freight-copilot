import { chromium, type BrowserContext } from 'playwright';
import { loadEnv } from '../config.js';

export interface CreateContextResult {
  context: BrowserContext;
  /** Call when done. In real-Chrome mode this only closes the page; the user's
   * Chrome stays open. In bundled mode this closes the whole Playwright browser. */
  close: () => Promise<void>;
  /** True when we're connected to the user's real Chrome over CDP (no fingerprint, no captchas). */
  usingRealChrome: boolean;
}

/**
 * Create a Playwright BrowserContext, choosing between:
 *
 * 1. Real Chrome over CDP (USE_REAL_CHROME=true) — connects to a Chrome
 *    instance the user already launched with --remote-debugging-port=9222.
 *    All operations happen in their actual Chrome: real fingerprint,
 *    real cookies, no `webdriver` flag. Bot detection mostly leaves us alone.
 *
 * 2. Bundled Chromium (default) — Playwright launches its own Chromium.
 *    Faster, isolated, but easier for sites to detect.
 */
export async function createBrowserContext(opts: {
  /** Pre-saved storageState. Only used in bundled mode. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  storageState?: any;
  /** Override env var explicitly. */
  useRealChrome?: boolean;
} = {}): Promise<CreateContextResult> {
  const env = loadEnv();
  const useReal =
    opts.useRealChrome ?? env.USE_REAL_CHROME;

  if (useReal) {
    let browser;
    try {
      browser = await chromium.connectOverCDP('http://localhost:9222');
    } catch (err) {
      throw new Error(
        'USE_REAL_CHROME is set, but no Chrome is listening on port 9222.\n' +
          'Launch the "Chrome (Freight Copilot)" desktop shortcut first ' +
          '(it runs Chrome with --remote-debugging-port=9222 against a dedicated profile).\n' +
          `Original error: ${(err as Error).message}`
      );
    }
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      throw new Error(
        'Connected to Chrome but it has no open contexts. Open a Chrome window first.'
      );
    }
    const context = contexts[0]!;
    return {
      context,
      usingRealChrome: true,
      close: async () => {
        // For CDP-connected browsers, browser.close() disconnects the
        // websocket — it does NOT close the user's Chrome process. Failing
        // to call this leaks CDP connections; with a 5-min keep-alive
        // pinger × 6 carriers we accumulated ~72 connections/hour and
        // OOM-crashed Node after ~3 hours of uptime.
        await browser.close().catch(() => undefined);
      },
    };
  }

  // Bundled-Chromium path (existing behavior)
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext(
    opts.storageState ? { storageState: opts.storageState } : undefined
  );
  return {
    context,
    usingRealChrome: false,
    close: async () => {
      await browser.close();
    },
  };
}
