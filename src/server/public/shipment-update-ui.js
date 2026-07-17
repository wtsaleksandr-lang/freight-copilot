(function installShipmentUpdateUi() {
  'use strict';
  let preview = null;
  let pendingFiles = [];

  function esc(value) {
    return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  function renderFiles() {
    const list = document.getElementById('ship-update-files-list');
    list.hidden = pendingFiles.length === 0;
    list.innerHTML = pendingFiles.map((file, index) => `<li><span>${esc(file.name)}</span><button type="button" class="link-btn" data-remove-file="${index}">Remove</button></li>`).join('');
    list.querySelectorAll('[data-remove-file]').forEach((button) => button.addEventListener('click', () => {
      pendingFiles.splice(Number(button.dataset.removeFile), 1);
      renderFiles();
    }));
  }

  function renderProposals(data) {
    const list = document.getElementById('ship-update-proposals');
    preview = data;
    document.getElementById('ship-update-ref').value = data.refId || '';
    if (!data.proposals.length) {
      list.innerHTML = '<div class="muted">No new supported shipment fields were detected.</div>';
      document.getElementById('ship-update-apply').disabled = true;
      return;
    }
    list.innerHTML = data.proposals.map((item, index) => {
      const checked = item.confidence === 'high' ? 'checked' : '';
      return `<label class="ship-update-proposal"><input type="checkbox" data-index="${index}" ${checked} /><span><strong>${esc(item.field)}</strong>: ${esc(item.currentValue ?? '—')} → <strong>${esc(item.proposedValue)}</strong><small>${esc(item.confidence)} confidence · ${esc(item.evidence)}</small></span></label>`;
    }).join('');
    document.getElementById('ship-update-apply').disabled = false;
  }

  function renderCandidates(data) {
    const review = document.getElementById('ship-update-review');
    review.hidden = false;
    const list = document.getElementById('ship-update-proposals');
    list.innerHTML = `<p class="muted small">Choose the shipment these files belong to:</p>${(data.candidates || []).map((item) => `<button type="button" class="simple-choice ship-match-choice" data-ref="${esc(item.refId)}"><strong>${esc(item.refId)}</strong><span>${esc(item.customerName || item.bookingRef || [item.pol, item.pod].filter(Boolean).join(' → ') || 'Possible match')}</span><small>${esc(item.evidence.join(', '))}</small></button>`).join('')}`;
    document.getElementById('ship-update-apply').disabled = true;
    list.querySelectorAll('[data-ref]').forEach((button) => button.addEventListener('click', () => createPreview(button.dataset.ref)));
  }

  async function createPreview(forcedRef) {
    const status = document.getElementById('ship-update-status');
    const refId = forcedRef || document.getElementById('ship-update-ref').value.trim();
    const text = document.getElementById('ship-update-text').value.trim();
    if (!text && pendingFiles.length === 0) { status.textContent = 'Paste an update or upload shipment files.'; return; }
    status.textContent = 'Reading update and matching shipment…';
    let response;
    if (pendingFiles.length > 0) {
      const files = await Promise.all(pendingFiles.map(async (file) => ({ filename: file.name, mediaType: file.type || 'application/octet-stream', fileBase64: await fileToBase64(file) })));
      response = await fetch('/api/shipments/document-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refId, files }) });
    } else {
      if (!refId) { status.textContent = 'Enter a shipment reference for pasted text.'; return; }
      response = await fetch('/api/shipments/update-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refId, text }) });
    }
    const data = await response.json();
    if (!response.ok) { status.textContent = data.error || 'Preview failed'; return; }
    if (data.matchStatus === 'ambiguous' || data.matchStatus === 'none') {
      renderCandidates(data);
      status.textContent = data.candidates?.length ? 'Several shipments may match. Choose one.' : 'No shipment match was found. Enter the shipment reference.';
      return;
    }
    renderProposals(data);
    document.getElementById('ship-update-review').hidden = false;
    status.textContent = `Matched ${data.refId}. ${data.proposals.length} proposed change(s).`;
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
    const response = await fetch('/api/shipments/update-apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refId: preview.refId, expectedUpdatedAt: preview.expectedUpdatedAt, updates }) });
    const data = await response.json();
    if (!response.ok) { status.textContent = data.error || 'Update failed'; return; }
    status.textContent = `Updated ${data.updatedFields.join(', ')}.`;
    preview = null; pendingFiles = []; renderFiles();
    document.getElementById('ship-update-review').hidden = true;
    if (typeof window.loadShipments === 'function') window.loadShipments();
  }

  function install() {
    const pane = document.getElementById('tab-shipments');
    if (!pane || document.getElementById('shipment-update-card')) return;
    const style = document.createElement('style');
    style.textContent = '.ship-update-grid{display:grid;grid-template-columns:minmax(150px,.35fr) 1fr;gap:10px}.ship-update-proposal{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid rgba(148,163,184,.15)}.ship-update-proposal small,.ship-match-choice small{display:block;color:#94a3b8;margin-top:3px}.ship-update-upload{margin:10px 0}.ship-match-choice{width:100%;text-align:left;margin:6px 0}@media(max-width:700px){.ship-update-grid{grid-template-columns:1fr}}';
    document.head.appendChild(style);
    const card = document.createElement('div');
    card.id = 'shipment-update-card'; card.className = 'card';
    card.innerHTML = `<h2>Update shipment <span class="muted-inline">— review before saving</span></h2><p class="muted small">Paste an update or upload an email, PDF, image, spreadsheet, or document. The app can match the shipment automatically and never saves changes without approval.</p><div class="ship-update-grid"><label>Shipment reference <span class="muted-inline">(optional for files)</span><input id="ship-update-ref" placeholder="S00001" /></label><label>Update text<textarea id="ship-update-text" rows="5" placeholder="Paste email or operational update here…"></textarea></label></div><div class="ship-update-upload"><input id="ship-update-files" type="file" multiple /><ul id="ship-update-files-list" class="ship-pending-files" hidden></ul></div><div class="row"><button id="ship-update-preview" class="primary" type="button">Match and review changes</button><span id="ship-update-status" class="status-inline"></span></div><div id="ship-update-review" hidden><h3 class="bd-title">Review</h3><div id="ship-update-proposals"></div><div class="row"><button id="ship-update-apply" class="primary" type="button">Apply selected changes</button></div></div>`;
    pane.prepend(card);
    document.getElementById('ship-update-files').addEventListener('change', (event) => { pendingFiles.push(...Array.from(event.target.files)); pendingFiles = pendingFiles.slice(0, 20); renderFiles(); event.target.value = ''; });
    document.getElementById('ship-update-preview').addEventListener('click', () => createPreview());
    document.getElementById('ship-update-apply').addEventListener('click', applyUpdates);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true }); else install();
})();
