import type { Page } from 'playwright';
import type { CaptchaSignal, CaptchaType } from './types.js';

/**
 * Look for tell-tale signs of a captcha challenge on the current page.
 * Returns the first match, or null if the page looks clean.
 *
 * Detection rules — prefer specific iframes/elements first, fall back to
 * page text. We deliberately avoid false-positives on legitimate "I am the
 * price owner" radios etc.
 */
export async function detectCaptcha(page: Page): Promise<CaptchaSignal | null> {
  const url = page.url();

  // 1. Cloudflare Turnstile (Hapag-Lloyd's blocker).
  //    Iframe src includes challenges.cloudflare.com.
  const turnstile = await page
    .locator('iframe[src*="challenges.cloudflare.com"]')
    .count()
    .catch(() => 0);
  if (turnstile > 0) {
    return {
      type: 'cloudflare_turnstile',
      evidence: `Found Cloudflare Turnstile iframe at ${url}`,
    };
  }

  // 2. Generic Cloudflare challenge page (text + URL pattern).
  if (url.includes('cdn-cgi/challenge') || url.includes('__cf_chl_')) {
    return {
      type: 'cloudflare_challenge',
      evidence: `URL contains Cloudflare challenge marker (${url})`,
    };
  }

  // 3. GeeTest slider (CMA CGM's blocker).
  const geetest = await page
    .locator(
      '.geetest_slider, .geetest_radar_btn, [class*="geetest"]'
    )
    .first()
    .isVisible()
    .catch(() => false);
  if (geetest) {
    return { type: 'geetest_slider', evidence: 'Found .geetest_* element' };
  }

  // 4. hCaptcha.
  const hcaptcha = await page
    .locator('iframe[src*="hcaptcha.com"]')
    .count()
    .catch(() => 0);
  if (hcaptcha > 0) {
    return { type: 'hcaptcha', evidence: 'Found hCaptcha iframe' };
  }

  // 5. reCAPTCHA.
  const recaptcha = await page
    .locator('iframe[src*="google.com/recaptcha"]')
    .count()
    .catch(() => 0);
  if (recaptcha > 0) {
    return { type: 'recaptcha', evidence: 'Found reCAPTCHA iframe' };
  }

  // 6. Generic visible-text fallback. Match phrases unique enough to NOT
  //    appear on legitimate pages (e.g. "I am the price owner" on Maersk
  //    is fine — but "Click on the thing capable of being folded" is not).
  const TEXT_PATTERNS: Array<[RegExp, CaptchaType]> = [
    [/click on the thing capable of being folded/i, 'unknown'],
    [/please verify you are human/i, 'unknown'],
    [/checking if the site connection is secure/i, 'cloudflare_challenge'],
    [/please complete the security check/i, 'unknown'],
    [/我不是机器人/i, 'unknown'], // "I am not a robot" (zh)
  ];
  for (const [pat, type] of TEXT_PATTERNS) {
    const found = await page
      .getByText(pat)
      .first()
      .isVisible()
      .catch(() => false);
    if (found) return { type, evidence: `Matched text pattern: ${pat.source}` };
  }

  return null;
}
