# Freight Copilot Tampermonkey userscript

A single userscript that fills carrier quote forms automatically.
Runs INSIDE your browser (as part of the page) — not as external
Playwright automation. Bot detection has no way to know.

**Cost: $0 forever** (no LLM calls, just DOM interaction).

## Install (one click, auto-updates after that)

1. Install the **Tampermonkey** extension if you don't have it:
   - Chrome / Edge: <https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo>
   - Firefox: <https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/>

2. Click this link and Tampermonkey will detect the userscript and
   prompt you to install:

   <https://raw.githubusercontent.com/wtsaleksandr-lang/freight-copilot/main/tampermonkey/freight-copilot.user.js>

   Click **Install** in the prompt. Done.

3. Future updates flow automatically. Tampermonkey checks the GitHub
   raw URL every ~24 hours; you can also click the extension icon →
   "Check for userscript updates" to pull a new version on demand.

## Two ways to use it

### A) Manual — click the button on any carrier's quote page

1. Open the carrier's quote page (must be logged in):
   - https://www.mymsc.com/myMSC/instantquote
   - https://www.maersk.com/book/
   - https://www.hapag-lloyd.com/solutions/new-quote/#/simple?language=en
   - https://www.cma-cgm.com/ebusiness/pricing/instant-Quoting
   - https://ecomm.one-line.com/one-ecom/prices/one-quote-booking
   - https://freightsmart.oocl.com/ui/

2. Top-right of the page — green floating button "⚡ Freight Copilot — Auto-fill".
   Click it. A small prompt asks for origin / destination / container / weight.
   Fields are filled automatically.

3. Review the filled form. Click **Search Rates / Get Quote** yourself.

### B) Pre-filled URL — no prompt, fully automatic

Encode a lane as base64 JSON and append to the carrier URL hash. The
script reads it on load, no clicking through prompts.

Example for MSC, Charleston → Constanta, 40HC, 10000 kg:

```
https://www.mymsc.com/myMSC/instantquote#fc=eyJvcmlnaW4iOiJDaGFybGVzdG9uIiwib3JpZ2luQ29kZSI6IlVTQ0hTIiwiZGVzdGluYXRpb24iOiJDb25zdGFudGEiLCJkZXN0aW5hdGlvbkNvZGUiOiJST0NORCIsImNvbnRhaW5lciI6IjQwSEMiLCJ3ZWlnaHRLZyI6MTAwMDAsImNvbW1vZGl0eSI6IkdlbmVyYWwgY2FyZ28ifQ==
```

The lane payload before base64-encoding is:

```json
{
  "origin": "Charleston",
  "originCode": "USCHS",
  "destination": "Constanta",
  "destinationCode": "ROCND",
  "container": "40HC",
  "weightKg": 10000,
  "commodity": "General cargo"
}
```

The button on the page will say "⚡ Freight Copilot — Auto-fill" (green)
when a lane is in the URL. Click it — the form fills, no prompts.

A future dashboard button will generate these URLs for you, one per carrier,
opening 6 tabs at once.

## Container codes

The filler accepts these codes (case-insensitive):

| Code | Meaning |
|---|---|
| `20GP` | 20' general purpose / dry standard / 20DV |
| `40GP` | 40' general purpose / dry standard / 40DV |
| `40HC` | 40' high cube / 40HQ |
| `20RF` | 20' reefer |
| `40RF` | 40' reefer |
| `40RH` | 40' reefer high cube |

## Carrier status

| Carrier | Filler |
|---|---|
| **MSC** | ✅ implemented |
| Maersk | ⚠️ not yet wired |
| Hapag-Lloyd | ⚠️ not yet wired |
| CMA CGM | ⚠️ not yet wired |
| ONE Line | ⚠️ not yet wired |
| OOCL | ⚠️ not yet wired |

The button shows a clear "not implemented yet" message for unwired
carriers. Adding a new carrier = filling in one async function in
`freight-copilot.user.js` (per-carrier `FILLERS` map).

## Why it works when Playwright doesn't

| | Playwright (external) | This userscript (internal) |
|---|---|---|
| Where it runs | Outside the browser, via CDP | INSIDE the page as part of its own JS |
| Bot detection | Detectable | Can't detect — you ARE the user |
| Cookies / login | Needs Real Chrome trick | Uses your real session, just works |
| Selector fragility | High (DOM races, hydration) | Low (script runs after page settles) |
| Cost | $0 + $$$ for fallbacks | $0 forever |
| Tradeoff | Remote / fully automated | You click the button per-carrier |

## Debugging

In the carrier page's DevTools console:

```js
window.__freightCopilot           // current lane + helpers
window.__freightCopilot.lane      // the parsed lane object (or null)
window.__freightCopilot.runFiller() // trigger the filler manually
window.__freightCopilot.clearLane() // wipe stored lane from sessionStorage
```

The script logs each step to the console and shows status in the
floating panel. If a step fails, the error message points at what
went wrong.
