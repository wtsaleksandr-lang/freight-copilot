// ==UserScript==
// @name         Freight Copilot — MSC demo
// @namespace    https://github.com/wtsaleksandr-lang/freight-copilot
// @version      0.1.0
// @description  Minimal proof of the Tampermonkey approach: runs INSIDE the user's browser, not as external Playwright. Demonstrates that we can interact with elements that Playwright was failing to find on the same page.
// @match        https://www.mymsc.com/myMSC/instantquote*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // For the demo, hardcode the lane. In the real version this comes from
  // the dashboard via URL hash params or localStorage.
  const DEMO_LANE = {
    containerSize: '40HC', // try changing to 20DV or 40DV
  };

  // Floating button so we can trigger the demo manually after the page
  // has fully rendered (React-rendered SPAs need a beat).
  function injectButton() {
    const btn = document.createElement('button');
    btn.textContent = '⚡ Freight Copilot — find checkboxes';
    btn.style.cssText = [
      'position:fixed', 'top:12px', 'right:12px', 'z-index:999999',
      'background:#2ea043', 'color:white', 'border:0', 'border-radius:6px',
      'padding:10px 14px', 'font:600 13px system-ui', 'cursor:pointer',
      'box-shadow:0 4px 12px rgba(0,0,0,0.25)',
    ].join(';');
    btn.addEventListener('click', runDemo);
    document.body.appendChild(btn);

    const status = document.createElement('div');
    status.id = 'fc-status';
    status.style.cssText = [
      'position:fixed', 'top:54px', 'right:12px', 'z-index:999999',
      'background:#1a1a1a', 'color:white', 'padding:10px 14px',
      'border-radius:4px', 'font:12px system-ui', 'max-width:340px',
      'line-height:1.45', 'display:none',
    ].join(';');
    document.body.appendChild(status);
  }

  function setStatus(msg, color) {
    const el = document.getElementById('fc-status');
    el.style.display = 'block';
    el.style.background = color || '#1a1a1a';
    el.textContent = msg;
  }

  function runDemo() {
    // The exact query Playwright was failing on:
    //   page.locator('[data-test-id^="equipment-sizetype-input-"]')
    // Try it here too, plus a fallback by visible label text.
    const dataTestIdMatches = document.querySelectorAll(
      '[data-test-id^="equipment-sizetype-input-"]'
    );

    // Fallback: find <input type="checkbox"> whose nearby visible text
    // looks like a container size (20DV / 40HC / 40DV / 45HC etc.)
    const allCheckboxes = Array.from(
      document.querySelectorAll('input[type="checkbox"]')
    );
    const sizeCheckboxes = allCheckboxes
      .map((cb) => {
        const wrap = cb.closest('label') || cb.parentElement;
        const text = (wrap?.innerText || cb.getAttribute('aria-label') || '').trim();
        return { cb, text };
      })
      .filter((x) => /^(20|40|45)\s*(DV|GP|HC|HQ|RF|REEFER)/i.test(x.text));

    console.log('[Freight Copilot] data-test-id matches:', dataTestIdMatches.length);
    console.log('[Freight Copilot] visible-label matches:', sizeCheckboxes.length);
    console.log('[Freight Copilot] all checkbox labels:', allCheckboxes.map((cb) => {
      const wrap = cb.closest('label') || cb.parentElement;
      return (wrap?.innerText || cb.getAttribute('aria-label') || '').trim();
    }));

    if (sizeCheckboxes.length === 0) {
      setStatus(
        `No size checkboxes found. data-test-id matches: ${dataTestIdMatches.length}. ` +
          `Total checkboxes on page: ${allCheckboxes.length}. ` +
          'Page may not be ready — try again in 2 seconds.',
        '#d44a4a'
      );
      return;
    }

    const labels = sizeCheckboxes.map((x) => x.text).join(', ');
    setStatus(
      `Playwright finds: ${dataTestIdMatches.length} via data-test-id.\n\n` +
        `This script finds: ${sizeCheckboxes.length} via visible label.\n\n` +
        `Sizes: ${labels}\n\nClicking ${DEMO_LANE.containerSize}...`,
      '#2ea043'
    );

    const target = sizeCheckboxes.find((x) =>
      x.text.toUpperCase().includes(DEMO_LANE.containerSize.toUpperCase())
    );
    if (target) {
      target.cb.click();
      setTimeout(() => {
        setStatus(
          `✓ Clicked ${target.text}. Origin/destination/weight you can fill manually for now — this demo just proves we can find + interact with elements Playwright couldn't reach.`,
          '#2ea043'
        );
      }, 600);
    } else {
      setStatus(
        `Found ${sizeCheckboxes.length} sizes but none matched "${DEMO_LANE.containerSize}". Available: ${labels}`,
        '#d29922'
      );
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectButton);
  } else {
    injectButton();
  }
})();
