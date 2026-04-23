# Onboarding a new carrier

Freight Copilot V1 supports Maersk (MSK) actively, and has stubs for MSC, CMA CGM (CMA), Hapag-Lloyd (HLC), ONE Line (ONE), OOCL (OOC), and ZIM (ZIM). Each stub's `fetchRates` throws until onboarded.

## Why onboarding requires a human step

Every carrier portal is different:

- Different login URL + auth flow
- Different rate-request form (field names, validation order, which options are visible)
- Different results-page layout (rate cards, breakdown tables, D&D info)
- Different anti-bot defenses

Writing carrier code without seeing the real portal produces hallucinated selectors that fail on first run. **So onboarding always starts with you walking Claude through the real thing once.**

## What you provide (one session, ~30–45 min)

1. **Login URL** — the exact URL you visit to log into the portal.
2. **Rate search URL** — after logging in, where you start a quote. (For Maersk this is `https://www.maersk.com/book/`.)
3. **Screenshots of each step of the rate request form** — which field is which, what's a dropdown vs autocomplete vs radio, what's the default state.
4. **Screenshot of a results page** showing several rate options.
5. **Results page saved as HTML** — right-click → "Save As" → "Webpage, HTML Only" → save into `samples/<code>/` (e.g., `samples/msc/`).
6. **Written walkthrough** — a few lines describing the flow in your own words. For Maersk, the walkthrough was: *"After login: click Prices → Maersk Spot → Instant prices; fill location/container/weight/commodity/price-owner/date; click Continue to book; on the sailings page, click each sailing's Price breakdown & details to see freight charges."*

## What Claude does (after you provide the above)

1. Writes `src/carriers/<code>/selectors.ts` — stable URLs + accessibility-labelled form fields.
2. Writes `src/carriers/<code>/fetchRates.ts` — adapts Maersk's Playwright pattern to this carrier's specific form.
3. Writes `src/carriers/<code>/prompts.ts` (or updates shared parse prompt) — each carrier presents rate cards differently, so Claude needs a per-carrier prompt to extract headline price, transit, vessel, rollable flag, etc.
4. Flips `isActive = true` in the carrier's `index.ts`.
5. Runs a live test quote. Iterates until clean ranked rates come back.
6. Commits + pushes to GitHub.

## First step for any carrier (works right now, no onboarding needed)

The generic login works today. Run:

```
pnpm dev carrier login <CODE>       # e.g., pnpm dev carrier login MSC
```

This opens the carrier's home page in a real Chromium window. You log in manually (including any 2FA / captcha). Session cookies are captured and saved to the local DB. The session is then reused for `fetchRates` calls — so once onboarding is done, you won't need to log in again for ~7 days.

## Carriers currently in the registry

| Code | Name         | Home URL (best guess, verify during onboarding)                     | Status                  |
|------|--------------|---------------------------------------------------------------------|-------------------------|
| MSK  | Maersk       | https://www.maersk.com/                                             | **active**              |
| MSC  | MSC          | https://www.msc.com/                                                | onboarding pending      |
| CMA  | CMA CGM      | https://www.cma-cgm.com/ebusiness                                   | onboarding pending      |
| HLC  | Hapag-Lloyd  | https://www.hapag-lloyd.com/en/online-business.html                 | onboarding pending      |
| ONE  | ONE Line    | https://ecomm.one-line.com/                                         | onboarding pending      |
| OOC  | OOCL         | https://www.oocl.com/eng/Pages/default.aspx                         | onboarding pending      |
| ZIM  | ZIM          | https://www.zim.com/                                                | onboarding pending      |

If a URL is wrong, fix it in `src/carriers/<code>/index.ts` as the first step of that carrier's onboarding.

## What the dashboard shows

All seven carriers appear in the "Carrier" dropdown on the New Quote tab. Inactive ones are disabled (greyed out) with "onboarding pending" next to their name. The "Get rates" button will refuse with a clear error if you somehow select an inactive carrier.

## Order of onboarding (suggestion)

Onboard the carriers you use most first. Typical priority for forwarders with mixed lanes:

1. The one with the highest quote volume after Maersk (often MSC or Hapag)
2. The one with the best API-free portal (Hapag Quick Quotes is relatively clean)
3. Remaining carriers as needed

Each onboarding is self-contained — we can do them in any order.
