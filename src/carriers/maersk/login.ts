import { genericLogin } from '../genericLogin.js';
import { MAERSK_URLS } from './selectors.js';

/**
 * Maersk login uses the generic headed-login helper. No Maersk-specific quirks
 * in the login step itself — the user types the password + handles 2FA/captcha
 * themselves in the visible browser window.
 */
export async function maerskLogin(): Promise<void> {
  return genericLogin({
    carrierCode: 'MSK',
    carrierName: 'Maersk',
    homeUrl: MAERSK_URLS.home,
  });
}
