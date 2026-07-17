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

  function createUi() {
    const pane = document.getElementById('tab-trucking');
    if (!pane || document.getElementById('tr-ingest-card')) return;
    const card = document.createElement('div');
    card.id = 'tr-ingest-card';
    card.className = 'card';
    card.innerHTML = `
      <h2>Import verified trucking rates <span class="muted-inline">— build your historical rate library</span></h2>
      <p class="muted">Upload trucker emails, PDFs, screenshots, spreadsheets, Word files, presentations, CSV exports, or text documents. Every verified lane is saved as historical evidence for future estimates.</p>
      <div id="tr-ingest-drop" class="sheet-dropzone">
        <div class="sheet-drop-prompt"><strong>Drop files here or click to browse</strong><span class="muted small">PDF · images · DOCX · XLSX · PPTX · ODS/ODT · EML/MSG · RTF · CSV/TSV · TXT/HTML/JSON/XML</span></div>
        <input id="tr-ingest-files" type="file" multiple hidden />
      </div>
      <ul id="tr-ingest-list" class="ship-pending-files" hidden></ul>
      <div class="row"><button id="tr-ingest-btn" class="primary" disabled>Extract and save rates</button><div id="tr-ingest-status" class="status-inline"></div></div>
      <div id="tr-ingest-result" class="muted small"></div>`;
    pane.insertBefore(card, pane.firstChild);

    const drop = card.querySelector('#tr-ingest-drop');
    const input = card.querySelector('#tr-ingest-files');
    const list = card.querySelector('#tr-ingest-list');
    const button = card.querySelector('#tr-ingest-btn');
    const status = card.querySelector('#tr-ingest-status');
    const result = card.querySelector('#tr-ingest-result');
    let selected = [];

    function render() {
      button.disabled = selected.length === 0;
      list.hidden = selected.length === 0;
      list.innerHTML = selected.map((f, i) => `<li><span>${escapeHtml(f.name)}</span><span class="muted small">${Math.ceil(f.size / 1024).toLocaleString()} KB</span><button type="button" class="link-btn" data-remove="${i}">Remove</button></li>`).join('');
      list.querySelectorAll('[data-remove]').forEach((el) => el.addEventListener('click', () => { selected.splice(Number(el.dataset.remove), 1); render(); }));
    }

    function escapeHtml(v) { const d = document.createElement('div'); d.textContent = String(v); return d.innerHTML; }
    function addFiles(files) { selected.push(...Array.from(files)); selected = selected.slice(0, 20); render(); }
    drop.addEventListener('click', () => input.click());
    input.addEventListener('change', () => addFiles(input.files));
    ['dragenter','dragover'].forEach((name) => drop.addEventListener(name, (e) => { e.preventDefault(); drop.classList.add('drag-over'); }));
    ['dragleave','drop'].forEach((name) => drop.addEventListener(name, (e) => { e.preventDefault(); drop.classList.remove('drag-over'); }));
    drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

    button.addEventListener('click', async () => {
      button.disabled = true; status.textContent = 'Reading and extracting rates…'; result.textContent = '';
      try {
        const files = await Promise.all(selected.map(async (f) => ({ filename: f.name, mediaType: f.type || 'application/octet-stream', fileBase64: await fileToBase64(f) })));
        const response = await fetch('/api/trucking/rates/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files }) });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Rate ingestion failed');
        status.textContent = `Imported ${payload.importedCount} rate${payload.importedCount === 1 ? '' : 's'}.`;
        const warnings = payload.warnings?.length ? ` Warnings: ${payload.warnings.join(' | ')}` : '';
        result.textContent = `${payload.files.map((f) => `${f.filename}: ${f.kind}`).join(' · ')}${warnings}`;
        selected = []; render();
        document.getElementById('tr-refresh-btn')?.click();
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err);
      } finally { button.disabled = selected.length === 0; }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', createUi);
  else createUi();
})();
