(function installDrayageMatrixUi() {
  'use strict';
  const el = (id) => document.getElementById(id);
  const pane = () => document.getElementById('tab-drayage');
  const val = (id) => (el(id)?.value || '').trim();
  let accessorials = [];
  let lastResult = null;

  function money(v, c) {
    return `${c || 'USD'} ${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function install() {
    const p = pane();
    if (!p || el('dr-matrix-card')) return;
    const card = document.createElement('div');
    card.id = 'dr-matrix-card';
    card.className = 'card';
    card.innerHTML = `
      <div class="card-header"><h2>Structured matrix rate <span class="muted-inline">— port zone tariff + accessorials</span></h2></div>
      <p class="muted small">Prices from the port-anchored zone tariff (distance ring to the door) plus the accessorials you tick — using the port + delivery from the form above. One side must be a tariff port (CY) and the other a delivery door.</p>
      <div class="dr-matrix-controls">
        <label>Margin %<input id="dr-mx-margin" type="number" value="0" step="0.5"></label>
        <label>Fuel $/mi<input id="dr-mx-fuel" type="number" value="0" step="0.05"></label>
      </div>
      <details class="dr-matrix-acc"><summary>Optional accessorials</summary><div id="dr-mx-acc-list" class="dr-mx-acc-grid"></div></details>
      <div class="row" style="margin-top:12px"><button id="dr-mx-run" class="primary" type="button">💵 Generate matrix rate</button><span id="dr-mx-status" class="status-inline"></span></div>
      <div id="dr-mx-result"></div>`;
    p.appendChild(card);
    el('dr-mx-run').addEventListener('click', run);
    loadAccessorials();
  }

  async function loadAccessorials() {
    if (accessorials.length) return renderAccList();
    try {
      const r = await fetch('/api/drayage/accessorials');
      if (!r.ok) return;
      const d = await r.json();
      accessorials = (d.accessorials || []).filter((a) => a.trigger === 'optional');
      renderAccList();
    } catch { /* offline — checkboxes just stay empty */ }
  }
  function renderAccList() {
    const list = el('dr-mx-acc-list');
    if (list) list.innerHTML = accessorials.map((a) => `<label class="dr-mx-acc-item"><input type="checkbox" value="${a.code}"> ${a.label}</label>`).join('');
  }

  function readForm() {
    const originType = document.querySelector('input[name="dr-origin-type"]:checked')?.value;
    const destType = document.querySelector('input[name="dr-destination-type"]:checked')?.value;
    let portCode = '';
    if (originType === 'CY') portCode = val('dr-origin-port-code');
    else if (destType === 'CY') portCode = val('dr-destination-port-code');
    const doorPrefix = originType === 'DOOR' ? 'origin' : destType === 'DOOR' ? 'destination' : null;
    let doorQuery = '';
    let doorCountry = '';
    if (doorPrefix) {
      doorQuery = [val(`dr-${doorPrefix}-address`), val(`dr-${doorPrefix}-city`), val(`dr-${doorPrefix}-state`), val(`dr-${doorPrefix}-zip`)].filter(Boolean).join(', ');
      doorCountry = val(`dr-${doorPrefix}-country`);
    }
    const cargo = val('dr-cargo-type');
    const weightKg = Number(val('dr-weight')) || 0;
    const selected = Array.from(el('dr-mx-acc-list')?.querySelectorAll('input:checked') || []).map((i) => i.value);
    return {
      portCode: portCode.toUpperCase(),
      doorQuery,
      doorCountry,
      flags: {
        hazmat: cargo === 'hazmat',
        tempControlled: cargo === 'reefer',
        ...(weightKg > 0 ? { weightLbs: Math.round(weightKg * 2.20462) } : {}),
      },
      selectedAccessorialCodes: selected,
      marginPct: Number(val('dr-mx-margin')) || 0,
      fuelPerMile: Number(val('dr-mx-fuel')) || 0,
    };
  }

  async function run() {
    const status = el('dr-mx-status');
    const result = el('dr-mx-result');
    const body = readForm();
    if (!body.portCode) { status.textContent = 'One side must be CY / port — set its port code (e.g. USLAX).'; return; }
    if (!body.doorQuery) { status.textContent = 'The other side must be a delivery DOOR with an address / ZIP.'; return; }
    status.textContent = 'Pricing…';
    try {
      const r = await fetch('/api/drayage/matrix-quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) { status.textContent = d.error || 'Failed.'; result.innerHTML = ''; return; }
      if (!d.ok) { status.textContent = d.reason || 'Not supported for this lane.'; result.innerHTML = ''; return; }
      status.textContent = `~${Math.round(d.miles)} mi from port`;
      renderResult(d);
    } catch (e) { status.textContent = 'Failed: ' + (e && e.message ? e.message : e); }
  }

  function renderResult(d) {
    lastResult = d;
    const rows = d.lines.map((l) => `<tr><td>${l.name}</td><td class="dr-mx-amt">${money(l.amount, d.currency)}</td></tr>`).join('');
    el('dr-mx-result').innerHTML = `
      <table class="dr-mx-table"><tbody>${rows}
        <tr class="dr-mx-total"><td>Total</td><td class="dr-mx-amt">${money(d.total, d.currency)}</td></tr>
      </tbody></table>
      <div class="row" style="margin-top:10px"><button id="dr-mx-copy" class="btn-sm" type="button">📋 Copy quote</button></div>`;
    el('dr-mx-copy').addEventListener('click', copy);
  }

  async function copy() {
    if (!lastResult) return;
    const d = lastResult;
    const lines = ['Drayage rate', `~${Math.round(d.miles)} mi from port`, ''];
    d.lines.forEach((l) => lines.push(`  • ${l.name} — ${money(l.amount, d.currency)}`));
    lines.push('', `Total: ${money(d.total, d.currency)}`, '', 'Rate based on our port zone tariff + selected accessorials. Chassis, fuel, tolls, waiting time, storage and equipment availability are confirmed at dispatch.');
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      const b = el('dr-mx-copy');
      if (b) { const t = b.textContent; b.textContent = '✓ Copied'; setTimeout(() => { b.textContent = t; }, 1500); }
    } catch { /* clipboard blocked */ }
  }

  const style = document.createElement('style');
  style.textContent = `
    #dr-matrix-card .dr-matrix-controls{display:flex;gap:16px;flex-wrap:wrap;margin-top:8px}
    #dr-matrix-card .dr-matrix-controls label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted,#64748b)}
    #dr-matrix-card .dr-matrix-controls input{width:100px;padding:6px 8px;border:1px solid var(--border,#e5e7eb);border-radius:7px}
    #dr-matrix-card .dr-matrix-acc{margin-top:12px}
    #dr-matrix-card .dr-mx-acc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px;margin-top:8px}
    #dr-matrix-card .dr-mx-acc-item{display:flex;align-items:center;gap:6px;font-size:13px}
    #dr-matrix-card .dr-mx-table{width:100%;border-collapse:collapse;margin-top:12px}
    #dr-matrix-card .dr-mx-table td{padding:6px 8px;border-bottom:1px solid var(--border,#e5e7eb);font-size:13px}
    #dr-matrix-card .dr-mx-amt{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:600}
    #dr-matrix-card .dr-mx-total td{font-weight:700;border-top:2px solid var(--border,#cbd5e1);font-size:15px}`;
  document.head.appendChild(style);

  let tries = 0;
  (function tryInstall() { if (pane()) install(); else if (tries++ < 40) setTimeout(tryInstall, 150); })();
  document.querySelector('[data-tab="drayage"]')?.addEventListener('click', install);
})();
