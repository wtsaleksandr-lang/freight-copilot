/**
 * Captcha solver service interface.
 *
 * V1 ships a stub. When you're ready to plug in a paid solver (2Captcha,
 * CapSolver, AntiCaptcha, etc.), implement this interface and select it
 * via env CAPTCHA_SOLVER_PROVIDER + CAPTCHA_SOLVER_API_KEY.
 *
 * Why we kept it abstract: each provider has slightly different APIs
 * (reCAPTCHA vs Turnstile vs GeeTest take different inputs). The adapter
 * pattern keeps the rest of the app honest about cost and failure modes.
 */
import type { Page } from 'playwright';
import type { CaptchaType } from './types.js';

export interface CaptchaSolveRequest {
  type: CaptchaType;
  pageUrl: string;
  /** Cloudflare Turnstile / hCaptcha / reCAPTCHA: the public site key. */
  siteKey?: string;
  /** GeeTest: the gt + challenge values. */
  geetestParams?: { gt: string; challenge: string };
}

export interface CaptchaSolveResult {
  /** The token / response value to inject into the page. */
  token: string;
  /** Provider's request id (for cost tracking / retry). */
  providerRequestId?: string;
  /** USD cost reported by the provider, if any. */
  costUsd?: number;
}

export interface CaptchaSolverProvider {
  readonly name: string;
  solve(req: CaptchaSolveRequest): Promise<CaptchaSolveResult>;
  /** Inject the solved token into the page so the form can be submitted. */
  applyToken(page: Page, req: CaptchaSolveRequest, token: string): Promise<void>;
}

/**
 * Returns the configured solver provider, or null if no solver is set up.
 * V1: always returns null; placeholder for the env-driven selection that
 * a follow-up will add (after you pick a provider + add the API key).
 */
export function getSolver(): CaptchaSolverProvider | null {
  // TODO: read process.env.CAPTCHA_SOLVER_PROVIDER and dispatch:
  //   case 'twocaptcha':  return new TwoCaptchaSolver(env.CAPTCHA_SOLVER_API_KEY);
  //   case 'capsolver':   return new CapSolverProvider(env.CAPTCHA_SOLVER_API_KEY);
  //   case 'anticaptcha': return new AntiCaptchaSolver(env.CAPTCHA_SOLVER_API_KEY);
  return null;
}
