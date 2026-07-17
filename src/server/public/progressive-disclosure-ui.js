(function installProgressiveDisclosure() {
  'use strict';

  const importSelectors = {
    drayage: ['#dr-ingest-card', '#dr-lib-dropzone'],
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
    const cards = [
      document.getElementById('shipment-operations-card'),
      document.getElementById('shipment-report-card'),
      document.getElementById('shipment-email-card'),
      document.getElementById('shipment-update-card'),
    ].filter(Boolean);
    if (cards.length < 4) return false;

    const details = document.createElement('details');
    details.id = 'shipment-tools-details';
    details.className = 'shipment-tools-details';
    details.innerHTML = '<summary><strong>Shipment tools</strong><span>Containers, follow-ups, updates, emails and reports</span></summary><div class="shipment-tools-body"></div>';
    const body = details.querySelector('.shipment-tools-body');
    const anchor = cards[0];
    anchor.parentNode.insertBefore(details, anchor);
    cards.forEach((card) => body.appendChild(card));
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
    document.addEventListener('shipment-report-for-ref', () => document.getElementById('shipment-tools-details')?.setAttribute('open', ''));
    document.addEventListener('shipment-operations-for-ref', () => document.getElementById('shipment-tools-details')?.setAttribute('open', ''));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
