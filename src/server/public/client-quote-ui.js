(function installClientQuoteUi() {
  'use strict';

  let returnFocus = null;

  function close() {
    document.getElementById('client-quote-dialog')?.remove();
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
    returnFocus = null;
  }

  function parseOptionalNumber(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const number = Number(text.replace(/,/g, ''));
    return Number.isFinite(number) ? number : Number.NaN;
  }

  function parseLines(text) {
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const [label, amount, basis, note, category] = line.split('|').map((value) => value?.trim());
      return {
        label,
        amount: parseOptionalNumber(amount),
        currency: 'USD',
        basis: basis || null,
        note: note || null,
        category: ['firm', 'statutory', 'conditional'].includes((category || '').toLowerCase()) ? category.toLowerCase() : 'firm',
      };
    });
  }

  function parseOptions(text) {
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const [carrier, containerType, amount, transitDays, destinationCharges, indicativeEtd, scheduleStatus, remarks, recommended] = line.split('|').map((value) => value?.trim());
      return {
        carrier,
        containerType,
        amount: parseOptionalNumber(amount),
        currency: 'USD',
        transitDays: parseOptionalNumber(transitDays),
        destinationCharges: parseOptionalNumber(destinationCharges),
        destinationCurrency: 'USD',
        indicativeEtd: indicativeEtd || null,
        scheduleStatus: scheduleStatus || 'Subject to booking confirmation',
        remarks: remarks || null,
        recommended: /^(yes|y|true|recommended)$/i.test(recommended || ''),
      };
    });
  }

  function payload(dialog) {
    const template = dialog.querySelector('#cq-template').value;
    return {
      template,
      title: dialog.querySelector('#cq-title').value.trim() || null,
      pol: dialog.querySelector('#cq-pol').value.trim() || null,
      pod: dialog.querySelector('#cq-pod').value.trim() || null,
      placeOfDelivery: dialog.querySelector('#cq-delivery').value.trim() || null,
      terminal: dialog.querySelector('#cq-terminal').value.trim() || null,
      hsCode: dialog.querySelector('#cq-hs').value.trim() || null,
      dutyRate: dialog.querySelector('#cq-duty').value.trim() || null,
      customsExamNote: dialog.querySelector('#cq-exam').value.trim() || null,
      waitingTime: dialog.querySelector('#cq-waiting').value.trim() || null,
      destinationChargesNote: dialog.querySelector('#cq-dest-note').value.trim() || null,
      validity: dialog.querySelector('#cq-validity').value.trim() || null,
      includeCommercialNotes: dialog.querySelector('#cq-commercial-notes').checked,
      hiddenMarkupFlat: parseOptionalNumber(dialog.querySelector('#cq-markup-flat').value) ?? 0,
      hiddenMarkupPct: parseOptionalNumber(dialog.querySelector('#cq-markup-pct').value) ?? 0,
      services: parseLines(dialog.querySelector('#cq-lines').value),
      options: parseOptions(dialog.querySelector('#cq-options').value),
      notes: dialog.querySelector('#cq-notes').value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    };
  }

  function updateMode(dialog) {
    const comparison = dialog.querySelector('#cq-template').value === 'ocean_comparison';
    dialog.querySelector('#cq-service-wrap').hidden = comparison;
    dialog.querySelector('#cq-option-wrap').hidden = !comparison;
  }

  function setValue(dialog, id, value) {
    if (value != null) dialog.querySelector(id).value = value;
  }

  function fill(dialog, data) {
    setValue(dialog, '#cq-template', data.template);
    setValue(dialog, '#cq-title', data.title);
    setValue(dialog, '#cq-pol', data.pol);
    setValue(dialog, '#cq-pod', data.pod);
    setValue(dialog, '#cq-terminal', data.terminal);
    setValue(dialog, '#cq-delivery', data.placeOfDelivery);
    setValue(dialog, '#cq-validity', data.validity);
    setValue(dialog, '#cq-dest-note', data.destinationChargesNote);
    setValue(dialog, '#cq-markup-flat', data.hiddenMarkupFlat ?? 0);
    setValue(dialog, '#cq-markup-pct', data.hiddenMarkupPct ?? 0);
    setValue(dialog, '#cq-hs', data.hsCode);
    setValue(dialog, '#cq-duty', data.dutyRate);
    setValue(dialog, '#cq-exam', data.customsExamNote);
    setValue(dialog, '#cq-waiting', data.waitingTime);
    if (data.services) {
      dialog.querySelector('#cq-lines').value = data.services.map((line) => [line.label, line.amount ?? '', line.basis ?? '', line.note ?? '', line.category ?? 'firm'].join(' | ')).join('\n');
    }
    if (data.options) {
      dialog.querySelector('#cq-options').value = data.options.map((option) => [option.carrier, option.containerType, option.amount ?? '', option.transitDays ?? '', option.destinationCharges ?? '', option.indicativeEtd ?? '', option.scheduleStatus ?? '', option.remarks ?? '', option.recommended ? 'yes' : 'no'].join(' | ')).join('\n');
    }
    if (data.notes) dialog.querySelector('#cq-notes').value = Array.isArray(data.notes) ? data.notes.join('\n') : String(data.notes);
    updateMode(dialog);
  }

  async function readError(response, fallback) {
    try {
      const data = await response.json();
      return data.error || fallback;
    } catch {
      return fallback;
    }
  }

  async function loadSaved(dialog) {
    const type = dialog.querySelector('#cq-source-type').value;
    const ref = dialog.querySelector('#cq-source-ref').value.trim();
    const status = dialog.querySelector('#cq-status');
    if (!ref) {
      status.textContent = 'Enter a saved quote reference.';
      return;
    }
    status.textContent = 'Loading saved quote…';
    try {
      const response = await fetch(`/api/client-quotes/prefill/${encodeURIComponent(type)}/${encodeURIComponent(ref)}`);
      if (!response.ok) {
        status.textContent = await readError(response, 'Could not load quote');
        return;
      }
      fill(dialog, await response.json());
      status.textContent = `Loaded ${ref}. Review the client-facing details.`;
    } catch (error) {
      status.textContent = `Could not load quote: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function preview(dialog) {
    const status = dialog.querySelector('#cq-status');
    const previewWindow = window.open('', 'client-quote-preview');
    if (!previewWindow) {
      status.textContent = 'Preview was blocked by the browser. Allow pop-ups for this site and try again.';
      return;
    }
    previewWindow.document.write('<p style="font-family:Arial;padding:20px">Creating preview…</p>');
    status.textContent = 'Creating preview…';
    try {
      const response = await fetch('/api/client-quotes/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload(dialog)),
      });
      if (!response.ok) {
        const message = await readError(response, 'Preview failed');
        status.textContent = message;
        previewWindow.close();
        return;
      }
      const html = await response.text();
      previewWindow.document.open();
      previewWindow.document.write(html);
      previewWindow.document.close();
      status.textContent = 'Preview opened.';
    } catch (error) {
      status.textContent = `Preview failed: ${error instanceof Error ? error.message : String(error)}`;
      previewWindow.close();
    }
  }

  async function download(dialog) {
    const status = dialog.querySelector('#cq-status');
    status.textContent = 'Creating PDF…';
    try {
      const response = await fetch('/api/client-quotes/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload(dialog)),
      });
      if (!response.ok) {
        status.textContent = await readError(response, 'PDF failed');
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'client-quote.pdf';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = 'PDF created.';
    } catch (error) {
      status.textContent = `PDF failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  function trapDialogKeys(dialog, event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')).filter((element) => !element.hidden && element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function open(event) {
    close();
    returnFocus = document.activeElement;
    const dialog = document.createElement('div');
    dialog.id = 'client-quote-dialog';
    dialog.className = 'simple-dialog-backdrop';
    dialog.innerHTML = `<section class="simple-dialog" role="dialog" aria-modal="true" aria-labelledby="client-quote-title" style="max-width:960px"><div class="simple-dialog-head"><div><h2 id="client-quote-title">Create client quote</h2><p>Load a saved quote or enter rates manually. Profit stays internal.</p></div><button class="simple-dialog-close" type="button" aria-label="Close client quote">×</button></div><div class="row" style="margin-top:14px"><select id="cq-source-type" aria-label="Saved quote type"><option value="ocean">Ocean</option><option value="drayage">Drayage</option><option value="trucking">Trucking</option></select><input id="cq-source-ref" aria-label="Saved quote reference" placeholder="Saved quote reference"><button id="cq-load" type="button" class="btn-sm">Load saved quote</button></div><div class="ship-update-grid" style="margin-top:14px"><label>Template<select id="cq-template"><option value="ocean_comparison">Ocean carrier comparison</option><option value="import_usa">Ocean import FCL, to USA</option><option value="import_canada">Ocean import FCL, to Canada</option><option value="export_clearance">Export customs clearance</option></select></label><label>Title<input id="cq-title"></label><label>POL / origin<input id="cq-pol"></label><label>POD / destination<input id="cq-pod"></label><label>Container terminal<input id="cq-terminal"></label><label>Place of delivery<input id="cq-delivery"></label><label>HS code<input id="cq-hs"></label><label>Duty indication<input id="cq-duty"></label><label>Rate validity / basis<input id="cq-validity"></label><label>Hidden profit per rate<input id="cq-markup-flat" type="number" value="0"></label><label>Hidden markup %<input id="cq-markup-pct" type="number" value="0"></label></div><label>Customs examination note<input id="cq-exam"></label><label>Waiting-time clause<input id="cq-waiting"></label><div id="cq-service-wrap"><label>Service lines <span class="muted-inline">service | amount | basis | note | category</span><textarea id="cq-lines" rows="8"></textarea></label></div><div id="cq-option-wrap"><label>Carrier options <span class="muted-inline">carrier | equipment | rate | transit | destination collect | ETD | status | remarks | recommended</span><textarea id="cq-options" rows="8"></textarea></label></div><label>Destination charges note<input id="cq-dest-note"></label><label>Additional operational notes<textarea id="cq-notes" rows="3"></textarea></label><label style="display:flex;gap:8px;align-items:center"><input id="cq-commercial-notes" type="checkbox" checked style="width:auto"> Include concise commercial notes</label><div class="row"><button id="cq-preview" type="button" class="btn-sm">Preview</button><button id="cq-download" type="button" class="primary">Create PDF</button><span id="cq-status" class="status-inline" role="status" aria-live="polite"></span></div></section>`;
    document.body.appendChild(dialog);
    dialog.querySelector('.simple-dialog-close').addEventListener('click', close);
    dialog.addEventListener('click', (clickEvent) => { if (clickEvent.target === dialog) close(); });
    dialog.addEventListener('keydown', (keyEvent) => trapDialogKeys(dialog, keyEvent));
    dialog.querySelector('#cq-template').addEventListener('change', () => updateMode(dialog));
    dialog.querySelector('#cq-load').addEventListener('click', () => loadSaved(dialog));
    dialog.querySelector('#cq-preview').addEventListener('click', () => preview(dialog));
    dialog.querySelector('#cq-download').addEventListener('click', () => download(dialog));
    if (event?.detail?.type) dialog.querySelector('#cq-source-type').value = event.detail.type;
    if (event?.detail?.refId) {
      dialog.querySelector('#cq-source-ref').value = event.detail.refId;
      loadSaved(dialog);
    } else if (event?.detail) {
      fill(dialog, event.detail);
    }
    updateMode(dialog);
    requestAnimationFrame(() => dialog.querySelector('#cq-title')?.focus());
  }

  document.addEventListener('client-quote-open', open);
})();
