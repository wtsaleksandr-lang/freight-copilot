(function installProgressiveDisclosure() {
  'use strict';

  // NOTE: the rate-library card (#dr-lib-dropzone) is intentionally NOT hidden
  // here. It is the "Save rates to your library" surface — owners could not
  // find it while it was display:none behind the import workflow. It now stays
  // first-class/visible on the Drayage tab. #dr-ingest-card (a secondary
  // reviewer-importer) still follows the import workflow toggle.
  const importSelectors = {
    drayage: ['#dr-ingest-card'],
    trucking: ['#tr-ingest-card'],
  };

  function cardFor(selector) {
    const target = document.querySelector(selector);
    return target?.classList.contains('card') ? target : target?.closest('.card');
  }

  function setHidden(element, hidden) {
    if (!element) return;
    element.classList.toggle('workflow-hidden', hidden);
    element.setAttribute('aria-hidden', String(hidden));
  }

  // ─── Per-card fold state ──────────────────────────────────────────────
  // Each shipment tool card below the board can be independently folded.
  // Open/closed state persists across reloads in localStorage. Defaults keep
  // the everyday cards (containers/follow-ups + update) open and collapse the
  // occasional ones (report + email) to keep the page compact.
  const PANELS_KEY = 'freight.shipments.panels';
  const SHIP_PANELS = [
    { id: 'shipment-operations-card', key: 'operations', open: true },
    { id: 'shipment-report-card', key: 'report', open: false },
    { id: 'shipment-email-card', key: 'email', open: false },
    { id: 'shipment-update-card', key: 'update', open: true },
  ];

  function readPanels() {
    try { return JSON.parse(localStorage.getItem(PANELS_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function writePanel(key, open) {
    try {
      const state = readPanels();
      state[key] = open;
      localStorage.setItem(PANELS_KEY, JSON.stringify(state));
    } catch (_) { /* localStorage unavailable — fold still works in-session */ }
  }

  function setCardOpen(card, open) {
    card.classList.toggle('ship-collapsed', !open);
    const chev = card.querySelector(':scope > .ship-fold-head > .ship-fold-chev');
    if (chev) chev.setAttribute('aria-expanded', String(open));
  }

  function expandCard(card) {
    if (card && card.classList.contains('ship-foldable') && card.classList.contains('ship-collapsed')) {
      setCardOpen(card, true);
      writePanel(card.dataset.foldKey, true);
    }
  }

  function makeCardFoldable(card, key, defaultOpen) {
    if (!card || card.dataset.foldKey) return;
    card.dataset.foldKey = key;
    card.classList.add('ship-foldable');

    // Locate (or synthesize) the header row that holds the title + chevron and
    // acts as the click target. Report/email/operations cards already open with
    // a `.card-header`; the update card opens with a bare <h2>.
    let head = card.querySelector(':scope > .card-header');
    if (!head) {
      const h2 = card.querySelector(':scope > h2');
      head = document.createElement('div');
      head.className = 'card-header';
      if (h2) { card.insertBefore(head, h2); head.appendChild(h2); }
      else { card.insertBefore(head, card.firstChild); }
    }
    head.classList.add('ship-fold-head');

    const chev = document.createElement('button');
    chev.type = 'button';
    chev.className = 'ship-fold-chev';
    chev.setAttribute('aria-label', 'Toggle section');
    chev.innerHTML = '<span aria-hidden="true">▸</span>';
    head.insertBefore(chev, head.firstChild);

    const saved = readPanels();
    const open = Object.prototype.hasOwnProperty.call(saved, key) ? !!saved[key] : defaultOpen;
    setCardOpen(card, open);

    function toggle() {
      const nextOpen = card.classList.contains('ship-collapsed');
      setCardOpen(card, nextOpen);
      writePanel(key, nextOpen);
    }
    chev.addEventListener('click', (event) => { event.stopPropagation(); toggle(); });
    head.addEventListener('click', (event) => {
      if (event.target.closest('button, a, input, select, textarea, label')) return;
      toggle();
    });
  }

  function applyWorkflow(kind, tab) {
    if (tab === 'drayage' || tab === 'trucking') {
      for (const selector of importSelectors[tab]) setHidden(cardFor(selector), kind !== 'import');
    }
  }

  function showAll() {
    document.querySelectorAll('.workflow-hidden').forEach((element) => {
      element.classList.remove('workflow-hidden');
      element.removeAttribute('aria-hidden');
    });
    document.getElementById('shipment-tools-details')?.setAttribute('open', '');
  }

  function groupShipmentTools() {
    const pane = document.getElementById('tab-shipments');
    if (!pane || document.getElementById('shipment-tools-details')) return false;
    const entries = SHIP_PANELS
      .map((panel) => ({ ...panel, el: document.getElementById(panel.id) }))
      .filter((entry) => entry.el);
    if (entries.length < SHIP_PANELS.length) return false;

    const details = document.createElement('details');
    details.id = 'shipment-tools-details';
    details.className = 'shipment-tools-details';
    details.innerHTML = '<summary><strong>Shipment tools</strong><span>Containers, follow-ups, updates, emails and reports</span></summary><div class="shipment-tools-body"></div>';
    const body = details.querySelector('.shipment-tools-body');
    const anchor = entries[0].el;
    anchor.parentNode.insertBefore(details, anchor);
    // Each card keeps its own collapse state so users can hide the tools they
    // aren't using without collapsing the whole group.
    entries.forEach((entry) => {
      body.appendChild(entry.el);
      makeCardFoldable(entry.el, entry.key, entry.open);
    });
    return true;
  }

  function openShipmentToolsForTarget(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('#shipment-operations-card, #shipment-report-card, #shipment-email-card, #shipment-update-card')) {
      document.getElementById('shipment-tools-details')?.setAttribute('open', '');
    }
  }

  function install() {
    if (document.getElementById('progressive-disclosure-styles')) return;
    const style = document.createElement('style');
    style.id = 'progressive-disclosure-styles';
    style.textContent = `
      .workflow-hidden{display:none!important}
      .shipment-tools-details{margin:0 0 16px;border:1px solid rgba(148,163,184,.2);border-radius:12px;background:rgba(15,23,42,.38)}
      .shipment-tools-details>summary{display:flex;align-items:center;gap:10px;padding:14px 16px;cursor:pointer;list-style:none}
      .shipment-tools-details>summary::-webkit-details-marker{display:none}
      .shipment-tools-details>summary:after{content:'Show';margin-left:auto;font-size:12px;color:var(--muted,#94a3b8)}
      .shipment-tools-details[open]>summary:after{content:'Hide'}
      .shipment-tools-details>summary span{font-size:12px;color:var(--muted,#94a3b8)}
      .shipment-tools-body{padding:0 12px 12px}
      .shipment-tools-body>.card{margin-top:10px}
      .ship-foldable>.ship-fold-head{cursor:pointer;justify-content:flex-start;gap:10px;-webkit-user-select:none;user-select:none}
      .ship-foldable>.ship-fold-head>.btn-sm{margin-left:auto}
      .ship-fold-chev{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;background:transparent;color:var(--muted,#94a3b8);cursor:pointer;font-size:12px;line-height:1}
      .ship-fold-chev>span{display:inline-block;transition:transform .15s ease;transform:rotate(90deg)}
      .ship-foldable.ship-collapsed>.ship-fold-head>.ship-fold-chev>span{transform:rotate(0deg)}
      .ship-foldable.ship-collapsed>.ship-fold-head{margin-bottom:0}
      .ship-foldable.ship-collapsed>:not(.ship-fold-head){display:none!important}
      @media(max-width:700px){.shipment-tools-details>summary{align-items:flex-start;flex-direction:column}.shipment-tools-details>summary:after{position:absolute;right:20px}}
    `;
    document.head.appendChild(style);

    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (groupShipmentTools() || attempts > 30) clearInterval(timer);
      for (const selector of [...importSelectors.drayage, ...importSelectors.trucking]) {
        const card = cardFor(selector);
        if (card && !card.dataset.workflowInitialized) {
          card.dataset.workflowInitialized = 'true';
          setHidden(card, true);
        }
      }
    }, 100);

    document.addEventListener('workflow-selected', (event) => applyWorkflow(event.detail?.kind, event.detail?.tab));
    document.addEventListener('workflow-show-all', showAll);
    document.addEventListener('click', openShipmentToolsForTarget, true);
    document.addEventListener('shipment-report-for-ref', () => {
      document.getElementById('shipment-tools-details')?.setAttribute('open', '');
      expandCard(document.getElementById('shipment-report-card'));
    });
    document.addEventListener('shipment-operations-for-ref', () => {
      document.getElementById('shipment-tools-details')?.setAttribute('open', '');
      expandCard(document.getElementById('shipment-operations-card'));
    });
    // When focus lands inside a collapsed tool card (e.g. row action → update /
    // email assistant auto-fills + focuses a field), unfold it so the field is
    // visible instead of hidden behind the collapsed header.
    document.addEventListener('focusin', (event) => {
      const card = event.target.closest?.('.ship-foldable.ship-collapsed');
      if (card) expandCard(card);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
