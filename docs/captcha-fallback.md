# Captcha behavior

## What changed

Before: when a carrier portal served a captcha, our fetch waited up to 5 minutes hoping you'd solve it manually. If you weren't watching, the entire bundle stalled.

Now:
1. The fetch detects the captcha within ~12 seconds.
2. It throws a `CaptchaBlockedError` with the captcha type (Cloudflare Turnstile, GeeTest slider, hCaptcha, reCAPTCHA, generic Cloudflare, or unknown).
3. The bundle runner catches that error and marks the carrier as `captcha_blocked` — **without killing the bundle**.
4. Other selected carriers in the same bundle keep running.
5. The dashboard shows that carrier with a yellow `captcha (cloudflare_turnstile)` badge so you know to refresh that one manually next time.
6. The generated client email only references carriers that returned rates.

## What it detects

| Pattern | Recognized as |
|---|---|
| `<iframe src="https://challenges.cloudflare.com/...">` | `cloudflare_turnstile` |
| URL contains `cdn-cgi/challenge` or `__cf_chl_` | `cloudflare_challenge` |
| Element matching `.geetest_slider`, `.geetest_radar_btn`, `[class*="geetest"]` | `geetest_slider` |
| `<iframe src="*hcaptcha.com*">` | `hcaptcha` |
| `<iframe src="*google.com/recaptcha*">` | `recaptcha` |
| Visible text "Click on the thing capable of being folded" / "verify you are human" / "checking if the site connection is secure" | `unknown` (or specific) |

Source: `src/captcha/detect.ts`. Add new patterns there as new carriers reveal themselves.

## What still works

- **Real-Chrome (CDP) mode** still bypasses most captchas because it runs in your real Chrome with cookies, no `webdriver` flag, real fingerprint. Keep `USE_REAL_CHROME=true` whenever possible.
- **Manual solve** still works in headed mode — just in a shorter window (90 seconds instead of 5 minutes). If you're sitting at the PC and want to solve it, do it within that window and the script continues.
- **Other carriers in the bundle** continue normally. You don't lose the whole quote because one portal got cranky.

## Adding a captcha solver service (when you're ready)

`src/captcha/solver.ts` defines a `CaptchaSolverProvider` interface and a `getSolver()` function that currently returns `null` (no solver). To plug in a paid solver:

1. Pick a provider:
   - **2Captcha** — most popular, ~$0.001–$0.003 per solve, supports almost everything
   - **CapSolver** — competitive pricing, good API
   - **AntiCaptcha** — older, broad support
2. Sign up, fund the account, get an API key.
3. Add to `.env`:
   ```
   CAPTCHA_SOLVER_PROVIDER=twocaptcha
   CAPTCHA_SOLVER_API_KEY=your-key-here
   ```
4. Implement the provider class against the `CaptchaSolverProvider` interface.
5. Wire it into `getSolver()` so it's returned when env is configured.
6. The detection path in `fetchRates.ts` already calls `getSolver()` — once a solver is returned, you can replace the current "fail over" branch with `solver.solve(...)` then `solver.applyToken(...)`.

Cost expectations: 1–3 captchas per quote × ~$0.002 = pennies per quote, on top of the ~$0.01 Anthropic cost. Negligible for personal use; visible if you scale.

## What to do RIGHT NOW (no solver)

- Run with `USE_REAL_CHROME=true` whenever possible — this is the most reliable bypass.
- If a carrier shows as `captcha_blocked` in your bundle results, just re-run that carrier alone after waiting a few minutes (Maersk often relaxes its bot scoring after a brief cool-down).
- If a specific carrier always blocks, **record the workflow once** in your real Chrome (Record tab) and we'll refine the adapter to navigate around the captcha-prone path.
