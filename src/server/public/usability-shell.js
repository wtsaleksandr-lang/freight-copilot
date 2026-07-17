(function installUsabilityShell() {
  'use strict';

  const TASKS = {
    quote: [
      { label: 'Ocean quote', detail: 'Carrier sheets and ocean rates', tab: 'new', focus: '#sheet-dropzone' },
      { label: 'Drayage quote', detail: 'Port-to-door container trucking', tab: 'drayage', focus: '#dr-form, #drayage-form' },
      { label: 'Trucking quote', detail: 'FTL and LTL ground freight', tab: 'trucking', focus: '#tr-form, #trucking-form' },
    ],
    import: [
      { label: 'Ocean rate files', detail: 'Carrier PDFs and screenshots', tab: 'new', focus: '#sheet-dropzone' },
      { label: 'Drayage rate files', detail: 'Emails, PDFs, sheets and images', tab: 'drayage', focus: '#dr-ingest-card' },
      { label: 'Trucking rate files', detail: 'Emails, PDFs, sheets and images', tab: 'trucking', focus: '#tr-ingest-card' },
    ],
  };

  function esc(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function activateTab(name) {
    const existing = document.querySelector(`header nav .tab[data-tab="${name}"]`);
    if (existing) existing.click();
    else {
      document.querySelectorAll('.tab-pane').forEach((pane) => pane.classList.remove('active'));
      document.getElementById(`tab-${name}`)?.classList.add('active');
    }
    document.querySelectorAll('[data-simple-tab]').forEach((button) => {
      button.classList.toggle('active', button.dataset.simpleTab === name);
    });
  }

  function focusTarget(selector) {
    if (!selector) return;
    let attempts = 0;
    const timer = setInterval(() => {
      const target = document.querySelector(selector);
      attempts += 1;
      if (target) {
        clearInterval(timer);
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        target.classList.add('simple-focus-ring');
        setTimeout(() => target.classList.remove('simple-focus-ring'), 1800);
        target.querySelector?.('input, textarea, select, button')?.focus?.({ preventScroll: true });
      } else if (attempts > 12) clearInterval(timer);
    }, 100);
  }

  function closeDialog() {
    document.getElementById('simple-task-dialog')?.remove();
  }

  function openTaskDialog(kind) {
    closeDialog();
    const title = kind === 'quote' ? 'What do you need to quote?' : 'What type of rates are you importing?';
    const items = TASKS[kind];
    const backdrop = document.createElement('div');
    backdrop.id = 'simple-task-dialog';
    backdrop.className = 'simple-dialog-backdrop';
    backdrop.innerHTML = `
      <section class="simple-dialog" role="dialog" aria-modal="true" aria-labelledby="simple-dialog-title">
        <div class="simple-dialog-head">
          <div><h2 id="simple-dialog-title">${esc(title)}</h2><p>Choose one option. The app will take you directly to the right workflow.</p></div>
          <button type="button" class="simple-dialog-close" aria-label="Close">×</button>
        </div>
        <div class="simple-choice-grid">
          ${items.map((item, index) => `
            <button type="button" class="simple-choice" data-choice="${index}">
              <strong>${esc(item.label)}</strong>
              <span>${esc(item.detail)}</span>
            </button>`).join('')}
        </div>
      </section>`;
    document.body.appendChild(backdrop);
    backdrop.querySelector('.simple-dialog-close').addEventListener('click', closeDialog);
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeDialog(); });
    backdrop.querySelectorAll('[data-choice]').forEach((button) => {
      button.addEventListener('click', () => {
        const item = items[Number(button.dataset.choice)];
        closeDialog();
        activateTab(item.tab);
        focusTarget(item.focus);
      });
    });
    backdrop.querySelector('[data-choice]')?.focus();
  }

  function installShell() {
    const header = document.querySelector('header');
    const oldNav = header?.querySelector('nav');
    if (!header || !oldNav || document.getElementById('simple-nav')) return;

    oldNav.classList.add('legacy-nav-hidden');
    const nav = document.createElement('nav');
    nav.id = 'simple-nav';
    nav.className = 'simple-nav';
    nav.innerHTML = `
      <button type="button" class="simple-primary" data-action="quote">Get a quote</button>
      <button type="button" data-simple-tab="shipments">Shipments</button>
      <button type="button" data-action="import">Import rates</button>
      <div class="simple-more-wrap">
        <button type="button" data-action="more" aria-expanded="false">More</button>
        <div class="simple-more-menu" hidden>
          <button type="button" data-simple-tab="history">History</button>
          <button type="button" data-simple-tab="delaypredict">DelayPredict</button>
          <button type="button" data-simple-tab="intellcluster">IntellCluster</button>
          <button type="button" data-action="help">Help</button>
        </div>
      </div>`;
    header.appendChild(nav);

    nav.querySelector('[data-action="quote"]').addEventListener('click', () => openTaskDialog('quote'));
    nav.querySelector('[data-action="import"]').addEventListener('click', () => openTaskDialog('import'));
    nav.querySelectorAll('[data-simple-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        activateTab(button.dataset.simpleTab);
        nav.querySelector('.simple-more-menu').hidden = true;
        nav.querySelector('[data-action="more"]').setAttribute('aria-expanded', 'false');
      });
    });

    const moreButton = nav.querySelector('[data-action="more"]');
    const moreMenu = nav.querySelector('.simple-more-menu');
    moreButton.addEventListener('click', (event) => {
      event.stopPropagation();
      moreMenu.hidden = !moreMenu.hidden;
      moreButton.setAttribute('aria-expanded', String(!moreMenu.hidden));
    });
    nav.querySelector('[data-action="help"]').addEventListener('click', () => {
      document.getElementById('help-btn')?.click();
      moreMenu.hidden = true;
    });
    document.addEventListener('click', (event) => {
      if (!nav.querySelector('.simple-more-wrap').contains(event.target)) {
        moreMenu.hidden = true;
        moreButton.setAttribute('aria-expanded', 'false');
      }
    });

    document.querySelectorAll('details.advanced-section').forEach((details) => { details.open = false; });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installShell);
  else installShell();
})();
