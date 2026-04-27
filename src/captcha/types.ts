/**
 * A carrier's bot defense (Cloudflare Turnstile, GeeTest slider, hCaptcha,
 * reCAPTCHA, custom in-house) blocked us. Caller decides what to do —
 * typically: mark the carrier as captcha_blocked in the bundle, skip it,
 * keep going with other carriers.
 */
export class CaptchaBlockedError extends Error {
  readonly kind: 'captcha';
  readonly captchaType: CaptchaType;
  readonly url: string;

  constructor(captchaType: CaptchaType, url: string, message?: string) {
    super(message ?? `Captcha blocked (${captchaType}) at ${url}`);
    this.name = 'CaptchaBlockedError';
    this.kind = 'captcha';
    this.captchaType = captchaType;
    this.url = url;
  }
}

export type CaptchaType =
  | 'cloudflare_turnstile'
  | 'cloudflare_challenge'
  | 'geetest_slider'
  | 'hcaptcha'
  | 'recaptcha'
  | 'unknown';

export interface CaptchaSignal {
  type: CaptchaType;
  /** Human-readable description of what we detected. */
  evidence: string;
}
