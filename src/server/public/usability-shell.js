(function installUsabilityShell() {
  'use strict';

  function activateTab(requestedName) {
    let name = requestedName;
    if (name === 'trucking') {
      name = 'drayage';
      document.getElementById('drayage-trucking-section')?.setAttribute('open', '');
    }
    const pane = document.getElementById(`tab-${name}`);
    if (!pane) return false;
    document.querySelectorAll('.tab-pane').forEach((item) => item.classList.remove('active'));
    pane.classList.add('active');
    document.querySelectorAll('[data-simple-tab]').forEach((button) => {
      const active = button.dataset.simpleTab === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    document.dispatchEvent(new CustomEvent('workflow-selected', { detail: { tab: requestedName } }));
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch {}
    return true;
  }

  function clearanceServices(kind) {
    if (kind === 'export') {
      return [
        { label: 'Export customs declaration / filing', amount: null, basis: 'per shipment', category: 'firm' },
        { label: 'Document handling', amount: null, basis: 'per shipment', category: 'firm' },
        { label: 'Permit, inspection or examination charges', amount: null, basis: 'if applicable', category: 'conditional' },
      ];
    }
    return [
      { label: 'Customs clearance / entry', amount: null, basis: 'per entry', category: 'firm' },
      { label: 'Brokerage and document handling', amount: null, basis: 'per shipment', category: 'firm' },
      { label: 'Bond, permit or examination charges', amount: null, basis: 'if applicable', category: 'conditional' },
    ];
  }

  function installClearanceWorkspace(main) {
    if (document.getElementById('tab-clearance')) return;
    const pane = document.createElement('section');
    pane.id = 'tab-clearance';
    pane.className = 'tab-pane';
    pane.innerHTML = `
      <div class="card clearance-intro">
        <h2>Import / export clearance quotes</h2>
        <p class="muted">Prepare customs-clearance quotations separately from ocean and drayage. Enter the request details, then choose the applicable movement type.</p>
        <div class="clearance-choice-grid">
          <button type="button" class="clearance-choice" data-clearance-kind="import" data-clearance-template="import_usa" data-clearance-title="USA import customs clearance quotation">
            <strong>USA import clearance</strong>
            <span>Brokerage, entry, bond, duties/taxes and conditional customs charges.</span>
          </button>
          <button type="button" class="clearance-choice" data-clearance-kind="import" data-clearance-template="import_canada" data-clearance-title="Canada import customs clearance quotation">
            <strong>Canada import clearance</strong>
            <span>Canadian customs-clearance services, taxes and delivery-related charges.</span>
          </button>
          <button type="button" class="clearance-choice" data-clearance-kind="export" data-clearance-template="export_clearance" data-clearance-title="Export customs clearance quotation">
            <strong>Export clearance</strong>
            <span>Export declaration, filing, document handling and conditional examination charges.</span>
          </button>
        </div>
      </div>
      <div class="card">
        <h2>Clearance request details</h2>
        <p class="muted small">These values are transferred into the client quote builder and remain editable before preview or PDF creation.</p>
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
        const kind = button.dataset.clearanceKind || 'import';
        document.dispatchEvent(new CustomEvent('client-quote-open', {
          detail: {
            template: button.dataset.clearanceTemplate,
            title: button.dataset.clearanceTitle,
            hsCode: pane.querySelector('#clearance-hs')?.value || '',
            terminal: pane.querySelector('#clearance-port')?.value || '',
            services: clearanceServices(kind),
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
    trucking.classList.remove('tab-pane', 'active');
    trucking.classList.add('nested-trucking-pane');
    holder.appendChild(trucking);
    drayage.appendChild(details);
  }

  function installWorkspaceGuides() {
    const guides = {
      shipments: {
        title: 'Shipments',
        description: 'Your main operational board for active and completed shipments, documents, notes, milestones and follow-ups.',
        tip: 'Start by dropping shipment documents above the spreadsheet, or add a blank row and edit cells directly.',
      },
      new: {
        title: 'Ocean freight',
        description: 'Parse carrier rate sheets, compare ocean options, and prepare client-facing quote replies.',
        tip: 'Uploaded and AI-extracted rates require a quick review of lane, equipment, validity and charge totals.',
      },
      drayage: {
        title: 'Drayage',
        description: 'Store drayage quotations, estimate matching lanes from history, and access occasional FTL/LTL rates.',
        tip: 'Historical estimates are guidance only. Confirm the final rate, equipment and accessorials with the provider.',
      },
      clearance: {
        title: 'Customs clearance',
        description: 'Prepare USA import, Canada import and export-clearance quotations using dedicated templates.',
        tip: 'Customs classification, statutory charges and duties or taxes must be verified before sending a quote.',
      },
    };
    for (const [id, guide] of Object.entries(guides)) {
      const pane = document.getElementById(`tab-${id}`);
      if (!pane || pane.querySelector(':scope > .workspace-guide')) continue;
      const intro = document.createElement('div');
      intro.className = 'workspace-guide';
      intro.innerHTML = `<div><h1>${guide.title}</h1><p>${guide.description}</p></div><div class="workspace-guide-tip"><strong>How to use this page</strong><br>${guide.tip}</div>`;
      pane.prepend(intro);
    }
  }

  function installShell() {
    const header = document.querySelector('header');
    const oldNav = header?.querySelector('nav');
    const main = document.querySelector('main') || document.body;
    if (!header || !oldNav || document.getElementById('simple-nav')) return;

    installClearanceWorkspace(main);
    moveTruckingIntoDrayage();
    installWorkspaceGuides();

    oldNav.classList.add('legacy-nav-hidden');
    header.classList.add('shell-active');

    // Brand-line controls: a colored status indicator + a hamburger menu,
    // pinned to the top-right so the workflow tabs get a clean, scroll-free row.
    const controls = document.createElement('div');
    controls.className = 'header-controls';
    controls.innerHTML = `
      <button type="button" class="status-indicator" data-action="system-check-primary" data-state="checking" aria-label="Feature readiness" title="Feature readiness"><span class="readiness-dot" aria-hidden="true"></span></button>
      <div class="simple-more-wrap">
        <button type="button" class="hamburger-btn" data-action="more" aria-expanded="false" aria-haspopup="menu" aria-controls="simple-more-menu" aria-label="Open menu"><span></span><span></span><span></span></button>
        <div id="simple-more-menu" class="simple-more-menu" role="menu" hidden>
          <button type="button" role="menuitem" data-action="import">Import rate files</button>
          <button type="button" role="menuitem" data-action="client-quote">Create client quote</button>
          <button type="button" role="menuitem" data-simple-tab="history">Quote history</button>
          <button type="button" role="menuitem" data-simple-tab="delaypredict">DelayPredict</button>
          <button type="button" role="menuitem" data-simple-tab="intellcluster">IntellCluster</button>
          <button type="button" role="menuitem" data-simple-tab="secrets">⚙ Settings</button>
          <button type="button" role="menuitem" data-action="show-all">Show all tools</button>
          <button type="button" role="menuitem" data-action="system-check">Feature readiness</button>
          <button type="button" role="menuitem" data-action="help">Help</button>
        </div>
      </div>`;
    header.appendChild(controls);

    const nav = document.createElement('nav');
    nav.id = 'simple-nav';
    nav.className = 'simple-nav';
    nav.setAttribute('aria-label', 'Primary');
    nav.innerHTML = `
      <button type="button" class="simple-primary" data-simple-tab="shipments">Shipments</button>
      <button type="button" data-simple-tab="new">Ocean</button>
      <button type="button" data-simple-tab="drayage">Drayage</button>
      <button type="button" data-simple-tab="clearance">Customs</button>`;
    header.appendChild(nav);

    const moreButton = controls.querySelector('[data-action="more"]');
    const moreMenu = controls.querySelector('.simple-more-menu');
    const readinessButton = controls.querySelector('[data-action="system-check-primary"]');
    const menuItems = () => Array.from(moreMenu.querySelectorAll('[role="menuitem"]'));
    const closeMore = (restoreFocus = false) => {
      moreMenu.hidden = true;
      moreButton.setAttribute('aria-expanded', 'false');
      if (restoreFocus) moreButton.focus();
    };
    const openMore = () => {
      moreMenu.hidden = false;
      moreButton.setAttribute('aria-expanded', 'true');
    };

    header.querySelectorAll('[data-simple-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        activateTab(button.dataset.simpleTab);
        closeMore();
      });
    });
    moreButton.addEventListener('click', (event) => {
      event.stopPropagation();
      moreMenu.hidden ? openMore() : closeMore();
    });
    moreButton.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        openMore();
        menuItems()[0]?.focus();
      } else if (event.key === 'Escape') {
        closeMore(true);
      }
    });
    moreMenu.addEventListener('keydown', (event) => {
      const items = menuItems();
      const index = items.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMore(true);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        items[(index + 1 + items.length) % items.length]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        items[(index - 1 + items.length) % items.length]?.focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        items.at(-1)?.focus();
      }
    });
    controls.querySelector('[data-action="import"]').addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('universal-rate-import-open'));
      closeMore();
    });
    controls.querySelector('[data-action="client-quote"]').addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('client-quote-open'));
      closeMore();
    });
    controls.querySelector('[data-action="show-all"]').addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('workflow-show-all'));
      closeMore();
    });
    const openReadiness = () => {
      document.dispatchEvent(new CustomEvent('system-check-open'));
      closeMore();
    };
    controls.querySelector('[data-action="system-check"]').addEventListener('click', openReadiness);
    readinessButton.addEventListener('click', openReadiness);
    controls.querySelector('[data-action="help"]').addEventListener('click', () => {
      document.getElementById('help-btn')?.click();
      closeMore();
    });
    document.addEventListener('click', (event) => {
      if (!controls.querySelector('.simple-more-wrap').contains(event.target)) closeMore();
    });
    document.addEventListener('system-readiness-updated', (event) => {
      const detail = event.detail || {};
      const features = Array.isArray(detail.features) ? detail.features : [];
      const needsSetup = features.some((item) => item.state === 'setup_required' || item.state === 'unavailable');
      const state = detail.status === 'unavailable' ? 'unavailable' : detail.status === 'ready' && !needsSetup ? 'ready' : 'degraded';
      readinessButton.dataset.state = state;
      readinessButton.title = state === 'ready' ? 'Core system and configured features are ready' : 'Some features need setup or attention';
    });

    const brand = header.querySelector('.brand');
    brand?.addEventListener('click', (event) => {
      event.preventDefault();
      activateTab('shipments');
      closeMore();
    });

    document.querySelectorAll('details.advanced-section').forEach((details) => { details.open = false; });
    activateTab('shipments');
    fetch('/api/health/ready', { cache: 'no-store' })
      .then((response) => response.json())
      .then((detail) => document.dispatchEvent(new CustomEvent('system-readiness-updated', { detail })))
      .catch(() => document.dispatchEvent(new CustomEvent('system-readiness-updated', { detail: { status: 'unavailable' } })));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installShell);
  else installShell();
})();
