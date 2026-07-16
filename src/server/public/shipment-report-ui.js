(function installShipmentReportUi() {
  'use strict';

  function esc(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function installStyles() {
    if (document.getElementById('shipment-report-styles')) return;
    const style = document.createElement('style');
    style.id = 'shipment-report-styles';
    style.textContent = `
      .ship-report-controls{display:flex;gap:8px;align-items:end;flex-wrap:wrap}
      .ship-report-controls label{min-width:150px;flex:1}
      .ship-report-summary{margin:10px 0;font-weight:600}
      .ship-report-attention{color:#f59e0b}
      #ship-report-text{width:100%;min-height:260px;margin-top:10px}
      .ship-report-table td,.ship-report-table th{vertical-align:top}
      .ship-report-issue{display:inline-block;margin:2px 4px 2px 0;padding:2px 6px;border-radius:999px;background:rgba(245,158,11,.14);color:#f59e0b;font-size:11px}
    `;
    document.head.appendChild(style);
  }

  function renderTable(report) {
    const table = document.getElementById('ship-report-table');
    if (!table) return;
    if (!report.items.length) {
      table.innerHTML = '<tbody><tr><td class="empty">No shipments match this report.</td></tr></tbody>';
      return;
    }
    const head = '<thead><tr><th>Ref</th><th>Customer</th><th>Lane</th><th>Equipment</th><th>Status</th><th>Updated</th><th>Attention</th></tr></thead>';
    const body = report.items.map((item) => {
      const customer = item.customerName || item.shipperName || item.receiverName || '—';
      const issues = item.attention.length
        ? item.attention.map((issue) => `<span class="ship-report-issue">${esc(issue)}</span>`).join('')
        : '<span class="muted small">—</span>';
      return `<tr>
        <td><code>${esc(item.refId)}</code></td>
        <td>${esc(customer)}</td>
        <td>${esc(item.lane)}</td>
        <td>${esc(item.equipment)}</td>
        <td>${esc(item.statusLabel)}</td>
        <td>${esc(item.lastUpdated)}</td>
        <td>${issues}</td>
      </tr>`;
    }).join('');
    table.innerHTML = head + `<tbody>${body}</tbody>`;
  }

  async function generateReport() {
    const btn = document.getElementById('ship-report-generate');
    const status = document.getElementById('ship-report-status');
    const scope = document.getElementById('ship-report-scope').value;
    const customer = document.getElementById('ship-report-customer').value.trim();
    const params = new URLSearchParams({ scope });
    if (customer) params.set('customer', customer);

    btn.disabled = true;
    status.textContent = 'Generating…';
    try {
      const response = await fetch(`/api/shipments/report?${params.toString()}`);
      const report = await response.json();
      if (!response.ok) throw new Error(report.error || 'Report generation failed');
      document.getElementById('ship-report-summary').innerHTML =
        `${report.shipmentCount} shipment${report.shipmentCount === 1 ? '' : 's'} · ` +
        `<span class="ship-report-attention">${report.attentionCount} requiring attention</span>`;
      document.getElementById('ship-report-text').value = report.text;
      document.getElementById('ship-report-output').hidden = false;
      renderTable(report);
      status.textContent = 'Report ready.';
    } catch (err) {
      status.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function copyReport() {
    const text = document.getElementById('ship-report-text').value;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    document.getElementById('ship-report-status').textContent = 'Copied to clipboard.';
  }

  function install() {
    const pane = document.getElementById('tab-shipments');
    if (!pane || document.getElementById('shipment-report-card')) return;
    installStyles();
    const card = document.createElement('div');
    card.id = 'shipment-report-card';
    card.className = 'card';
    card.innerHTML = `
      <div class="card-header">
        <h2>Shipment status report <span class="muted-inline">— email-ready operations update</span></h2>
      </div>
      <p class="muted small">Creates a concise report from the shipment board without exposing cost, sell rate, or profit.</p>
      <div class="ship-report-controls">
        <label>Scope
          <select id="ship-report-scope">
            <option value="active" selected>Active shipments</option>
            <option value="all">All shipments</option>
          </select>
        </label>
        <label>Customer filter
          <input id="ship-report-customer" placeholder="Optional customer / shipper / receiver" />
        </label>
        <button id="ship-report-generate" class="primary" type="button">Generate report</button>
        <span id="ship-report-status" class="status-inline"></span>
      </div>
      <div id="ship-report-output" hidden>
        <div id="ship-report-summary" class="ship-report-summary"></div>
        <div class="table-wrap"><table id="ship-report-table" class="ship-report-table"></table></div>
        <textarea id="ship-report-text" rows="14" aria-label="Shipment status report text"></textarea>
        <div class="row"><button id="ship-report-copy" class="btn-sm" type="button">Copy report</button></div>
      </div>`;
    pane.prepend(card);
    document.getElementById('ship-report-generate').addEventListener('click', generateReport);
    document.getElementById('ship-report-copy').addEventListener('click', copyReport);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
