(function installUsabilityShell() {
  'use strict';

  function activateTab(name) {
    document.querySelectorAll('.tab-pane').forEach((pane) => pane.classList.remove('active'));
    document.getElementById(`tab-${name}`)?.classList.add('active');
    document.querySelectorAll('[data-simple-tab]').forEach((button) => {
      button.classList.toggle('active', button.dataset.simpleTab === name);
      button.setAttribute('aria-current', button.dataset.simpleTab === name ? 'page' : 'false');
    });
    document.dispatchEvent(new CustomEvent('workflow-selected', { detail: { tab: name } }));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function installClearanceWorkspace(main) {
    if (document.getElementById('tab-clearance')) return;
    const pane = document.createElement('section');
    pane.id = 'tab-clearance';
    pane.className = 'tab-pane';
    pane.innerHTML = `
      <div class="card clearance-intro">
        <h2>Import / export clearance quotes</h2>
        <p class="muted">Prepare customs-clearance quotations separately from ocean and drayage. Choose the movement type, enter the commercial details, then open the client quote builder with the correct structure.</p>
        <div class="clearance-choice-grid">
          <button type="button" class="clearance-choice" data-clearance-template="import_usa" data-clearance-title="Import customs clearance quotation">
            <strong>Import clearance</strong>
            <span>Brokerage, entry, bond, duties/taxes and conditional customs charges.</span>
          </button>
          <button type="button" class="clearance-choice" data-clearance-template="import_canada" data-clearance-title="Canada import customs clearance quotation">
            <strong>Canada import clearance</strong>
            <span>Canadian customs-clearance services, taxes and delivery-related charges.</span>
          </button>
          <button type="button" class="clearance-choice" data-clearance-template="import_usa" data-clearance-title="Export customs clearance quotation">
            <strong>Export clearance</strong>
            <span>Export declaration, filing, document handling and conditional examination charges.</span>
          </button>
        </div>
      </div>
      <div class="card">
        <h2>Clearance request details</h2>
        <p class="muted small">Keep the request information here while preparing the quote. These fields are intentionally simple and remain editable before PDF creation.</p>
        <div class="grid">
          <label>Country / jurisdiction<input id="clearance-country" placeholder="United States or Canada"></label>
          <label>Port / border crossing<input id="clearance-port" placeholder="Newark, Detroit, Toronto Pearson…"></label>
          <label>Commodity<input id="clearance-commodity" placeholder="Machinery, household goods…"></label>
          <label>HS code<input id="clearance-hs" placeholder="6–10 digit code"></label>
          <label>Commercial value<input id="clearance-value" placeholder="USD 25,000"></label>
          <label>Importer / exporter<input id="clearance-party" placeholder="Company name"></label>
          <label class="full">Operational notes<textarea id="clearance-notes" rows="5" placeholder="Entry type, bond requirement, PGA/permit requirements, delivery terms, exam risk, special documents…"></textarea></label>
        </div>
      </div>`;
    main.appendChild(pane);

    pane.querySelectorAll('[data-clearance-template]').forEach((button) => {
      button.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('client-quote-open', {
          detail: {
            template: button.dataset.clearanceTemplate,
            title: button.dataset.clearanceTitle,
            hsCode: pane.querySelector('#clearance-hs')?.value || '',
            terminal: pane.querySelector('#clearance-port')?.value || '',
            notes: [
              pane.querySelector('#clearance-country')?.value,
              pane.querySelector('#clearance-commodity')?.value,
              pane.querySelector('#clearance-value')?.value,
              pane.querySelector('#clearance-party')?.value,
              pane.querySelector('#clearance-notes')?.value,
            ].filter(Boolean),
          },
        }));
      });
    });
  }

  function moveTruckingIntoDrayage() {
    const drayage = document.getElementById('tab-drayage');
    const trucking = document.getElementById('tab-trucking');
    if (!drayage || !trucking || document.getElementById('drayage-trucking-section')) return;

    const details = document.createElement('details');
    details.id = 'drayage-trucking-section';
    details.className = 'advanced-section drayage-trucking-section';
    details.innerHTML = '<summary><strong>Regular trucking rates</strong> <span class="muted small">FTL / LTL — open when needed</span></summary><div class="nested-trucking-workspace"></div>';
    const holder = details.querySelector('.nested-trucking-workspace');
    while (trucking.firstChild) holder.appendChild(trucking.firstChild);
    drayage.appendChild(details);
    trucking.remove();
  }

  function installShell() {
    const header = document.querySelector('header');
    const oldNav = header?.querySelector('nav');
    const main = document.querySelector('main');
    if (!header || !oldNav || !main || document.getElementById('simple-nav')) return;

    installClearanceWorkspace(main);
    moveTruckingIntoDrayage();

    oldNav.classList.add('legacy-nav-hidden');
    const nav = document.createElement('nav');
    nav.id = 'simple-nav';
    nav.className = 'simple-nav';
    nav.setAttribute('aria-label', 'Primary');
    nav.innerHTML = `
      <button type="button" class="simple-primary" data-simple-tab="shipments">Shipments</button>
      <button type="button" data-simple-tab="new">Ocean freight</button>
      <button type="button" data-simple-tab="drayage">Drayage</button>
      <button type="button" data-simple-tab="clearance">Customs clearance</button>
      <div class="simple-more-wrap">
        <button type="button" data-action="more" aria-expanded="false">More</button>
        <div class="simple-more-menu" hidden>
          <button type="button" data-action="import">Import rate files</button>
          <button type="button" data-action="client-quote">Create client quote</button>
          <button type="button" data-simple-tab="history">Quote history</button>
          <button type="button" data-simple-tab="delaypredict">DelayPredict</button>
          <button type="button" data-simple-tab="intellcluster">IntellCluster</button>
          <button type="button" data-action="show-all">Show all tools</button>
          <button type="button" data-action="system-check">System check</button>
          <button type="button" data-action="help">Help</button>
        </div>
      </div>`;
    header.appendChild(nav);

    const moreButton = nav.querySelector('[data-action="more"]');
    const moreMenu = nav.querySelector('.simple-more-menu');
    const closeMore = () => {
      moreMenu.hidden = true;
      moreButton.setAttribute('aria-expanded', 'false');
    };

    nav.querySelectorAll('[data-simple-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        activateTab(button.dataset.simpleTab);
        closeMore();
      });
    });
    moreButton.addEventListener('click', (event) => {
      event.stopPropagation();
      moreMenu.hidden = !moreMenu.hidden;
      moreButton.setAttribute('aria-expanded', String(!moreMenu.hidden));
    });
    nav.querySelector('[data-action="import"]').addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('universal-rate-import-open'));
      closeMore();
    });
    nav.querySelector('[data-action="client-quote"]').addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('client-quote-open'));
      closeMore();
    });
    nav.querySelector('[data-action="show-all"]').addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('workflow-show-all'));
      closeMore();
    });
    nav.querySelector('[data-action="system-check"]').addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('system-check-open'));
      closeMore();
    });
    nav.querySelector('[data-action="help"]').addEventListener('click', () => {
      document.getElementById('help-btn')?.click();
      closeMore();
    });
    document.addEventListener('click', (event) => {
      if (!nav.querySelector('.simple-more-wrap').contains(event.target)) closeMore();
    });

    document.querySelectorAll('details.advanced-section').forEach((details) => { details.open = false; });
    activateTab('shipments');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installShell);
  else installShell();
})();
