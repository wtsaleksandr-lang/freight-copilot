# Tampermonkey demo

Quick proof-of-concept of the in-browser-script approach. Userscripts run
INSIDE the page (as part of the website's own JavaScript), not as
external Playwright automation. Bot detection has no way to know.

## Install

1. Install the Tampermonkey extension in your browser:
   - Chrome: <https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo>
   - Edge / Firefox: search "Tampermonkey" in the extensions store
2. Click the Tampermonkey icon → **Create a new script**.
3. Delete the placeholder template, paste the contents of `msc-demo.user.js`,
   then `File → Save` (or Ctrl+S). Tampermonkey reads the `// @match` line
   and only runs it on URLs that match.

## Try it

1. Make sure you're logged into MSC (any browser, any session).
2. Open <https://www.mymsc.com/myMSC/instantquote>.
3. After the page renders, you'll see a green floating button in the
   top-right: **⚡ Freight Copilot — find checkboxes**.
4. Click it.

The status panel will show:
- How many elements the old `data-test-id^="equipment-sizetype-input-"`
  selector finds (Playwright's failing query — likely 0 on the new portal).
- How many it finds via visible-label match (likely 3-6).
- The labels it found.
- Whether it could click the demo's target size (`40HC` by default).

## Why this is the proof point

Playwright (external automation) couldn't find these checkboxes — that's
why the bundle kept failing on MSC. This script, running on the same page,
WILL find them, because:

- It runs after React has rendered the form
- It uses standard DOM queries inside the page, not CDP-mediated
- The page can't tell automation from the user

If this works, the path forward is: extend the script to fill in
origin/destination/weight from the dashboard's lane (passed via URL hash
or `localStorage`), click submit, scrape the result, and POST it back to
`http://localhost:3000/api/...` for the dashboard to display. No more
selector cat-and-mouse, no more bot detection, no more keep-alive pinger.

## Cost

$0. Forever. No tokens, no LLM, no external service.
