(function installShipmentUpdateUi() {
  'use strict';
  let preview = null;

  function esc(value) {
    return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function renderProposals(data) {
    const list = document.getElementById('ship-update-proposals');
    preview = data;
    if (!data.proposals.length) {
      list.innerHTML = '<div class="muted">No new supported shipment fields were detected.</div>';
      document.getElementById('ship-update-apply').disabled = true;
      return;
    }
    list.innerHTML = data.proposals.map((item, index) => {
      const checked = item.confidence === 'high' ? 'checked' : '';
      return `<label class="ship-update-proposal">
        <input type="checkbox" data-index="${index}" ${checked} />
        <span><strong>${esc(item.field)}</strong>: ${esc(item.currentValue ?? '—')} → <strong>${esc(item.proposedValue)}</strong>
        <small>${esc(item.confidence)} confidence · ${esc(item.evidence)}</small></span>
      </label>`;
    }).join('');
    document.getElementById('ship-update-apply').disabled = false;
  }

  async function createPreview() {
    const status = document.getElementById('ship-update-status');
    const refId = document.getElementById('ship-update-ref').value.trim();
    const text = document.getElementById('ship-update-text').value.trim();
    if (!refId || !text) { status.textContent = 'Enter a shipment reference and paste the update text.'; return; }
    status.textContent = 'Extracting changes…';
    const response = await fetch('/api/shipments/update-preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refId, text }),
    });
    const data = await response.json();
    if (!response.ok) { status.textContent = data.error || 'Preview failed'; return; }
    renderProposals(data);
    document.getElementById('ship-update-review').hidden = false;
    status.textContent = `${data.proposals.length} proposed change(s). Review before applying.`;
  }

  async function applyUpdates() {
    if (!preview) return;
    const status = document.getElementById('ship-update-status');
    const updates = [...document.querySelectorAll('#ship-update-proposals input:checked')].map((box) => {
      const item = preview.proposals[Number(box.dataset.index)];
      return { field: item.field, value: item.proposedValue };
    });
    if (!updates.length) { status.textContent = 'Select at least one change.'; return; }
    status.textContent = 'Applying selected changes…';
    const response = await fetch('/api/shipments/update-apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refId: preview.refId, expectedUpdatedAt: preview.expectedUpdatedAt, updates }),
    });
    const data = await response.json();
    if (!response.ok) { status.textContent = data.error || 'Update failed'; return; }
    status.textContent = `Updated ${data.updatedFields.join(', ')}.`;
    preview = null;
    document.getElementById('ship-update-review').hidden = true;
    if (typeof window.loadShipments === 'function') window.loadShipments();
  }

  function install() {
    const pane = document.getElementById('tab-shipments');
    if (!pane || document.getElementById('shipment-update-card')) return;
    const style = document.createElement('style');
    style.textContent = '.ship-update-grid{display:grid;grid-template-columns:minmax(150px,.35fr) 1fr;gap:10px}.ship-update-proposal{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid rgba(148,163,184,.15)}.ship-update-proposal small{display:block;color:#94a3b8;margin-top:3px}@media(max-width:700px){.ship-update-grid{grid-template-columns:1fr}}';
    document.head.appendChild(style);
    const card = document.createElement('div');
    card.id = 'shipment-update-card'; card.className = 'card';
    card.innerHTML = `<h2>Update shipment from an email <span class="muted-inline">— review before saving</span></h2>
      <p class="muted small">Paste a carrier or customer update. The system detects likely changes but never overwrites the shipment until you approve each field.</p>
      <div class="ship-update-grid"><label>Shipment reference<input id="ship-update-ref" placeholder="S00001" /></label><label>Update text<textarea id="ship-update-text" rows="6" placeholder="Paste email or operational update here…"></textarea></label></div>
      <div class="row"><button id="ship-update-preview" class="primary" type="button">Review detected changes</button><span id="ship-update-status" class="status-inline"></span></div>
      <div id="ship-update-review" hidden><h3 class="bd-title">Proposed changes</h3><div id="ship-update-proposals"></div><div class="row"><button id="ship-update-apply" class="primary" type="button">Apply selected changes</button></div></div>`;
    pane.prepend(card);
    document.getElementById('ship-update-preview').addEventListener('click', createPreview);
    document.getElementById('ship-update-apply').addEventListener('click', applyUpdates);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true }); else install();
})();
