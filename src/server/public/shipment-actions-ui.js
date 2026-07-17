(function installShipmentActionsUi() {
  'use strict';

  function shipmentRefFromRow(row) {
    const refs = [...row.querySelectorAll('code')].map((node) => node.textContent.trim());
    return refs.find((value) => /^S\d+$/i.test(value)) || '';
  }

  function closeMenus(except) {
    document.querySelectorAll('.ship-row-action-menu').forEach((menu) => {
      if (menu !== except) menu.hidden = true;
    });
  }

  function openShipmentTools() {
    document.getElementById('shipment-tools-details')?.setAttribute('open', '');
  }

  function focusCard(cardId, inputId, refId) {
    openShipmentTools();
    const card = document.getElementById(cardId);
    const input = document.getElementById(inputId);
    if (input) {
      input.value = refId;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => {
      const target = card?.querySelector('textarea, select, input, button');
      target?.focus?.({ preventScroll: true });
    }, 250);
  }

  async function copyRef(refId, button) {
    await navigator.clipboard.writeText(refId);
    const original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = original; }, 1000);
  }

  function buildMenu(refId) {
    const wrap = document.createElement('div');
    wrap.className = 'ship-row-actions';
    wrap.innerHTML = `
      <button type="button" class="ship-row-action-trigger" aria-haspopup="menu" aria-expanded="false" title="Shipment actions">Actions</button>
      <div class="ship-row-action-menu" role="menu" hidden>
        <button type="button" data-action="operations" role="menuitem">Containers & follow-ups</button>
        <button type="button" data-action="update" role="menuitem">Update from message</button>
        <button type="button" data-action="email" role="menuitem">Create email</button>
        <button type="button" data-action="report" role="menuitem">Create status report</button>
        <button type="button" data-action="copy" role="menuitem">Copy reference</button>
      </div>`;

    const trigger = wrap.querySelector('.ship-row-action-trigger');
    const menu = wrap.querySelector('.ship-row-action-menu');
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      const opening = menu.hidden;
      closeMenus(menu);
      menu.hidden = !opening;
      trigger.setAttribute('aria-expanded', String(opening));
    });
    menu.addEventListener('click', async (event) => {
      event.stopPropagation();
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (action === 'operations') {
        openShipmentTools();
        document.dispatchEvent(new CustomEvent('shipment-operations-for-ref', { detail: { refId } }));
      }
      if (action === 'update') focusCard('shipment-update-card', 'ship-update-ref', refId);
      if (action === 'email') focusCard('shipment-email-card', 'ship-email-ref', refId);
      if (action === 'report') {
        openShipmentTools();
        document.dispatchEvent(new CustomEvent('shipment-report-for-ref', { detail: { refId } }));
        document.getElementById('shipment-report-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      if (action === 'copy') await copyRef(refId, button);
    });
    return wrap;
  }

  function enhanceTable() {
    const table = document.getElementById('ship-table');
    if (!table) return;
    const headerRow = table.tHead?.rows?.[0];
    if (headerRow && !headerRow.querySelector('[data-ship-actions-header]')) {
      const th = document.createElement('th');
      th.dataset.shipActionsHeader = 'true';
      th.textContent = 'Actions';
      headerRow.appendChild(th);
    }
    table.tBodies?.[0]?.querySelectorAll('tr').forEach((row) => {
      if (row.querySelector('.ship-row-actions')) return;
      const refId = shipmentRefFromRow(row);
      if (!refId) return;
      const cell = document.createElement('td');
      cell.className = 'ship-row-actions-cell';
      cell.appendChild(buildMenu(refId));
      row.appendChild(cell);
    });
  }

  function install() {
    const table = document.getElementById('ship-table');
    if (!table || document.getElementById('shipment-actions-styles')) return;
    const style = document.createElement('style');
    style.id = 'shipment-actions-styles';
    style.textContent = `
      .ship-row-actions{position:relative;display:inline-block}
      .ship-row-action-trigger{white-space:nowrap;border:1px solid rgba(148,163,184,.28);background:rgba(15,23,42,.72);color:inherit;border-radius:7px;padding:5px 8px;cursor:pointer;font-size:12px}
      .ship-row-action-menu{position:absolute;right:0;top:calc(100% + 5px);z-index:120;min-width:205px;padding:6px;border:1px solid rgba(148,163,184,.28);border-radius:9px;background:#0f1b30;box-shadow:0 15px 40px rgba(0,0,0,.38)}
      .ship-row-action-menu button{display:block;width:100%;border:0;background:transparent;color:inherit;text-align:left;padding:9px;border-radius:6px;cursor:pointer}
      .ship-row-action-menu button:hover,.ship-row-action-menu button:focus-visible{background:rgba(56,189,248,.12);outline:none}
      .ship-row-actions-cell{overflow:visible!important}
    `;
    document.head.appendChild(style);
    const observer = new MutationObserver(enhanceTable);
    observer.observe(table, { childList: true, subtree: true });
    enhanceTable();
    document.addEventListener('click', () => closeMenus());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
