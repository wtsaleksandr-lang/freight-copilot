// ==UserScript==
// @name         Freight Copilot — auto-fill carrier quote forms
// @namespace    https://github.com/wtsaleksandr-lang/freight-copilot
// @version      0.2.0
// @description  Fills MSC, Maersk, CMA CGM, Hapag-Lloyd, ONE, OOCL quote forms from URL hash params (or a small manual prompt). Runs INSIDE your browser as a userscript — no external automation, no bot detection.
// @author       Freight Copilot
// @match        https://www.mymsc.com/myMSC/instantquote*
// @match        https://www.maersk.com/book/*
// @match        https://www.maersk.com/book*
// @match        https://www.hapag-lloyd.com/solutions/new-quote/*
// @match        https://www.cma-cgm.com/ebusiness/pricing/instant-Quoting*
// @match        https://ecomm.one-line.com/one-ecom/prices/one-quote-booking*
// @match        https://freightsmart.oocl.com/ui/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/wtsaleksandr-lang/freight-copilot/main/tampermonkey/freight-copilot.user.js
// @downloadURL  https://raw.githubusercontent.com/wtsaleksandr-lang/freight-copilot/main/tampermonkey/freight-copilot.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────
  // Lane payload (passed via URL hash, persisted to sessionStorage so SPA
  // rewrites don't lose it).
  //
  // Hash format:  #fc=<base64-encoded JSON>
  //   {
  //     "origin": "Charleston",          // city / port name as user types
  //     "originCode": "USCHS",           // optional UN/LOCODE
  //     "destination": "Constanta",
  //     "destinationCode": "ROCND",
  //     "container": "40HC",             // 20GP / 40HC / 40GP / 20RF / 40RF / 40RH / 40NOR
  //     "weightKg": 10000,
  //     "commodity": "General cargo"     // optional
  //   }
  // ─────────────────────────────────────────────────────────────────────────

  const SESSION_KEY = 'fc_pending_lane';

  function readLane() {
    // First try the URL hash (fresh navigation), then sessionStorage (SPA route changes).
    const m = location.hash.match(/[#&]fc=([^&]+)/);
    if (m) {
      try {
        const json = JSON.parse(atob(decodeURIComponent(m[1])));
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(json));
        return json;
      } catch (err) {
        console.warn('[FC] hash parse failed:', err);
      }
    }
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch {
        return null;
      }
    }
    return null;
  }

  function clearLane() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers shared across fillers
  // ─────────────────────────────────────────────────────────────────────────

  /** Wait until `query()` returns a truthy element (or timeout). */
  function waitFor(query, timeoutMs = 15000, intervalMs = 200) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        try {
          const el = query();
          if (el) return resolve(el);
        } catch {
          /* keep polling */
        }
        if (Date.now() - start > timeoutMs) {
          return reject(new Error('waitFor timeout'));
        }
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  /** Find an `<input>` whose nearest visible label/placeholder text matches. */
  function findInputByLabel(labelRegex) {
    const inputs = document.querySelectorAll('input, textarea, select');
    for (const inp of inputs) {
      // 1. placeholder
      if (inp.placeholder && labelRegex.test(inp.placeholder)) return inp;
      // 2. aria-label
      const aria = inp.getAttribute('aria-label');
      if (aria && labelRegex.test(aria)) return inp;
      // 3. associated <label>
      if (inp.id) {
        const lab = document.querySelector(`label[for="${inp.id}"]`);
        if (lab && labelRegex.test(lab.innerText)) return inp;
      }
      // 4. parent label
      const parentLabel = inp.closest('label');
      if (parentLabel && labelRegex.test(parentLabel.innerText)) return inp;
    }
    return null;
  }

  /** Type into an input the way a real user does (so framework state updates fire). */
  function setInputValue(input, value) {
    const proto =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UI — floating button + status toast
  // ─────────────────────────────────────────────────────────────────────────

  function injectUI(lane) {
    const wrap = document.createElement('div');
    wrap.id = 'fc-ui';
    wrap.style.cssText = [
      'position:fixed', 'top:12px', 'right:12px', 'z-index:2147483647',
      'display:flex', 'flex-direction:column', 'gap:8px',
      'font:13px system-ui, -apple-system, sans-serif',
    ].join(';');

    const btn = document.createElement('button');
    btn.id = 'fc-fill-btn';
    btn.textContent = lane
      ? '⚡ Freight Copilot — Auto-fill'
      : '⚡ Freight Copilot (no lane in URL)';
    btn.style.cssText = [
      'background:#2ea043', 'color:white', 'border:0', 'border-radius:6px',
      'padding:10px 14px', 'font-weight:600', 'cursor:pointer',
      'box-shadow:0 4px 12px rgba(0,0,0,0.25)',
    ].join(';');
    if (!lane) {
      btn.style.background = '#888';
      btn.title = 'Open this URL with #fc=... or click to enter a lane manually';
    }
    wrap.appendChild(btn);

    const status = document.createElement('div');
    status.id = 'fc-status';
    status.style.cssText = [
      'background:rgba(0,0,0,0.85)', 'color:white', 'padding:8px 12px',
      'border-radius:4px', 'max-width:340px', 'line-height:1.45',
      'display:none', 'white-space:pre-line',
    ].join(';');
    wrap.appendChild(status);

    document.body.appendChild(wrap);

    btn.addEventListener('click', async () => {
      const useLane = lane || promptForLane();
      if (!useLane) return;
      btn.disabled = true;
      try {
        await runFiller(useLane, setStatus);
      } catch (err) {
        setStatus('Fill failed: ' + err.message, '#d44a4a');
      } finally {
        btn.disabled = false;
      }
    });
  }

  function setStatus(msg, bg) {
    const el = document.getElementById('fc-status');
    if (!el) return;
    el.style.display = 'block';
    el.style.background = bg || 'rgba(0,0,0,0.85)';
    el.textContent = msg;
  }

  function promptForLane() {
    const origin = prompt('Origin (city or LOCODE):');
    if (!origin) return null;
    const destination = prompt('Destination (city or LOCODE):');
    if (!destination) return null;
    const container = prompt('Container (20GP / 40GP / 40HC):', '40HC');
    if (!container) return null;
    const weightKg = parseInt(prompt('Weight per container (kg):', '10000'), 10);
    const commodity = prompt('Commodity (optional):', 'General cargo') || '';
    return { origin, destination, container, weightKg, commodity };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Carrier router
  // ─────────────────────────────────────────────────────────────────────────

  function carrierKey() {
    const h = location.hostname;
    if (h.includes('mymsc.com')) return 'msc';
    if (h.includes('maersk.com')) return 'msk';
    if (h.includes('hapag-lloyd.com')) return 'hlc';
    if (h.includes('cma-cgm.com')) return 'cma';
    if (h.includes('one-line.com')) return 'one';
    if (h.includes('freightsmart.oocl.com')) return 'ooc';
    return null;
  }

  async function runFiller(lane, status) {
    const key = carrierKey();
    if (!key) {
      status('Unsupported page — userscript matched but no filler defined.');
      return;
    }
    const fn = FILLERS[key];
    if (!fn) {
      status(`No filler implemented for ${key.toUpperCase()} yet — use the manual recording for now.`);
      return;
    }
    status(`Filling ${key.toUpperCase()}…`);
    await fn(lane, status);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Per-carrier fillers
  // ─────────────────────────────────────────────────────────────────────────

  const FILLERS = {
    // ─── MSC ───────────────────────────────────────────────────────────────
    async msc(lane, status) {
      // 1) Container size — find checkbox whose label contains the requested
      //    code (20GP/20DV, 40GP/40DV, 40HC).
      const sizeAliases = {
        '20GP': /^20'?\s*(GP|DV|STD|STANDARD|DRY)\b/i,
        '40GP': /^40'?\s*(GP|DV|STD|STANDARD|DRY)$/i,
        '40HC': /^40'?\s*(HC|HQ|HIGH)\b/i,
        '20RF': /^20'?\s*(RF|REEFER)\b/i,
        '40RF': /^40'?\s*(RF|REEFER)\b/i,
        '40RH': /^40'?\s*(RH|REEFER\s*HC)\b/i,
      };
      const sizeRegex = sizeAliases[String(lane.container).toUpperCase()];
      if (!sizeRegex) {
        throw new Error('Unknown container code: ' + lane.container);
      }
      status('Selecting container size…');
      const cbs = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      let picked = null;
      for (const cb of cbs) {
        const lab = cb.closest('label') || cb.parentElement;
        const text = (lab?.innerText || cb.getAttribute('aria-label') || '').trim();
        if (sizeRegex.test(text)) {
          if (!cb.checked) cb.click();
          picked = text;
          break;
        }
      }
      if (!picked) throw new Error('No size checkbox matched ' + lane.container);

      // 2) Weight — find input whose label/placeholder contains "weight".
      status('Setting weight…');
      const weightInput = findInputByLabel(/weight/i);
      if (weightInput) {
        weightInput.focus();
        setInputValue(weightInput, String(lane.weightKg ?? 10000));
      }

      // 3) Origin — the "Select Start Point" anchor opens an autocomplete.
      //    MSC's origin/destination flow uses a popup; click the field, type,
      //    pick first option containing the typed value.
      status('Filling origin…');
      const startAnchor =
        document.querySelector('[data-test-id="originDropDown"]') ||
        findInputByLabel(/start|origin|por|loading/i);
      if (startAnchor) {
        startAnchor.click();
        await sleep(400);
        const originInput = await waitFor(
          () =>
            document.querySelector('#origin') ||
            findInputByLabel(/start|origin|por/i),
          5000
        ).catch(() => null);
        if (originInput) {
          setInputValue(originInput, lane.origin);
          await sleep(900);
          const opt =
            document.querySelector('#origin-option-0') ||
            document.querySelector('[id^="origin-option-"]');
          if (opt) opt.click();
          else {
            // fallback: pick by text in dropdown
            const wanted = (lane.origin || '').toLowerCase();
            const dropOpts = Array.from(
              document.querySelectorAll('[role="option"], li')
            );
            const hit = dropOpts.find((el) =>
              el.innerText && el.innerText.toLowerCase().includes(wanted)
            );
            hit?.click();
          }
        }
      }
      await sleep(700);

      // 4) Destination
      status('Filling destination…');
      const endAnchor =
        document.querySelector('[data-test-id="destinationDropDown"]') ||
        findInputByLabel(/end|destination|pod|discharge/i);
      if (endAnchor) {
        endAnchor.click();
        await sleep(400);
        const destInput = await waitFor(
          () =>
            document.querySelector('#destination') ||
            findInputByLabel(/end|destination|pod/i),
          5000
        ).catch(() => null);
        if (destInput) {
          setInputValue(destInput, lane.destination);
          await sleep(900);
          const opt =
            document.querySelector('#destination-option-0') ||
            document.querySelector('[id^="destination-option-"]');
          if (opt) opt.click();
          else {
            const wanted = (lane.destination || '').toLowerCase();
            const dropOpts = Array.from(
              document.querySelectorAll('[role="option"], li')
            );
            const hit = dropOpts.find((el) =>
              el.innerText && el.innerText.toLowerCase().includes(wanted)
            );
            hit?.click();
          }
        }
      }
      await sleep(500);

      // 5) Optional commodity
      if (lane.commodity) {
        status('Filling commodity…');
        const commodityInput = findInputByLabel(/commodity|hs\s*code/i);
        if (commodityInput) {
          commodityInput.focus();
          setInputValue(commodityInput, lane.commodity);
        }
      }

      status(
        'Done — review the form and click Search Rates yourself.\n\nLane: ' +
          `${lane.origin} → ${lane.destination}, ${lane.container}, ${lane.weightKg}kg`,
        '#2ea043'
      );
    },

    // ─── Maersk (TODO) ────────────────────────────────────────────────────
    async msk(_lane, status) {
      status(
        'Maersk filler not implemented yet — use the existing Playwright path or DevTools Recorder for now.\n\n' +
          'Once we record a clean session, this script will fill the From / To / commodity / container / weight automatically.'
      );
    },

    // ─── Hapag-Lloyd (TODO) ───────────────────────────────────────────────
    async hlc(_lane, status) {
      status('Hapag-Lloyd filler not implemented yet.');
    },

    // ─── CMA CGM (TODO) ───────────────────────────────────────────────────
    async cma(_lane, status) {
      status('CMA CGM filler not implemented yet.');
    },

    // ─── ONE Line (TODO) ──────────────────────────────────────────────────
    async one(_lane, status) {
      status('ONE Line filler not implemented yet.');
    },

    // ─── OOCL (TODO) ──────────────────────────────────────────────────────
    async ooc(_lane, status) {
      status('OOCL filler not implemented yet.');
    },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Boot
  // ─────────────────────────────────────────────────────────────────────────

  const lane = readLane();
  injectUI(lane);

  // Expose for debugging in DevTools console
  window.__freightCopilot = {
    lane,
    runFiller: () => lane && runFiller(lane, console.log),
    clearLane,
  };
})();
