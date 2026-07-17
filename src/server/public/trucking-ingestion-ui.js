(function installTruckingIngestionUi() {
  'use strict';

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  function esc(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
  }

  function money(value, currency) {
    const amount = Number(value);
    return Number.isFinite(amount)
      ? `${esc(currency || '')} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : '—';
  }

  function createUi() {
    const pane = document.getElementById('tab-trucking');
    if (!pane || document.getElementById('tr-ingest-card')) return;
    const card = document.createElement('div');
    card.id = 'tr-ingest-card';
    card.className = 'card';
    card.innerHTML = `
      <h2>Import trucking rates <span class="muted-inline">— review before saving</span></h2>
      <p class="muted">Upload trucker emails, PDFs, screenshots, spreadsheets, Word files, presentations, CSV exports, or text documents. Extracted rates are shown for approval before they enter historical evidence.</p>
      <div id="tr-ingest-drop" class="sheet-dropzone">
        <div class="sheet-drop-prompt"><strong>Drop files here or click to browse</strong><span class="muted small">PDF · images · DOCX · XLSX · PPTX · ODS/ODT · EML/MSG · RTF · CSV/TSV · TXT/HTML/JSON/XML</span></div>
        <input id="tr-ingest-files" type="file" multiple hidden />
      </div>
      <ul id="tr-ingest-list" class="ship-pending-files" hidden></ul>
      <div class="row"><button id="tr-ingest-btn" class="primary" disabled>Extract rates for review</button><div id="tr-ingest-status" class="status-inline"></div></div>
      <div id="tr-ingest-result" class="muted small"></div>
      <div id="tr-ingest-review" hidden>
        <div class="card-header" style="margin-top:16px"><h3>Review extracted rates</h3><div class="row"><button id="tr-ingest-select-ready" class="btn-sm" type="button">Select import-ready</button><button id="tr-ingest-clear" class="btn-sm" type="button">Clear</button></div></div>
        <p class="muted small">Blocked rows cannot be imported. Warning rows should be checked against the source before approval.</p>
        <div class="table-wrap"><table id="tr-ingest-review-table"></table></div>
        <div class="row" style="margin-top:12px"><button id="tr-ingest-apply" class="primary" type="button" disabled>Import approved rates</button><div id="tr-ingest-apply-status" class="status-inline"></div></div>
      </div>`;
    pane.insertBefore(card, pane.firstChild);

    const drop = card.querySelector('#tr-ingest-drop');
    const input = card.querySelector('#tr-ingest-files');
    const list = card.querySelector('#tr-ingest-list');
    const button = card.querySelector('#tr-ingest-btn');
    const status = card.querySelector('#tr-ingest-status');
    const result = card.querySelector('#tr-ingest-result');
    const review = card.querySelector('#tr-ingest-review');
    const reviewTable = card.querySelector('#tr-ingest-review-table');
    const apply = card.querySelector('#tr-ingest-apply');
    const applyStatus = card.querySelector('#tr-ingest-apply-status');
    const selectReady = card.querySelector('#tr-ingest-select-ready');
    const clear = card.querySelector('#tr-ingest-clear');
    let selected = [];
    let previewId = '';
    let previewRates = [];

    function renderFiles() {
      button.disabled = selected.length === 0;
      list.hidden = selected.length === 0;
      list.innerHTML = selected.map((file, index) => `<li><span>${esc(file.name)}</span><span class="muted small">${Math.ceil(file.size / 1024).toLocaleString()} KB</span><button type="button" class="link-btn" data-remove="${index}">Remove</button></li>`).join('');
      list.querySelectorAll('[data-remove]').forEach((element) => element.addEventListener('click', () => {
        selected.splice(Number(element.dataset.remove), 1);
        renderFiles();
      }));
    }

    function selectedIndexes() {
      return Array.from(reviewTable.querySelectorAll('input[data-rate-index]:checked')).map((box) => Number(box.dataset.rateIndex));
    }

    function updateApplyButton() {
      apply.disabled = selectedIndexes().length === 0;
    }

    function renderReview(payload) {
      previewId = payload.previewId;
      previewRates = payload.rates || [];
      review.hidden = false;
      reviewTable.innerHTML = `<thead><tr><th>Use</th><th>Provider</th><th>Lane</th><th>Mode / equipment</th><th>Base</th><th>All-in</th><th>Validity</th><th>Review</th><th>Source</th></tr></thead><tbody>${previewRates.map((rate, index) => {
        const blocking = (rate.reviewIssues || []).some((issue) => issue.severity === 'blocking');
        const issues = (rate.reviewIssues || []).map((issue) => `<div class="${issue.severity === 'blocking' ? 'error' : 'muted'} small"><strong>${esc(issue.field)}:</strong> ${esc(issue.message)}</div>`).join('') || '<span class="muted small">No issues</span>';
        return `<tr class="${blocking ? 'rate-blocked' : ''}">
          <td><input type="checkbox" data-rate-index="${index}" ${blocking ? 'disabled' : ''}></td>
          <td>${esc(rate.provider_name)}</td>
          <td>${esc(rate.pickup_city)}${rate.pickup_state ? `, ${esc(rate.pickup_state)}` : ''} → ${esc(rate.delivery_city)}${rate.delivery_state ? `, ${esc(rate.delivery_state)}` : ''}</td>
          <td>${esc(String(rate.mode).toUpperCase())}<br><span class="muted small">${esc(rate.equipment_type)}</span></td>
          <td>${money(rate.base_rate, rate.currency)}</td>
          <td><strong>${money(rate.total_cost, rate.currency)}</strong></td>
          <td>${esc(rate.valid_until || 'Not stated')}</td>
          <td>${issues}</td>
          <td>${esc(rate.source_filename)}</td>
        </tr>`;
      }).join('')}</tbody>`;
      reviewTable.querySelectorAll('input[data-rate-index]').forEach((box) => box.addEventListener('change', updateApplyButton));
      updateApplyButton();
    }

    function addFiles(files) {
      selected.push(...Array.from(files));
      selected = selected.slice(0, 20);
      renderFiles();
    }

    drop.addEventListener('click', () => input.click());
    input.addEventListener('change', () => addFiles(input.files));
    ['dragenter', 'dragover'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add('drag-over'); }));
    ['dragleave', 'drop'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove('drag-over'); }));
    drop.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));

    button.addEventListener('click', async () => {
      button.disabled = true;
      status.textContent = 'Reading and extracting rates…';
      result.textContent = '';
      review.hidden = true;
      applyStatus.textContent = '';
      try {
        const files = await Promise.all(selected.map(async (file) => ({ filename: file.name, mediaType: file.type || 'application/octet-stream', fileBase64: await fileToBase64(file) })));
        const response = await fetch('/api/trucking/rates/ingest-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files }) });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Rate extraction failed');
        status.textContent = `Found ${payload.rates.length} rate${payload.rates.length === 1 ? '' : 's'}: ${payload.readyCount} import-ready, ${payload.blockedCount} blocked.`;
        const warnings = payload.warnings?.length ? ` Warnings: ${payload.warnings.join(' | ')}` : '';
        result.textContent = `${payload.files.map((file) => `${file.filename}: ${file.kind}`).join(' · ')}${warnings}`;
        renderReview(payload);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        button.disabled = selected.length === 0;
      }
    });

    selectReady.addEventListener('click', () => {
      reviewTable.querySelectorAll('input[data-rate-index]:not(:disabled)').forEach((box) => { box.checked = true; });
      updateApplyButton();
    });
    clear.addEventListener('click', () => {
      reviewTable.querySelectorAll('input[data-rate-index]').forEach((box) => { box.checked = false; });
      updateApplyButton();
    });

    apply.addEventListener('click', async () => {
      const indexes = selectedIndexes();
      apply.disabled = true;
      applyStatus.textContent = 'Saving approved rates…';
      try {
        const response = await fetch('/api/trucking/rates/ingest-apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewId, selectedIndexes: indexes }) });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Could not save approved rates');
        applyStatus.textContent = `Imported ${payload.importedCount} approved rate${payload.importedCount === 1 ? '' : 's'}.`;
        selected = [];
        previewId = '';
        previewRates = [];
        renderFiles();
        review.hidden = true;
        document.getElementById('tr-refresh-btn')?.click();
      } catch (error) {
        applyStatus.textContent = error instanceof Error ? error.message : String(error);
        updateApplyButton();
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', createUi);
  else createUi();
})();
