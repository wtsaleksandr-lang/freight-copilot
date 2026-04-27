// ---------- Generic multi-select dropdown ----------
// Builds a button + popover with checkboxes. Used for carriers, special
// equipment, accessorials.
class MultiDropdown {
  /**
   * @param {string} containerId  ID of the host element (must be empty on init)
   * @param {Array<{value:string,label:string,disabled?:boolean,suffix?:string,checked?:boolean}>} options
   * @param {{placeholderEmpty?:string, placeholderAll?:string, onChange?: () => void}} cfg
   */
  constructor(containerId, options, cfg = {}) {
    this.host = document.getElementById(containerId);
    this.options = options;
    this.cfg = cfg;
    this.render();
  }
  render() {
    this.host.classList.add('multi-dd');
    this.host.innerHTML = `
      <button type="button" class="multi-dd-btn">
        <span class="multi-dd-label"></span>
        <span class="multi-dd-chevron">▼</span>
      </button>
      <div class="multi-dd-panel" hidden>
        <div class="multi-dd-head">
          <button type="button" data-action="all">Select all</button>
          <button type="button" data-action="none">Clear</button>
        </div>
        <div class="multi-dd-options"></div>
      </div>`;
    const btn = this.host.querySelector('.multi-dd-btn');
    const panel = this.host.querySelector('.multi-dd-panel');
    const optsDiv = this.host.querySelector('.multi-dd-options');

    optsDiv.innerHTML = this.options
      .map(
        (o) =>
          `<label class="${o.disabled ? 'disabled' : ''}">
        <input type="checkbox" value="${esc(o.value)}" ${o.checked ? 'checked' : ''} ${o.disabled ? 'disabled' : ''}>
        <span>${esc(o.label)}</span>
        ${o.suffix ? `<span class="multi-dd-suffix">${o.suffix}</span>` : ''}
      </label>`
      )
      .join('');

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
    panel.addEventListener('click', (e) => e.stopPropagation());
    this.host.querySelector('[data-action="all"]').addEventListener('click', () => {
      this.host
        .querySelectorAll('.multi-dd-options input:not([disabled])')
        .forEach((cb) => (cb.checked = true));
      this.notify();
    });
    this.host.querySelector('[data-action="none"]').addEventListener('click', () => {
      this.host
        .querySelectorAll('.multi-dd-options input')
        .forEach((cb) => (cb.checked = false));
      this.notify();
    });
    optsDiv.addEventListener('change', () => this.notify());
    this.notify();
  }
  notify() {
    this.updateLabel();
    this.cfg.onChange?.();
  }
  updateLabel() {
    const labelEl = this.host.querySelector('.multi-dd-label');
    const checked = this.getValues();
    if (checked.length === 0) {
      labelEl.textContent = this.cfg.placeholderEmpty ?? '(none selected)';
    } else if (checked.length === this.options.filter((o) => !o.disabled).length) {
      labelEl.textContent = this.cfg.placeholderAll ?? `All ${checked.length} selected`;
    } else if (checked.length <= 3) {
      labelEl.textContent = checked.join(', ');
    } else {
      labelEl.textContent = `${checked.length} selected`;
    }
  }
  toggle(force) {
    const panel = this.host.querySelector('.multi-dd-panel');
    const open = force == null ? panel.hidden : !force;
    panel.hidden = !open;
    this.host.classList.toggle('open', open);
  }
  getValues() {
    return Array.from(
      this.host.querySelectorAll('.multi-dd-options input:checked')
    ).map((cb) => cb.value);
  }
  /** Check options whose value matches (case-insensitive substring match). */
  setCheckedByValues(values) {
    const wanted = (values || []).map((v) => String(v).toLowerCase().trim());
    this.host.querySelectorAll('.multi-dd-options input').forEach((cb) => {
      const v = cb.value.toLowerCase();
      cb.checked = wanted.some((w) => v.includes(w) || w.includes(v));
    });
    this.notify();
  }
}
// Close any open multi-dd when clicking outside
document.addEventListener('click', () => {
  document.querySelectorAll('.multi-dd.open').forEach((dd) => {
    dd.classList.remove('open');
    const panel = dd.querySelector('.multi-dd-panel');
    if (panel) panel.hidden = true;
  });
});

// ---------- Reusable Autosuggest (mobile-friendly, no <datalist>) ----------
// Usage: new Autosuggest(inputEl, fetchSuggestions(q) -> Promise<Array<{primary,secondary?,data?}>>,
//                       onPick(item))
class Autosuggest {
  constructor(inputEl, fetchFn, onPick, opts = {}) {
    this.input = inputEl;
    this.fetchFn = fetchFn;
    this.onPick = onPick;
    this.minChars = opts.minChars ?? 1;
    this.debounceMs = opts.debounceMs ?? 200;
    this.timer = null;
    this.activeIdx = -1;
    this.items = [];
    // Last value confirmed by either picking a suggestion OR being valid initial value.
    // On blur, if the input doesn't match this, we revert to it (clearing partials).
    this.lastConfirmed = inputEl.value || '';
    this.wrap();
    this.bind();
  }
  wrap() {
    // Wrap input in a positioned div for the popover
    const parent = this.input.parentElement;
    if (parent && !parent.classList.contains('autosuggest-wrap')) {
      const wrap = document.createElement('span');
      wrap.className = 'autosuggest-wrap';
      wrap.style.display = 'block';
      wrap.style.position = 'relative';
      parent.insertBefore(wrap, this.input);
      wrap.appendChild(this.input);
      this.wrapEl = wrap;
    } else {
      this.wrapEl = parent;
    }
    this.panel = document.createElement('div');
    this.panel.className = 'autosuggest-panel';
    this.panel.hidden = true;
    this.wrapEl.appendChild(this.panel);
  }
  bind() {
    this.input.addEventListener('input', () => this.scheduleQuery());
    this.input.addEventListener('focus', () => {
      if (this.input.value.length >= this.minChars) this.scheduleQuery();
    });
    this.input.addEventListener('keydown', (e) => {
      if (this.panel.hidden) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.move(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.move(-1);
      } else if (e.key === 'Enter') {
        if (this.activeIdx >= 0 && this.items[this.activeIdx]) {
          e.preventDefault();
          this.pick(this.items[this.activeIdx]);
        }
      } else if (e.key === 'Escape') {
        this.close();
      }
    });
    // On blur (focus leaves field), if user typed something that wasn't
    // confirmed via picking a suggestion, revert to last confirmed value
    // (or empty). Small delay so click-on-suggestion has a chance to fire.
    this.input.addEventListener('blur', () => {
      setTimeout(() => {
        if (this.input.value !== this.lastConfirmed) {
          this.input.value = this.lastConfirmed;
        }
        this.close();
      }, 180);
    });
    document.addEventListener('click', (e) => {
      if (!this.wrapEl.contains(e.target)) this.close();
    });
  }
  scheduleQuery() {
    if (this.timer) clearTimeout(this.timer);
    const q = this.input.value;
    if (q.length < this.minChars) {
      this.close();
      return;
    }
    this.timer = setTimeout(() => this.runQuery(q), this.debounceMs);
  }
  async runQuery(q) {
    try {
      const items = await this.fetchFn(q);
      this.render(items || []);
    } catch (err) {
      console.warn('autosuggest error:', err);
    }
  }
  render(items) {
    this.items = items;
    this.activeIdx = -1;
    if (items.length === 0) {
      this.panel.innerHTML = '<div class="autosuggest-empty">No matches</div>';
      this.panel.hidden = false;
      return;
    }
    this.panel.innerHTML = items
      .map(
        (it, i) =>
          `<div class="autosuggest-item" data-idx="${i}">
        <span class="as-primary">${esc(it.primary)}</span>
        ${it.secondary ? `<span class="as-secondary">${esc(it.secondary)}</span>` : ''}
      </div>`
      )
      .join('');
    this.panel.hidden = false;
    this.panel.querySelectorAll('.autosuggest-item').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(el.dataset.idx, 10);
        this.pick(this.items[idx]);
      });
    });
  }
  move(delta) {
    const els = this.panel.querySelectorAll('.autosuggest-item');
    if (els.length === 0) return;
    if (this.activeIdx >= 0) els[this.activeIdx].classList.remove('active');
    this.activeIdx = (this.activeIdx + delta + els.length) % els.length;
    els[this.activeIdx].classList.add('active');
    els[this.activeIdx].scrollIntoView({ block: 'nearest' });
  }
  pick(item) {
    this.close();
    this.onPick?.(item);
    // After onPick has set the input value to the canonical pick, lock it in.
    this.lastConfirmed = this.input.value;
  }
  close() {
    this.panel.hidden = true;
    this.activeIdx = -1;
  }
}

// ---------- Lookups (containers, ports, drayage equipment, accessorials) ----------
let LOOKUPS = null;

async function loadLookups() {
  try {
    const r = await fetch('/api/data/lookups');
    LOOKUPS = await r.json();
  } catch (err) {
    console.warn('lookups load failed:', err);
    LOOKUPS = {
      containerTypes: [],
      ports: [],
      drayageSpecialEquipment: [],
      drayageAccessorials: [],
      recentAddresses: [],
    };
  }

  // Container <select> elements already have static defaults inline; if the
  // server returns a richer list we replace, but only after preserving the
  // user's current pick.
  if (LOOKUPS.containerTypes && LOOKUPS.containerTypes.length > 0) {
    const containerOpts = LOOKUPS.containerTypes
      .map((c) => `<option value="${esc(c.label)}">${esc(c.label)}</option>`)
      .join('');
    document.querySelectorAll('select.container-select').forEach((sel) => {
      const current = sel.value || sel.dataset.current || '40 Dry High';
      sel.innerHTML = containerOpts;
      sel.value = current;
    });
  }

  // Wire ports + address autosuggest
  wirePortAutosuggest();
  wireAddressAutosuggest();
}

// ---- Port autosuggest (linked code <-> name fields) ----
function wirePortAutosuggest() {
  if (!LOOKUPS) return;
  const ports = LOOKUPS.ports || [];

  const portsByName = (q) => {
    const lower = q.toLowerCase();
    return ports
      .filter(
        (p) =>
          p.name.toLowerCase().includes(lower) ||
          p.code.toLowerCase().includes(lower) ||
          p.country.toLowerCase().includes(lower)
      )
      .slice(0, 10)
      .map((p) => ({
        primary: p.name,
        secondary: `${p.code} · ${p.country}`,
        data: p,
      }));
  };

  // Pick handler shared by both name + code: fills the OTHER linked field +
  // the (hidden) region input so Maersk's autocomplete disambiguates correctly.
  function applyPortPick(endpointFields, port) {
    const codeEl = endpointFields?.querySelector('.port-code-input');
    const nameEl = endpointFields?.querySelector('.port-name-input');
    const regionEl = endpointFields?.querySelector('input[id$="-region"]');
    if (codeEl) codeEl.value = port.code;
    if (nameEl) nameEl.value = port.name;
    if (regionEl) regionEl.value = port.country;
  }

  document.querySelectorAll('.port-name-input').forEach((input) => {
    new Autosuggest(input, async (q) => portsByName(q), (item) => {
      applyPortPick(input.closest('.endpoint-fields'), item.data);
    });
  });
  document.querySelectorAll('.port-code-input').forEach((input) => {
    new Autosuggest(input, async (q) => portsByName(q), (item) => {
      applyPortPick(input.closest('.endpoint-fields'), item.data);
    });
  });
}

// ---- Address + ZIP autosuggest via /api/data/geocode (Nominatim) ----
// `country` is read from a sibling .country-select inside the same
// endpoint-fields card so US-vs-CA queries stay disambiguated.
async function geocodeFetch(q, country) {
  const params = new URLSearchParams({ q });
  if (country) params.set('country', country.toLowerCase());
  const r = await fetch(`/api/data/geocode?${params.toString()}`);
  if (!r.ok) return [];
  const data = await r.json();
  return (data.results || []).map((it) => ({
    primary:
      [it.street, it.city, it.state, it.zip].filter(Boolean).join(', ') ||
      it.display,
    secondary: it.country,
    data: it,
  }));
}

function getCardCountry(input) {
  const ep = input.closest('.endpoint-fields');
  const sel = ep?.querySelector('.country-select');
  return sel ? sel.value : 'US';
}

function applyGeocodePick(input, item) {
  const it = item.data;
  // Only set the input itself to the street if that's the address field;
  // for ZIP fields, set the input to the ZIP and fill the rest as siblings.
  const isZip = input.classList.contains('zip-input');
  input.value = isZip ? (it.zip || '') : (it.street || item.primary);
  const ep = input.closest('.endpoint-fields');
  if (!ep) return;
  const setIf = (suffix, val) => {
    const el = ep.querySelector(`input[id$="-${suffix}"]`);
    if (el && val) {
      el.value = val;
    }
  };
  if (isZip) {
    // ZIP-driven pick: fill street/city/state/country (zip already set above)
    const addrEl = ep.querySelector('.address-input');
    if (addrEl && it.street) {
      addrEl.value = it.street;
      addrEl._asInstance && (addrEl._asInstance.lastConfirmed = addrEl.value);
    }
    setIf('city', it.city);
    setIf('state', it.state);
    setIf('country', it.countryCode || it.country);
  } else {
    setIf('city', it.city);
    setIf('state', it.state);
    setIf('zip', it.zip);
    setIf('country', it.countryCode || it.country);
    // Sync the ZIP field's lastConfirmed so blur doesn't clear it
    const zipEl = ep.querySelector('.zip-input');
    if (zipEl && zipEl._asInstance) zipEl._asInstance.lastConfirmed = zipEl.value;
  }
}

function wireAddressAutosuggest() {
  const wireOne = (input) => {
    const inst = new Autosuggest(
      input,
      (q) => geocodeFetch(q, getCardCountry(input)),
      (item) => applyGeocodePick(input, item),
      { minChars: 3, debounceMs: 350 }
    );
    input._asInstance = inst;
  };
  document.querySelectorAll('.address-input').forEach(wireOne);
  document.querySelectorAll('.zip-input').forEach(wireOne);
}

// Tab switching
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'history') loadHistory();
    if (btn.dataset.tab === 'bundles') loadBundles();
    if (btn.dataset.tab === 'drayage') loadDrayageList();
    if (btn.dataset.tab === 'trucking') loadTruckingList();
  });
});

// ---- Drayage tab ----

// Toggle CY/DOOR conditional fields. Uses .is-hidden class (with !important)
// so it can never lose to grid/flex display rules.
function wireCyDoorToggle(radioName, cyDivId, doorDivId) {
  const radios = document.querySelectorAll(`input[name="${radioName}"]`);
  const cyDiv = document.getElementById(cyDivId);
  const doorDiv = document.getElementById(doorDivId);
  if (!cyDiv || !doorDiv) {
    console.warn('wireCyDoorToggle: missing div(s)', cyDivId, doorDivId);
    return;
  }
  function update() {
    const checked = document.querySelector(`input[name="${radioName}"]:checked`);
    const v = checked ? checked.value : 'CY';
    cyDiv.classList.toggle('is-hidden', v !== 'CY');
    doorDiv.classList.toggle('is-hidden', v !== 'DOOR');
  }
  radios.forEach((r) => r.addEventListener('change', update));
  update();
}
wireCyDoorToggle('dr-origin-type', 'dr-origin-cy', 'dr-origin-door');
wireCyDoorToggle('dr-destination-type', 'dr-destination-cy', 'dr-destination-door');

// Drayage intake — paste text or image, AI fills the form
let drIntakeImageDataUrl = null;
let drIntakeImageMediaType = null;
const drIntakeTextarea = document.getElementById('dr-intake-text');
const drIntakePreview = document.getElementById('dr-intake-image-preview');
const drIntakePreviewImg = document.getElementById('dr-intake-image');

drIntakeTextarea.addEventListener('paste', (e) => {
  const items = (e.clipboardData || {}).items || [];
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) continue;
      const reader = new FileReader();
      reader.onload = () => {
        drIntakeImageDataUrl = String(reader.result);
        drIntakeImageMediaType = item.type;
        drIntakePreviewImg.src = drIntakeImageDataUrl;
        drIntakePreview.hidden = false;
        setStatus('dr-intake-status', 'Screenshot ready. Hit Extract.', 'info');
      };
      reader.readAsDataURL(blob);
      return;
    }
  }
});
document.getElementById('dr-intake-clear-image').addEventListener('click', () => {
  drIntakeImageDataUrl = null;
  drIntakeImageMediaType = null;
  drIntakePreview.hidden = true;
  drIntakePreviewImg.src = '';
});

// Mobile image upload for drayage intake
document.getElementById('dr-intake-file-btn').addEventListener('click', () => {
  document.getElementById('dr-intake-file').click();
});
document.getElementById('dr-intake-file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    drIntakeImageDataUrl = String(reader.result);
    drIntakeImageMediaType = file.type || 'image/png';
    drIntakePreviewImg.src = drIntakeImageDataUrl;
    drIntakePreview.hidden = false;
    setStatus('dr-intake-status', 'Image loaded. Tap "Extract" to parse.', 'info');
  };
  reader.readAsDataURL(file);
});

document.getElementById('dr-intake-btn').addEventListener('click', async () => {
  const text = drIntakeTextarea.value.trim();
  if (!text && !drIntakeImageDataUrl) {
    setStatus('dr-intake-status', 'Paste text or a screenshot first.', 'error');
    return;
  }
  const body = {};
  if (drIntakeImageDataUrl) {
    const base64 = drIntakeImageDataUrl.substring(drIntakeImageDataUrl.indexOf(',') + 1);
    body.imageBase64 = base64;
    body.imageMediaType = drIntakeImageMediaType || 'image/png';
  } else {
    body.text = text;
  }
  const btn = document.getElementById('dr-intake-btn');
  btn.disabled = true;
  setStatus('dr-intake-status', 'Extracting…', 'info');
  try {
    const r = await fetch('/api/drayage/intake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Intake failed');
    applyDrayageIntake(data);
    const cls = data.readiness.status === 'ready_to_run' ? 'success' : 'info';
    const msg =
      data.readiness.status === 'ready_to_run'
        ? `Extracted — ready to run. ${data.readiness.reason}`
        : `Extracted — review the form (${data.readiness.reason})`;
    setStatus('dr-intake-status', msg, cls);
  } catch (err) {
    setStatus('dr-intake-status', err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

function applyDrayageIntake(d) {
  const setVal = (id, v) => {
    if (v != null) document.getElementById(id).value = v;
  };
  if (d.cargoType) document.getElementById('dr-cargo-type').value = d.cargoType;
  setVal('dr-container', d.containerType);
  setVal('dr-container-count', d.containerCount ?? 1);
  setVal('dr-weight', d.weightKg ?? '');

  if (d.originType) {
    document.querySelector(`input[name="dr-origin-type"][value="${d.originType}"]`).checked = true;
  }
  setVal('dr-origin-port-code', d.originPortCode);
  setVal('dr-origin-port-name', d.originPortName);
  setVal('dr-origin-terminal', d.originTerminal);
  setVal('dr-origin-address', d.originAddressLine1);
  setVal('dr-origin-city', d.originCity);
  setVal('dr-origin-state', d.originState);
  setVal('dr-origin-zip', d.originZip);
  setVal('dr-origin-country', d.originCountry);

  if (d.destinationType) {
    document.querySelector(`input[name="dr-destination-type"][value="${d.destinationType}"]`).checked = true;
  }
  setVal('dr-destination-port-code', d.destinationPortCode);
  setVal('dr-destination-port-name', d.destinationPortName);
  setVal('dr-destination-terminal', d.destinationTerminal);
  setVal('dr-destination-address', d.destinationAddressLine1);
  setVal('dr-destination-city', d.destinationCity);
  setVal('dr-destination-state', d.destinationState);
  setVal('dr-destination-zip', d.destinationZip);
  setVal('dr-destination-country', d.destinationCountry);

  setVal('dr-pickup-date', d.pickupDate);
  setVal('dr-delivery-date', d.deliveryDate);
  if (d.specialEquipment?.length && drSpecialDropdown) {
    drSpecialDropdown.setCheckedByValues(d.specialEquipment);
  }
  if (d.accessorials?.length && drAccessorialsDropdown) {
    drAccessorialsDropdown.setCheckedByValues(d.accessorials);
  }
  setVal('dr-client', d.clientName);
  setVal('dr-notes', d.notes);

  // Re-render conditional fields after radio toggles
  ['dr-origin-type', 'dr-destination-type'].forEach((name) => {
    const checked = document.querySelector(`input[name="${name}"]:checked`);
    if (checked) checked.dispatchEvent(new Event('change'));
  });
}

function buildDrayageBody() {
  const originType = document.querySelector('input[name="dr-origin-type"]:checked').value;
  const destinationType = document.querySelector('input[name="dr-destination-type"]:checked').value;

  const buildEnd = (prefix, type) => {
    if (type === 'CY') {
      return {
        type,
        portCode: document.getElementById(`${prefix}-port-code`).value.trim() || undefined,
        portName: document.getElementById(`${prefix}-port-name`).value.trim() || undefined,
        terminal: document.getElementById(`${prefix}-terminal`).value.trim() || undefined,
      };
    }
    return {
      type,
      addressLine1: document.getElementById(`${prefix}-address`).value.trim() || undefined,
      city: document.getElementById(`${prefix}-city`).value.trim() || undefined,
      state: document.getElementById(`${prefix}-state`).value.trim() || undefined,
      zip: document.getElementById(`${prefix}-zip`).value.trim() || undefined,
      country: document.getElementById(`${prefix}-country`).value.trim() || 'US',
    };
  };

  return {
    cargoType: document.getElementById('dr-cargo-type').value,
    containerType: document.getElementById('dr-container').value,
    containerCount: 1,
    weightKg: parseInt(document.getElementById('dr-weight').value, 10) || undefined,
    origin: buildEnd('dr-origin', originType),
    destination: buildEnd('dr-destination', destinationType),
    pickupDate: document.getElementById('dr-pickup-date').value || undefined,
    deliveryDate: document.getElementById('dr-delivery-date').value || undefined,
    specialEquipment: drSpecialDropdown ? drSpecialDropdown.getValues() : [],
    accessorials: drAccessorialsDropdown ? drAccessorialsDropdown.getValues() : [],
    clientName: document.getElementById('dr-client').value.trim() || undefined,
    notes: document.getElementById('dr-notes').value.trim() || undefined,
    intakeText: drIntakeTextarea.value.trim() || undefined,
  };
}

async function saveDrayage() {
  const body = buildDrayageBody();
  const r = await fetch('/api/drayage/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Save failed');
  return data;
}

document.getElementById('dr-save-btn').addEventListener('click', async () => {
  const btn = document.getElementById('dr-save-btn');
  btn.disabled = true;
  setStatus('dr-status', 'Saving…', 'info');
  try {
    const data = await saveDrayage();
    setStatus('dr-status', `${data.refId} saved.`, 'success');
    showDrayageResult(data, null);
    loadDrayageList();
  } catch (err) {
    setStatus('dr-status', err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('dr-run-btn').addEventListener('click', async () => {
  const btn = document.getElementById('dr-run-btn');
  btn.disabled = true;
  setStatus('dr-status', 'Saving…', 'info');
  try {
    const data = await saveDrayage();
    setStatus('dr-status', `${data.refId} saved. Triggering automation…`, 'info');
    const runR = await fetch(`/api/drayage/run/${data.refId}`, { method: 'POST' });
    const runData = await runR.json();
    setStatus('dr-status', runData.message || 'Run complete.', runR.ok ? 'success' : 'error');
    showDrayageResult(data, runData);
    loadDrayageList();
  } catch (err) {
    setStatus('dr-status', err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

function showDrayageResult(saved, runData) {
  const card = document.getElementById('dr-result-card');
  card.hidden = false;
  document.getElementById('dr-result-title').textContent =
    `${saved.refId} — ${saved.derivedDirection}`;
  document.getElementById('dr-result-meta').innerHTML =
    `<code>${esc(saved.outputFolder)}</code>`;
  const msg = runData
    ? runData.message
    : 'Saved. Click Run to trigger the rate-retrieval automation (when configured).';
  document.getElementById('dr-result-msg').textContent = msg;
}

document.getElementById('dr-refresh-btn').addEventListener('click', loadDrayageList);

async function loadDrayageList() {
  const table = document.getElementById('dr-list-table');
  table.innerHTML = '<tbody><tr><td class="empty">Loading…</td></tr></tbody>';
  try {
    const r = await fetch('/api/drayage/quotes');
    const data = await r.json();
    if (!data.quotes || data.quotes.length === 0) {
      table.innerHTML = '<tbody><tr><td class="empty">No drayage requests yet.</td></tr></tbody>';
      return;
    }
    const thead = '<thead><tr><th>Ref ID</th><th>Created</th><th>Cargo</th><th>Container</th><th>From</th><th>To</th><th>Status</th></tr></thead>';
    const fmtEnd = (type, port, terminal, city, state) =>
      type === 'CY'
        ? `${esc(port || '')}${terminal ? ' / ' + esc(terminal) : ''} (CY)`
        : `${esc(city || '')}${state ? ', ' + esc(state) : ''} (DOOR)`;
    const rows = data.quotes
      .map((q) => {
        const created = new Date(q.createdAt).toISOString().slice(0, 16).replace('T', ' ');
        return `<tr>
          <td><code>${esc(q.refId)}</code></td>
          <td>${created}</td>
          <td>${esc(q.cargoType || 'general')}</td>
          <td>${esc(q.containerType)} × ${q.containerCount}</td>
          <td>${fmtEnd(q.originType, q.originPortCode, q.originTerminal, q.originCity, q.originState)}</td>
          <td>${fmtEnd(q.destinationType, q.destinationPortCode, q.destinationTerminal, q.destinationCity, q.destinationState)}</td>
          <td><span class="status-inline ${q.status === 'complete' ? 'success' : 'info'}">${esc(q.status)}</span></td>
        </tr>`;
      })
      .join('');
    table.innerHTML = thead + '<tbody>' + rows + '</tbody>';
  } catch (err) {
    table.innerHTML = `<tbody><tr><td class="empty">Error: ${esc(err.message)}</td></tr></tbody>`;
  }
}
loadDrayageList();

// ---- Trucking tab ----
document.getElementById('tr-submit-btn').addEventListener('click', async () => {
  const body = {
    mode: document.getElementById('tr-mode').value,
    cargoType: document.getElementById('tr-cargo-type').value,
    equipmentType: document.getElementById('tr-equipment').value,
    pickupAddressLine1: document.getElementById('tr-pickup-addr').value.trim(),
    pickupCity: document.getElementById('tr-pickup-city').value.trim(),
    pickupState: document.getElementById('tr-pickup-state').value.trim() || undefined,
    pickupZip: document.getElementById('tr-pickup-zip').value.trim() || undefined,
    pickupCountry: document.getElementById('tr-pickup-country').value.trim() || 'US',
    deliveryAddressLine1: document.getElementById('tr-delivery-addr').value.trim(),
    deliveryCity: document.getElementById('tr-delivery-city').value.trim(),
    deliveryState: document.getElementById('tr-delivery-state').value.trim() || undefined,
    deliveryZip: document.getElementById('tr-delivery-zip').value.trim() || undefined,
    deliveryCountry: document.getElementById('tr-delivery-country').value.trim() || 'US',
    weightKg: parseInt(document.getElementById('tr-weight').value, 10) || undefined,
    pieces: parseInt(document.getElementById('tr-pieces').value, 10) || undefined,
    lengthFt: parseFloat(document.getElementById('tr-length').value) || undefined,
    widthFt: parseFloat(document.getElementById('tr-width').value) || undefined,
    heightFt: parseFloat(document.getElementById('tr-height').value) || undefined,
    commodity: document.getElementById('tr-commodity').value.trim() || undefined,
    hazmat: document.getElementById('tr-hazmat').checked,
    tempControlled: document.getElementById('tr-temp').checked,
    tempMinF: parseFloat(document.getElementById('tr-temp-min').value) || undefined,
    tempMaxF: parseFloat(document.getElementById('tr-temp-max').value) || undefined,
    pickupDate: document.getElementById('tr-pickup-date').value || undefined,
    deliveryDate: document.getElementById('tr-delivery-date').value || undefined,
    clientName: document.getElementById('tr-client').value.trim() || undefined,
    notes: document.getElementById('tr-notes').value.trim() || undefined,
  };
  if (!body.pickupAddressLine1 || !body.pickupCity || !body.deliveryAddressLine1 || !body.deliveryCity) {
    setStatus('tr-status', 'Fill at least pickup + delivery address & city.', 'error');
    return;
  }
  const btn = document.getElementById('tr-submit-btn');
  btn.disabled = true;
  setStatus('tr-status', 'Saving…', 'info');
  try {
    const r = await fetch('/api/trucking/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Save failed');
    setStatus('tr-status', `${data.refId} saved.`, 'success');
    document.getElementById('tr-result-card').hidden = false;
    document.getElementById('tr-result-title').textContent = data.refId;
    document.getElementById('tr-result-meta').innerHTML =
      `<code>${esc(data.outputFolder)}</code>`;
    document.getElementById('tr-result-msg').textContent = data.message;
    loadTruckingList();
  } catch (err) {
    setStatus('tr-status', err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('tr-refresh-btn').addEventListener('click', loadTruckingList);

async function loadTruckingList() {
  const table = document.getElementById('tr-list-table');
  table.innerHTML = '<tbody><tr><td class="empty">Loading…</td></tr></tbody>';
  try {
    const r = await fetch('/api/trucking/quotes');
    const data = await r.json();
    if (!data.quotes || data.quotes.length === 0) {
      table.innerHTML = '<tbody><tr><td class="empty">No trucking requests yet.</td></tr></tbody>';
      return;
    }
    const thead = '<thead><tr><th>Ref ID</th><th>Created</th><th>Mode</th><th>Equipment</th><th>Pickup</th><th>Delivery</th><th>Status</th></tr></thead>';
    const rows = data.quotes
      .map((q) => {
        const created = new Date(q.createdAt).toISOString().slice(0, 16).replace('T', ' ');
        return `<tr>
          <td><code>${esc(q.refId)}</code></td>
          <td>${created}</td>
          <td>${esc(q.mode)}</td>
          <td>${esc(q.equipmentType)}</td>
          <td>${esc(q.pickupCity)}${q.pickupState ? ', ' + esc(q.pickupState) : ''}</td>
          <td>${esc(q.deliveryCity)}${q.deliveryState ? ', ' + esc(q.deliveryState) : ''}</td>
          <td><span class="status-inline ${q.status === 'complete' ? 'success' : 'info'}">${esc(q.status)}</span></td>
        </tr>`;
      })
      .join('');
    table.innerHTML = thead + '<tbody>' + rows + '</tbody>';
  } catch (err) {
    table.innerHTML = `<tbody><tr><td class="empty">Error: ${esc(err.message)}</td></tr></tbody>`;
  }
}
loadTruckingList();

// ---- Bundles tab ----
async function loadBundles() {
  const table = document.getElementById('bundles-table');
  table.innerHTML = '<tbody><tr><td class="empty">Loading…</td></tr></tbody>';
  try {
    const r = await fetch('/api/bundles');
    const data = await r.json();
    if (!data.bundles || data.bundles.length === 0) {
      table.innerHTML =
        '<tbody><tr><td class="empty">No bundles yet. Run a quote from the "New quote" tab.</td></tr></tbody>';
      return;
    }
    const thead = '<thead><tr><th>Ref ID</th><th>Created</th><th>Lane</th><th>Container</th><th>Carriers</th><th>Status</th><th>Client</th></tr></thead>';
    const rows = data.bundles
      .map((b) => {
        const created = new Date(b.createdAt).toISOString().slice(0, 16).replace('T', ' ');
        const statusCls =
          b.status === 'complete' ? 'success' : b.status === 'partial' ? 'info' : 'error';
        const carriers = Array.isArray(b.carrierCodes) ? b.carrierCodes.join(', ') : '';
        return `<tr class="clickable" data-refid="${b.refId}">
          <td><code>${esc(b.refId)}</code></td>
          <td>${created}</td>
          <td>${esc(b.origin)} → ${esc(b.destination)}</td>
          <td>${esc(b.containerType)}</td>
          <td>${esc(carriers)}</td>
          <td><span class="status-inline ${statusCls}">${esc(b.status)}</span></td>
          <td>${esc(b.clientName || '—')}</td>
        </tr>`;
      })
      .join('');
    table.innerHTML = thead + '<tbody>' + rows + '</tbody>';
    table.querySelectorAll('tr.clickable').forEach((row) => {
      row.addEventListener('click', () => loadBundleDetail(row.dataset.refid));
    });
  } catch (err) {
    table.innerHTML = `<tbody><tr><td class="empty">Error: ${esc(err.message)}</td></tr></tbody>`;
  }
}

async function loadBundleDetail(refId) {
  const card = document.getElementById('bundle-detail-card');
  const title = document.getElementById('bundle-detail-title');
  const status = document.getElementById('bundle-detail-status');
  const meta = document.getElementById('bundle-detail-meta');
  const table = document.getElementById('bundle-detail-table');
  const emailEl = document.getElementById('bundle-detail-email');
  card.hidden = false;
  meta.textContent = 'Loading…';
  try {
    const r = await fetch(`/api/bundles/${refId}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load');
    const b = data.bundle;
    title.textContent = `${b.refId} — ${b.origin} → ${b.destination}`;
    status.textContent = b.status;
    status.className = 'muted';
    const created = new Date(b.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    meta.innerHTML =
      `${esc(b.containerType)} · ${b.cargoWeightKg}kg · ${esc(b.commodity || '—')} · ` +
      `markup +${b.markupPct}% +${b.markupFlat} · ${created}<br>` +
      `<code>${esc(b.outputFolder)}</code>`;
    emailEl.value = b.generatedEmail || '(no email generated)';

    const snaps = data.rateSnapshots || [];
    if (snaps.length === 0) {
      table.innerHTML = '<tbody><tr><td class="empty">No rates saved.</td></tr></tbody>';
    } else {
      const thead = '<thead><tr><th>Carrier</th><th>Rank</th><th>Sailing</th><th>Vessel</th><th>Transit</th><th>Det/Dem</th><th>Cost</th></tr></thead>';
      const rows = snaps
        .map((s) => {
          const price = (s.totalCostCents / 100).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
          const dnd =
            s.detentionFreetimeDays != null || s.demurrageFreetimeDays != null
              ? `${s.detentionFreetimeDays ?? '?'}d / ${s.demurrageFreetimeDays ?? '?'}d`
              : '—';
          return `<tr>
            <td><strong>${esc(s.carrierName || '—')}</strong></td>
            <td class="rank">#${s.rank ?? '—'}</td>
            <td>${esc(s.sailingDate ?? '—')}</td>
            <td>${esc(s.vesselVoyage ?? '—')}</td>
            <td>${s.transitDays != null ? s.transitDays + 'd' : '—'}</td>
            <td>${esc(dnd)}</td>
            <td class="price">${esc(s.currency || '')} ${price}</td>
          </tr>`;
        })
        .join('');
      table.innerHTML = thead + '<tbody>' + rows + '</tbody>';
    }
    card.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    meta.textContent = 'Error: ' + err.message;
    table.innerHTML = '';
    emailEl.value = '';
  }
}

document.getElementById('bundles-refresh-btn').addEventListener('click', loadBundles);

// Drayage multi-dropdowns
let drSpecialDropdown = null;
let drAccessorialsDropdown = null;

function initDrayageDropdowns() {
  if (!LOOKUPS) return;
  drSpecialDropdown = new MultiDropdown(
    'dr-special-dd',
    LOOKUPS.drayageSpecialEquipment.map((v) => ({
      value: v,
      label: v,
      checked: false,
    })),
    {
      placeholderEmpty: '(none)',
      placeholderAll: `All ${LOOKUPS.drayageSpecialEquipment.length}`,
    }
  );
  drAccessorialsDropdown = new MultiDropdown(
    'dr-accessorials-dd',
    LOOKUPS.drayageAccessorials.map((v) => ({
      value: v,
      label: v,
      checked: false,
    })),
    {
      placeholderEmpty: '(none)',
      placeholderAll: `All ${LOOKUPS.drayageAccessorials.length}`,
    }
  );
}

// Bootstrap: load lookups first so container selects + datalists + drayage
// dropdowns are populated, then load carrier dropdown.
(async () => {
  await loadLookups();
  initDrayageDropdowns();
  await loadCarriers();
})();

// Carriers as a multi-select dropdown (closed by default). All checked by default.
let carrierDropdown = null;

async function loadCarriers() {
  try {
    const [carriersResp, sessionsResp] = await Promise.all([
      fetch('/api/carriers').then((r) => r.json()),
      fetch('/api/sessions').then((r) => r.json()),
    ]);
    const sessionByCode = Object.fromEntries(
      (sessionsResp.sessions || []).map((s) => [s.carrierCode, s])
    );

    const opts = carriersResp.carriers.map((c) => {
      const s = sessionByCode[c.code];
      let suffix = '';
      if (!c.isActive) suffix = 'onboarding';
      else if (s?.status === 'fresh') suffix = `${s.daysLeft}d session`;
      else if (s?.status === 'expiring') suffix = `${s.daysLeft}d left`;
      else suffix = 'no session';
      return {
        value: c.code,
        label: `${c.name} (${c.code})`,
        suffix,
        // User asked: default ALL selected. Keep inactive ones checked too —
        // bundle runner skips them cleanly with status 'skipped'.
        checked: true,
        disabled: false,
      };
    });

    carrierDropdown = new MultiDropdown('carrier-dd', opts, {
      placeholderEmpty: '(no carriers selected)',
      placeholderAll: `All ${opts.length} carriers selected`,
    });
  } catch (err) {
    document.getElementById('carrier-dd').innerHTML =
      `<span class="muted">Error loading carriers: ${esc(err.message)}</span>`;
  }
}

function getSelectedCarriers() {
  return carrierDropdown ? carrierDropdown.getValues() : [];
}

// ---- Markup sliders (synced with number inputs, persisted in localStorage) ----
const MARKUP_PCT_KEY = 'freight.markup.pct';
const MARKUP_FLAT_KEY = 'freight.markup.flat';
const EMAIL_TEMPLATE_KEY = 'freight.email.template';

const pctSlider = document.getElementById('markup-pct-slider');
const pctNum = document.getElementById('markup-pct');
const flatSlider = document.getElementById('markup-flat-slider');
const flatNum = document.getElementById('markup-flat');
const tplArea = document.getElementById('email-template');

(function restoreSettings() {
  const pct = localStorage.getItem(MARKUP_PCT_KEY);
  const flat = localStorage.getItem(MARKUP_FLAT_KEY);
  const tpl = localStorage.getItem(EMAIL_TEMPLATE_KEY);
  if (pct != null) {
    pctNum.value = pct;
    pctSlider.value = Math.min(parseFloat(pct), parseFloat(pctSlider.max));
  }
  if (flat != null) {
    flatNum.value = flat;
    flatSlider.value = Math.min(parseFloat(flat), parseFloat(flatSlider.max));
  }
  if (tpl) tplArea.value = tpl;
})();

function syncSliderToNum(slider, num, key) {
  slider.addEventListener('input', () => {
    num.value = slider.value;
    localStorage.setItem(key, slider.value);
  });
  num.addEventListener('change', () => {
    const v = parseFloat(num.value) || 0;
    slider.value = Math.min(v, parseFloat(slider.max));
    localStorage.setItem(key, num.value);
  });
}
syncSliderToNum(pctSlider, pctNum, MARKUP_PCT_KEY);
syncSliderToNum(flatSlider, flatNum, MARKUP_FLAT_KEY);

tplArea.addEventListener('change', () => {
  localStorage.setItem(EMAIL_TEMPLATE_KEY, tplArea.value);
});

function getMarkup() {
  return {
    pct: parseFloat(pctNum.value) || 0,
    flat: parseFloat(flatNum.value) || 0,
  };
}

function applyMarkup(cost, markup) {
  return Math.round(cost * (1 + markup.pct / 100) + markup.flat);
}

// Intake — paste a client request (text or image), extract, auto-fill the form
let pastedImageDataUrl = null;
let pastedImageMediaType = null;

const intakeTextarea = document.getElementById('intake-text');
const intakePreview = document.getElementById('intake-image-preview');
const intakePreviewImg = document.getElementById('intake-image');

intakeTextarea.addEventListener('paste', (e) => {
  const items = (e.clipboardData || {}).items || [];
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) continue;
      const reader = new FileReader();
      reader.onload = () => {
        pastedImageDataUrl = String(reader.result);
        pastedImageMediaType = item.type;
        intakePreviewImg.src = pastedImageDataUrl;
        intakePreview.hidden = false;
        setStatus('intake-status', 'Screenshot ready. Hit "Extract" to parse.', 'info');
      };
      reader.readAsDataURL(blob);
      return;
    }
  }
});

document.getElementById('intake-clear-image').addEventListener('click', () => {
  pastedImageDataUrl = null;
  pastedImageMediaType = null;
  intakePreview.hidden = true;
  intakePreviewImg.src = '';
  setStatus('intake-status', '', '');
});

// Mobile-friendly image upload (file picker)
document.getElementById('intake-file-btn').addEventListener('click', () => {
  document.getElementById('intake-file').click();
});
document.getElementById('intake-file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pastedImageDataUrl = String(reader.result);
    pastedImageMediaType = file.type || 'image/png';
    intakePreviewImg.src = pastedImageDataUrl;
    intakePreview.hidden = false;
    setStatus('intake-status', 'Image loaded. Tap "Extract" to parse.', 'info');
  };
  reader.readAsDataURL(file);
});

// Wire ocean origin/destination CY/DOOR toggles
wireCyDoorToggle('oc-origin-type', 'oc-origin-cy', 'oc-origin-door');
wireCyDoorToggle('oc-destination-type', 'oc-destination-cy', 'oc-destination-door');

document.getElementById('intake-btn').addEventListener('click', async () => {
  const text = intakeTextarea.value.trim();
  if (!text && !pastedImageDataUrl) {
    setStatus('intake-status', 'Paste text or a screenshot first.', 'error');
    return;
  }
  const body = {};
  if (pastedImageDataUrl) {
    // Strip the "data:image/png;base64," prefix
    const base64 = pastedImageDataUrl.substring(pastedImageDataUrl.indexOf(',') + 1);
    body.imageBase64 = base64;
    body.imageMediaType = pastedImageMediaType || 'image/png';
  } else {
    body.text = text;
  }

  const btn = document.getElementById('intake-btn');
  btn.disabled = true;
  setStatus('intake-status', 'Extracting…', 'info');

  try {
    const r = await fetch('/api/intake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Intake failed');

    const setVal = (id, v) => {
      if (v != null) {
        const el = document.getElementById(id);
        if (el) el.value = v;
      }
    };
    setVal('from', data.from);
    setVal('from-region', data.fromRegion);
    setVal('to', data.to);
    setVal('to-region', data.toRegion);
    setVal('container', data.container);
    setVal('weight', data.weight);
    setVal('commodity', data.commodity);
    if (data.cargoType) document.getElementById('cargo-type').value = data.cargoType;

    // Structured origin/destination
    if (data.originType) {
      const r = document.querySelector(
        `input[name="oc-origin-type"][value="${data.originType}"]`
      );
      if (r) {
        r.checked = true;
        r.dispatchEvent(new Event('change'));
      }
    }
    setVal('oc-origin-port-code', data.originPortCode);
    setVal('oc-origin-terminal', data.originTerminal);
    setVal('oc-origin-address', data.originAddressLine1);
    setVal('oc-origin-city', data.originCity);
    setVal('oc-origin-state', data.originState);
    setVal('oc-origin-zip', data.originZip);
    setVal('oc-origin-country', data.originCountry);

    if (data.destinationType) {
      const r = document.querySelector(
        `input[name="oc-destination-type"][value="${data.destinationType}"]`
      );
      if (r) {
        r.checked = true;
        r.dispatchEvent(new Event('change'));
      }
    }
    setVal('oc-destination-port-code', data.destinationPortCode);
    setVal('oc-destination-terminal', data.destinationTerminal);
    setVal('oc-destination-address', data.destinationAddressLine1);
    setVal('oc-destination-city', data.destinationCity);
    setVal('oc-destination-state', data.destinationState);
    setVal('oc-destination-zip', data.destinationZip);
    setVal('oc-destination-country', data.destinationCountry);

    const confClass = `confidence-${data.confidence}`;
    const notesHtml = data.notes
      ? ` <span class="muted">· Notes: ${esc(data.notes)}</span>`
      : '';
    const statusEl = document.getElementById('intake-status');
    statusEl.className = 'status-inline';
    statusEl.innerHTML =
      `Extracted — <span class="${confClass}">${data.confidence} confidence</span>. Review the form below.${notesHtml}`;
  } catch (err) {
    setStatus('intake-status', err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('reply-copy-btn').addEventListener('click', async () => {
  const ta = document.getElementById('reply-text');
  try {
    await navigator.clipboard.writeText(ta.value);
    setStatus('reply-status', 'Copied to clipboard.', 'success');
  } catch (e) {
    ta.select();
    setStatus('reply-status', 'Copy failed — selected the text for manual copy.', 'info');
  }
});

// Run full quote bundle (one-click multi-carrier)
document.getElementById('run-btn').addEventListener('click', async () => {
  const carriers = getSelectedCarriers();
  if (carriers.length === 0) {
    setStatus('run-status', 'Pick at least one carrier (checkbox above).', 'error');
    return;
  }
  const markup = getMarkup();

  const originType = document.querySelector('input[name="oc-origin-type"]:checked').value;
  const destinationType = document.querySelector('input[name="oc-destination-type"]:checked').value;
  const buildOcEnd = (prefix, type) => {
    if (type === 'CY') {
      // Note: port name for CY lives in the legacy 'from'/'to' inputs.
      const portNameEl = prefix === 'oc-origin' ? 'from' : 'to';
      return {
        type,
        portCode: document.getElementById(`${prefix}-port-code`).value.trim() || undefined,
        portName: document.getElementById(portNameEl).value.trim() || undefined,
        terminal: document.getElementById(`${prefix}-terminal`).value.trim() || undefined,
      };
    }
    return {
      type,
      addressLine1: document.getElementById(`${prefix}-address`).value.trim() || undefined,
      city: document.getElementById(`${prefix}-city`).value.trim() || undefined,
      state: document.getElementById(`${prefix}-state`).value.trim() || undefined,
      zip: document.getElementById(`${prefix}-zip`).value.trim() || undefined,
      country: document.getElementById(`${prefix}-country`).value.trim() || 'US',
    };
  };
  const originStruct = buildOcEnd('oc-origin', originType);
  const destinationStruct = buildOcEnd('oc-destination', destinationType);

  // Derive legacy from/fromRegion/to/toRegion (used by Maersk autocomplete today)
  const deriveFrom = (struct) =>
    struct.type === 'CY'
      ? { from: struct.portName, fromRegion: undefined }
      : { from: struct.city, fromRegion: struct.state };
  const fromLegacy = deriveFrom(originStruct);
  const toLegacy = deriveFrom(destinationStruct);

  const body = {
    carriers,
    cargoType: document.getElementById('cargo-type').value,
    originStruct,
    destinationStruct,
    from: document.getElementById('from').value.trim() || fromLegacy.from,
    fromRegion:
      document.getElementById('from-region').value.trim() || fromLegacy.fromRegion,
    to: document.getElementById('to').value.trim() || toLegacy.from,
    toRegion:
      document.getElementById('to-region').value.trim() || toLegacy.fromRegion,
    container: document.getElementById('container').value.trim(),
    weight: parseInt(document.getElementById('weight').value, 10),
    commodity: document.getElementById('commodity').value.trim() || undefined,
    clientName: document.getElementById('client-name').value.trim() || undefined,
    markupPct: markup.pct,
    markupFlat: markup.flat,
    emailTemplate: tplArea.value.trim() || undefined,
    intakeText: document.getElementById('intake-text').value.trim() || undefined,
  };
  if (!body.from || !body.to || !body.container || !body.weight) {
    setStatus('run-status', 'Fill at least From, To, Container, Weight.', 'error');
    return;
  }

  const btn = document.getElementById('run-btn');
  btn.disabled = true;
  setStatus(
    'run-status',
    `Running ${carriers.length} carrier(s) — Chrome will open per carrier. This takes ~${carriers.length * 60}s…`,
    'info'
  );

  try {
    const r = await fetch('/api/bundle/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Bundle failed');
    const okCount = data.carriers.filter((c) => c.status === 'ok').length;
    setStatus(
      'run-status',
      `${data.refId} — ${okCount}/${data.carriers.length} carriers returned rates. Saved to ${data.outputFolder}.`,
      data.status === 'failed' ? 'error' : 'success'
    );
    renderBundleResults(body, data);
  } catch (err) {
    setStatus('run-status', err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

function renderBundleResults(input, data) {
  const card = document.getElementById('results-card');
  const title = document.getElementById('results-title');
  const meta = document.getElementById('results-meta');
  const table = document.getElementById('results-table');
  card.hidden = false;
  const markup = getMarkup();

  title.textContent = `${data.refId}: ${input.from} → ${input.to} (${input.container})`;
  const carrierBadges = data.carriers
    .map((c) => {
      const cls =
        c.status === 'ok'
          ? 'success'
          : c.status === 'captcha_blocked'
            ? 'warn'
            : c.status === 'skipped'
              ? 'muted'
              : 'error';
      const label =
        c.status === 'captcha_blocked'
          ? `${esc(c.carrierName)}: captcha (${esc(c.captchaType || 'unknown')})`
          : `${esc(c.carrierName)}: ${esc(c.status)}`;
      return `<span class="flag ${cls}">${label}</span>`;
    })
    .join(' ');
  meta.innerHTML =
    `<code>${esc(data.outputFolder)}</code><br>${carrierBadges}` +
    (markup.pct || markup.flat ? ` · Markup +${markup.pct}% +${markup.flat}` : '');

  // Combine all ranked rates across carriers, re-sort by freight_total
  const all = [];
  for (const c of data.carriers) {
    if (c.status !== 'ok') continue;
    for (const r of c.ranked) {
      all.push({ ...r, carrierName: c.carrierName, carrierCode: c.carrierCode });
    }
  }
  all.sort((a, b) => a.freight_total - b.freight_total);

  if (all.length === 0) {
    table.innerHTML =
      '<tbody><tr><td class="empty">No rates returned. Check carrier sessions or try again.</td></tr></tbody>';
  } else {
    const showMarkup = markup.pct !== 0 || markup.flat !== 0;
    const thead = `<thead><tr>
      <th>Rank</th>
      <th>Carrier</th>
      <th>Sailing</th>
      <th>Transit</th>
      <th>Det/Dem free</th>
      <th>Vessel/voyage</th>
      <th>Service</th>
      ${showMarkup ? '<th>Your price</th>' : '<th>Cost</th>'}
      <th>Flags</th>
    </tr></thead>`;
    const lowest = all[0].freight_total;
    const rows = all
      .map((r, idx) => {
        const flags = [];
        if (r.rollable) flags.push('<span class="flag rollable">Rollable</span>');
        if (idx > 0) {
          const pct = ((r.freight_total - lowest) / lowest) * 100;
          if (pct <= 3) flags.push('<span class="flag close">≈ lowest</span>');
        }
        const transit = r.transit_days != null ? `${r.transit_days}d` : '—';
        const dnd =
          r.detention_freetime_days != null || r.demurrage_freetime_days != null
            ? `${r.detention_freetime_days ?? '?'}d / ${r.demurrage_freetime_days ?? '?'}d`
            : '—';
        const cost = r.freight_total;
        const currency = r.freight_currency ?? '';
        const displayPrice = showMarkup ? applyMarkup(cost, markup) : cost;
        const priceStr = `${currency} ${displayPrice.toLocaleString()}`;
        return `<tr>
          <td class="rank">#${idx + 1}</td>
          <td><strong>${esc(r.carrierName)}</strong></td>
          <td>${esc(r.sailing_date ?? '—')}</td>
          <td>${transit}</td>
          <td>${esc(dnd)}</td>
          <td>${esc(r.vessel_voyage ?? '—')}</td>
          <td>${esc(r.service_name)}</td>
          <td class="price ${showMarkup ? 'your-price' : ''}">${esc(priceStr)}</td>
          <td>${flags.join('') || '—'}</td>
        </tr>`;
      })
      .join('');
    table.innerHTML = thead + '<tbody>' + rows + '</tbody>';
  }

  // Email
  const emailTextarea = document.getElementById('reply-text');
  if (data.generatedEmail) {
    emailTextarea.value = data.generatedEmail;
    emailTextarea.hidden = false;
    document.getElementById('reply-copy-btn').hidden = false;
  } else {
    emailTextarea.value = '';
    emailTextarea.hidden = true;
  }
}

function renderResults(input, data) {
  const card = document.getElementById('results-card');
  const title = document.getElementById('results-title');
  const meta = document.getElementById('results-meta');
  const table = document.getElementById('results-table');
  card.hidden = false;

  const markup = getMarkup();
  const markupLabel =
    markup.pct || markup.flat
      ? `Markup: +${markup.pct}% / +${markup.flat.toLocaleString()} USD`
      : 'Markup: none';

  title.textContent = `Quote #${data.quoteId}: ${input.from} → ${input.to} (${input.container})`;
  meta.innerHTML = `${data.ranked.length} rates · ${esc(markupLabel)} · <a href="file:///${data.artifacts.screenshot.replace(/\\/g, '/')}" target="_blank" rel="noopener">screenshot</a>`;

  const showMarkup = markup.pct !== 0 || markup.flat !== 0;

  const thead = `<thead>
    <tr>
      <th>Rank</th>
      <th>Sailing</th>
      <th>Transit</th>
      <th>Det/Dem free</th>
      <th>Vessel / voyage</th>
      <th>Service</th>
      <th>Freight (our cost)</th>
      ${showMarkup ? '<th>Your price</th>' : ''}
      <th>Δ vs #1</th>
      <th>Flags</th>
      <th></th>
    </tr>
  </thead>`;

  const colCount = 10 + (showMarkup ? 1 : 0);
  if (data.ranked.length === 0) {
    table.innerHTML =
      thead +
      `<tbody><tr><td colspan="${colCount}" class="empty">No rates with prices were parsed.</td></tr></tbody>`;
    return;
  }

  const rows = data.ranked
    .map((r, idx) => {
      const flags = [];
      if (r.rollable) flags.push('<span class="flag rollable">Rollable</span>');
      if (r.close_to_lowest) flags.push('<span class="flag close">≈ lowest</span>');
      if (r.headline_mismatch) flags.push('<span class="flag mismatch">! mismatch</span>');
      const delta =
        r.rank === 1
          ? '—'
          : `+${Math.round(r.delta_from_lowest)} (+${r.delta_pct.toFixed(1)}%)`;
      const transit = r.transit_days != null ? `${r.transit_days}d` : '—';
      const dnd =
        r.detention_freetime_days != null || r.demurrage_freetime_days != null
          ? `${r.detention_freetime_days ?? '?'}d / ${r.demurrage_freetime_days ?? '?'}d`
          : '—';
      const cost = r.freight_total ?? r.headline_price_amount ?? 0;
      const currency = r.freight_currency ?? r.headline_price_currency ?? '';
      const costStr = `${currency} ${cost.toLocaleString()}`;
      const yourPrice = showMarkup ? applyMarkup(cost, markup) : null;
      const yourPriceStr = yourPrice != null ? `${currency} ${yourPrice.toLocaleString()}` : '';
      const hasBreakdown =
        (r.freight_charges?.length ?? 0) > 0 ||
        (r.destination_charges?.length ?? 0) > 0;
      const expandBtn = hasBreakdown
        ? `<button class="link-btn" data-expand="${idx}">+ breakdown</button>`
        : '';

      const breakdownRow = hasBreakdown
        ? `<tr class="breakdown-row" id="bd-${idx}" hidden>
             <td colspan="${colCount}">${renderBreakdown(r)}</td>
           </tr>`
        : '';

      return `<tr>
        <td class="rank">#${r.rank}</td>
        <td>${esc(r.sailing_date ?? '—')}</td>
        <td>${transit}</td>
        <td>${esc(dnd)}</td>
        <td>${esc(r.vessel_voyage ?? '—')}</td>
        <td>${esc(r.service_name)}</td>
        <td class="price">${esc(costStr)}</td>
        ${showMarkup ? `<td class="price your-price">${esc(yourPriceStr)}</td>` : ''}
        <td>${delta}</td>
        <td>${flags.join('') || '—'}</td>
        <td>${expandBtn}</td>
      </tr>${breakdownRow}`;
    })
    .join('');
  table.innerHTML = thead + '<tbody>' + rows + '</tbody>';

  // Wire expand buttons
  table.querySelectorAll('button[data-expand]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = 'bd-' + btn.dataset.expand;
      const row = document.getElementById(id);
      row.hidden = !row.hidden;
      btn.textContent = row.hidden ? '+ breakdown' : '− breakdown';
    });
  });
}

function renderBreakdown(r) {
  const lines = [];
  if (r.freight_charges?.length) {
    lines.push('<div class="bd-title">Freight charges (your cost)</div>');
    lines.push('<table class="bd-mini">');
    for (const c of r.freight_charges) {
      lines.push(
        `<tr><td>${esc(c.name)}</td><td class="price">${esc(c.currency)} ${c.total.toFixed(2)}</td></tr>`
      );
    }
    lines.push(
      `<tr class="bd-total"><td>Total</td><td class="price">${esc(r.freight_currency ?? '')} ${r.freight_total.toLocaleString()}</td></tr>`
    );
    lines.push('</table>');
  }
  if (r.destination_charges?.length) {
    lines.push('<div class="bd-title">Destination charges (paid by receiver, on collect)</div>');
    lines.push('<table class="bd-mini">');
    for (const c of r.destination_charges) {
      lines.push(
        `<tr><td>${esc(c.name)}</td><td class="price">${esc(c.currency)} ${c.total.toFixed(2)}</td></tr>`
      );
    }
    if (r.destination_currency) {
      lines.push(
        `<tr class="bd-total"><td>Total</td><td class="price">${esc(r.destination_currency)} ${r.destination_total.toLocaleString()}</td></tr>`
      );
    }
    lines.push('</table>');
  }
  return lines.join('');
}

async function loadHistory() {
  const table = document.getElementById('history-table');
  table.innerHTML = '<tbody><tr><td class="empty">Loading…</td></tr></tbody>';
  try {
    const r = await fetch('/api/quotes');
    const data = await r.json();
    const thead = '<thead><tr><th>ID</th><th>Created</th><th>Lane</th><th>Container</th></tr></thead>';
    if (data.quotes.length === 0) {
      table.innerHTML = thead + '<tbody><tr><td colspan="4" class="empty">No quotes yet. Run one from the "New quote" tab.</td></tr></tbody>';
      return;
    }
    const rows = data.quotes
      .map((q) => {
        const created = new Date(q.createdAt).toISOString().slice(0, 16).replace('T', ' ');
        return `<tr class="clickable" data-id="${q.id}">
          <td class="rank">#${q.id}</td>
          <td>${created}</td>
          <td>${esc(q.origin)} → ${esc(q.destination)}</td>
          <td>${esc(q.containerType)}</td>
        </tr>`;
      })
      .join('');
    table.innerHTML = thead + '<tbody>' + rows + '</tbody>';
    table.querySelectorAll('tr.clickable').forEach((row) => {
      row.addEventListener('click', () => loadQuote(row.dataset.id));
    });
  } catch (err) {
    table.innerHTML = `<tbody><tr><td class="empty">Error: ${esc(err.message)}</td></tr></tbody>`;
  }
}

async function loadQuote(id) {
  const card = document.getElementById('quote-detail-card');
  const title = document.getElementById('quote-detail-title');
  const meta = document.getElementById('quote-detail-meta');
  const table = document.getElementById('quote-detail-table');
  card.hidden = false;
  meta.textContent = 'Loading…';
  try {
    const r = await fetch(`/api/quotes/${id}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load');

    const q = data.quote;
    title.textContent = `Quote #${q.id}: ${q.origin} → ${q.destination}`;
    const created = new Date(q.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    meta.textContent = `${q.containerType} · requested ${q.requestedDate} · created ${created}`;

    const markup = getMarkup();
    const detailPdfBtn = document.getElementById('quote-detail-pdf-btn');
    detailPdfBtn.href = `/api/quotes/${q.id}/pdf?pct=${markup.pct}&flat=${markup.flat}`;
    detailPdfBtn.setAttribute('download', `quote-${q.id}.pdf`);
    detailPdfBtn.hidden = false;

    const thead = '<thead><tr><th>Rank</th><th>Sailing</th><th>Service</th><th>Transit</th><th>Price</th></tr></thead>';
    const snaps = data.rateSnapshots;
    if (snaps.length === 0) {
      table.innerHTML = thead + '<tbody><tr><td colspan="5" class="empty">No rates saved.</td></tr></tbody>';
    } else {
      const rows = snaps
        .map((s) => {
          const price = `${s.currency} ${(s.totalCostCents / 100).toFixed(2)}`;
          const transit = s.transitDays != null ? `${s.transitDays}d` : '—';
          return `<tr>
            <td class="rank">#${s.rank ?? '—'}</td>
            <td>${esc(s.sailingDate ?? '—')}</td>
            <td>${esc(s.serviceName)}</td>
            <td>${transit}</td>
            <td class="price">${esc(price)}</td>
          </tr>`;
        })
        .join('');
      table.innerHTML = thead + '<tbody>' + rows + '</tbody>';
    }
    window.scrollTo({ top: card.offsetTop - 20, behavior: 'smooth' });
  } catch (err) {
    meta.textContent = 'Error: ' + err.message;
    table.innerHTML = '';
  }
}

// ---- Agent tab ----
document.getElementById('agent-run-btn').addEventListener('click', async () => {
  const url = document.getElementById('agent-url').value.trim();
  const goal = document.getElementById('agent-goal').value.trim();
  const maxIter = parseInt(document.getElementById('agent-max-iter').value, 10) || 25;
  if (!url || !goal) {
    setStatus('agent-status', 'Fill both URL and goal.', 'error');
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    setStatus('agent-status', 'URL must start with http:// or https://', 'error');
    return;
  }

  const btn = document.getElementById('agent-run-btn');
  btn.disabled = true;
  setStatus('agent-status', 'Running agent — a Chrome window will open. This can take a minute…', 'info');

  const card = document.getElementById('agent-transcript-card');
  const list = document.getElementById('agent-transcript');
  card.hidden = false;
  list.innerHTML = '<li class="muted">Running…</li>';

  try {
    const r = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, goal, maxIterations: maxIter }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Agent failed');

    renderAgentResult(data);
    setStatus(
      'agent-status',
      data.finished ? 'Task complete.' : `Stopped: ${data.finishReason}`,
      data.finished ? 'success' : 'info'
    );
  } catch (err) {
    setStatus('agent-status', err.message, 'error');
    list.innerHTML = `<li class="result err">Error: ${esc(err.message)}</li>`;
  } finally {
    btn.disabled = false;
  }
});

function renderAgentResult(data) {
  const list = document.getElementById('agent-transcript');
  const title = document.getElementById('agent-transcript-title');
  const meta = document.getElementById('agent-transcript-meta');
  title.textContent = data.finished ? 'Transcript — finished' : 'Transcript — stopped';
  meta.textContent = `${data.steps.length} step(s) · start ${data.startUrl} · final ${data.finalUrl}`;

  list.innerHTML = data.steps
    .map((s) => {
      let resultClass = 'result';
      if (s.result.startsWith('BLOCKED')) resultClass += ' blocked';
      else if (!s.ok) resultClass += ' err';
      const argsStr = Object.entries(s.args)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ');
      return `<li>
        <span class="action">${esc(s.action)}</span>
        <span class="muted">${esc(argsStr)}</span>
        <br>
        <span class="${resultClass}">→ ${esc(s.result)}</span>
      </li>`;
    })
    .join('');
}

// ---- Record tab ----
let activeRecordingId = null;
let recordingPollHandle = null;

async function loadRecCarrierDropdown() {
  const targets = [
    document.getElementById('rec-carrier'),
    document.getElementById('rec-upload-carrier'),
  ].filter(Boolean);
  try {
    const r = await fetch('/api/carriers');
    const data = await r.json();
    const html =
      '<option value="">(none — save under _recordings)</option>' +
      data.carriers
        .map((c) => `<option value="${c.code}">${esc(c.name)} (${c.code})</option>`)
        .join('');
    for (const sel of targets) sel.innerHTML = html;
  } catch {
    for (const sel of targets) {
      sel.innerHTML = '<option value="">(error loading carriers)</option>';
    }
  }
}
loadRecCarrierDropdown();

document.getElementById('rec-upload-btn').addEventListener('click', async () => {
  const fileInput = document.getElementById('rec-upload-file');
  const carrier = document.getElementById('rec-upload-carrier').value || undefined;
  const description =
    document.getElementById('rec-upload-description').value.trim() || undefined;
  const btn = document.getElementById('rec-upload-btn');

  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    setStatus('rec-upload-status', 'Pick a recording file first.', 'error');
    return;
  }

  setStatus('rec-upload-status', 'Reading file…', 'info');
  btn.disabled = true;
  document.getElementById('rec-analysis-card').hidden = true;

  try {
    const content = await file.text();
    if (!content.trim()) throw new Error('File is empty.');
    setStatus('rec-upload-status', 'Sending to Claude for analysis…', 'info');
    const r = await fetch('/api/record/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        filename: file.name,
        carrierCode: carrier,
        description,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Upload failed');
    setStatus('rec-upload-status', 'Analysis complete.', 'success');
    renderAnalysis(data.meta, data.analysis);
    fileInput.value = '';
    loadRecList();
  } catch (err) {
    setStatus('rec-upload-status', err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('rec-start-btn').addEventListener('click', async () => {
  const url = document.getElementById('rec-url').value.trim();
  const carrier = document.getElementById('rec-carrier').value || undefined;
  const description = document.getElementById('rec-description').value.trim() || undefined;

  if (!url) {
    setStatus('rec-status', 'Paste a URL first.', 'error');
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    setStatus('rec-status', 'URL must start with http:// or https://', 'error');
    return;
  }

  setStatus('rec-status', 'Launching recorder…', 'info');
  document.getElementById('rec-start-btn').disabled = true;
  document.getElementById('rec-analysis-card').hidden = true;

  try {
    const r = await fetch('/api/record/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, carrierCode: carrier, description }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Could not start recording');

    activeRecordingId = data.id;
    document.getElementById('rec-active-card').hidden = false;
    document.getElementById('rec-active-meta').innerHTML =
      `Recording <code>${esc(data.id.slice(0, 8))}</code> · started ${new Date(data.startedAt).toLocaleTimeString()} · saving to <code>${esc(data.outFile)}</code>`;
    document.getElementById('rec-stop-btn').hidden = false;
    setStatus('rec-status', 'Recording started — do your workflow in the browser window.', 'info');

    pollRecording();
  } catch (err) {
    setStatus('rec-status', err.message, 'error');
    document.getElementById('rec-start-btn').disabled = false;
  }
});

document.getElementById('rec-stop-btn').addEventListener('click', async () => {
  if (!activeRecordingId) return;
  if (!confirm('Cancel the recording? Any captured actions will be discarded.')) return;
  await fetch(`/api/record/stop/${activeRecordingId}`, { method: 'POST' });
  finishRecordingUi('Cancelled.');
});

document.getElementById('rec-refresh-btn').addEventListener('click', loadRecList);

async function pollRecording() {
  if (!activeRecordingId) return;
  if (recordingPollHandle) clearInterval(recordingPollHandle);
  recordingPollHandle = setInterval(async () => {
    if (!activeRecordingId) {
      clearInterval(recordingPollHandle);
      return;
    }
    try {
      const r = await fetch(`/api/record/status/${activeRecordingId}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'status check failed');
      if (data.status === 'running') return; // still recording

      // Recording finished — analyze.
      clearInterval(recordingPollHandle);
      const id = activeRecordingId;
      setStatus('rec-status', 'Browser closed. Sending to Claude for analysis…', 'info');
      try {
        const ar = await fetch(`/api/record/analyze/${id}`, { method: 'POST' });
        const adata = await ar.json();
        if (!ar.ok) throw new Error(adata.error || 'analysis failed');
        finishRecordingUi('Analysis complete.');
        renderAnalysis(adata.meta, adata.analysis);
        loadRecList();
      } catch (err) {
        finishRecordingUi('Analyze failed: ' + err.message);
        setStatus('rec-status', err.message, 'error');
      }
    } catch (err) {
      clearInterval(recordingPollHandle);
      setStatus('rec-status', err.message, 'error');
    }
  }, 2000);
}

function finishRecordingUi(msg) {
  activeRecordingId = null;
  if (recordingPollHandle) {
    clearInterval(recordingPollHandle);
    recordingPollHandle = null;
  }
  document.getElementById('rec-active-card').hidden = true;
  document.getElementById('rec-stop-btn').hidden = true;
  document.getElementById('rec-start-btn').disabled = false;
  if (msg) setStatus('rec-status', msg, 'success');
}

function renderAnalysis(meta, a) {
  const card = document.getElementById('rec-analysis-card');
  const title = document.getElementById('rec-analysis-title');
  const metaEl = document.getElementById('rec-analysis-meta');
  const body = document.getElementById('rec-analysis-body');
  card.hidden = false;
  title.textContent = a.summary;
  metaEl.innerHTML =
    `<code>${esc(a.starting_url)}</code> · ` +
    (meta.carrierCode ? `carrier <code>${esc(meta.carrierCode)}</code> · ` : '') +
    `<span class="confidence-${a.readiness.status === 'ready_to_replay' ? 'high' : 'medium'}">${esc(a.readiness.status)}</span> — ${esc(a.readiness.reason)}` +
    ` · saved to <code>${esc(a.saved_to)}</code>`;

  let html = '<h3 class="bd-title">Steps</h3><ol class="rec-steps">';
  for (const s of a.steps) {
    html += `<li><div class="rec-step-desc">${esc(s.description)}</div><pre class="rec-step-code">${esc(s.playwright_call)}</pre></li>`;
  }
  html += '</ol>';

  if (a.parameters && a.parameters.length > 0) {
    html += '<h3 class="bd-title">Parameters (inputs you change per run)</h3>';
    html += '<table class="bd-mini" style="min-width:520px">';
    html += '<tr><th align="left">Name</th><th align="left">Description</th><th align="left">Example</th><th>Step</th></tr>';
    for (const p of a.parameters) {
      html += `<tr><td><code>${esc(p.name)}</code></td><td>${esc(p.description)}</td><td>${esc(p.example_value)}</td><td>#${p.step_number}</td></tr>`;
    }
    html += '</table>';
  }
  body.innerHTML = html;
  card.scrollIntoView({ behavior: 'smooth' });
}

async function loadRecList() {
  const table = document.getElementById('rec-list-table');
  table.innerHTML = '<tbody><tr><td class="empty">Loading…</td></tr></tbody>';
  try {
    const r = await fetch('/api/record/list');
    const data = await r.json();
    if (!data.recordings || data.recordings.length === 0) {
      table.innerHTML = '<tbody><tr><td class="empty">No recordings yet.</td></tr></tbody>';
      return;
    }
    const thead = '<thead><tr><th>Started</th><th>URL</th><th>Carrier</th><th>Status</th><th>File</th></tr></thead>';
    const rows = data.recordings
      .map((r) => {
        const started = new Date(r.startedAt).toISOString().slice(0, 16).replace('T', ' ');
        const statusCls = r.status === 'finished' ? 'success' : r.status === 'failed' ? 'error' : 'info';
        return `<tr>
          <td>${esc(started)}</td>
          <td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url.slice(0, 50))}</a></td>
          <td>${esc(r.carrierCode || '—')}</td>
          <td><span class="status-inline ${statusCls}">${esc(r.status)}</span></td>
          <td><code class="muted small">${esc(r.outFile.split(/[\\/]/).slice(-2).join('/'))}</code></td>
        </tr>`;
      })
      .join('');
    table.innerHTML = thead + '<tbody>' + rows + '</tbody>';
  } catch (err) {
    table.innerHTML = `<tbody><tr><td class="empty">Error: ${esc(err.message)}</td></tr></tbody>`;
  }
}
loadRecList();

// ---- Secrets tab ----
async function loadCredCarrierDropdown() {
  const sel = document.getElementById('cred-carrier');
  if (!sel) return;
  try {
    const r = await fetch('/api/carriers');
    const data = await r.json();
    sel.innerHTML = data.carriers
      .map((c) => `<option value="${c.code}">${esc(c.name)} (${c.code})</option>`)
      .join('');
  } catch {
    sel.innerHTML = '<option value="">(error loading carriers)</option>';
  }
}

async function loadCredList() {
  const table = document.getElementById('cred-list-table');
  if (!table) return;
  table.innerHTML = '<tbody><tr><td class="empty">Loading…</td></tr></tbody>';
  try {
    const r = await fetch('/api/credentials');
    const data = await r.json();
    if (!data.credentials || data.credentials.length === 0) {
      table.innerHTML =
        '<tbody><tr><td class="empty">No credentials stored yet.</td></tr></tbody>';
      return;
    }
    const thead =
      '<thead><tr><th>Carrier</th><th>Username</th><th>Password</th><th>Notes</th><th>Updated</th><th></th></tr></thead>';
    const rows = data.credentials
      .map((c) => {
        const updated = new Date(c.updatedAt).toISOString().slice(0, 16).replace('T', ' ');
        return `<tr data-carrier="${esc(c.carrierCode)}">
          <td><code>${esc(c.carrierCode)}</code></td>
          <td>${esc(c.username)}</td>
          <td>
            <span class="cred-pw-mask">••••••••</span>
            <span class="cred-pw-clear" hidden></span>
            <button class="btn-sm cred-reveal-btn">Reveal</button>
            <button class="btn-sm cred-copy-btn" hidden>Copy</button>
          </td>
          <td>${esc(c.notes || '')}</td>
          <td><span class="muted small">${esc(updated)}</span></td>
          <td><button class="link-btn cred-delete-btn">Delete</button></td>
        </tr>`;
      })
      .join('');
    table.innerHTML = thead + '<tbody>' + rows + '</tbody>';
  } catch (err) {
    table.innerHTML = `<tbody><tr><td class="empty">Error: ${esc(err.message)}</td></tr></tbody>`;
  }
}

(function wireSecretsTab() {
  const saveBtn = document.getElementById('cred-save-btn');
  const refreshBtn = document.getElementById('cred-refresh-btn');
  const table = document.getElementById('cred-list-table');
  if (!saveBtn || !refreshBtn || !table) return;

  loadCredCarrierDropdown();
  loadCredList();

  saveBtn.addEventListener('click', async () => {
    const carrierCode = document.getElementById('cred-carrier').value;
    const username = document.getElementById('cred-username').value.trim();
    const password = document.getElementById('cred-password').value;
    const notes = document.getElementById('cred-notes').value.trim();
    if (!carrierCode) {
      setStatus('cred-status', 'Pick a carrier.', 'error');
      return;
    }
    if (!username || !password) {
      setStatus('cred-status', 'Username and password are required.', 'error');
      return;
    }
    setStatus('cred-status', 'Saving…', 'info');
    saveBtn.disabled = true;
    try {
      const r = await fetch(`/api/credentials/${encodeURIComponent(carrierCode)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, notes: notes || undefined }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Save failed');
      setStatus('cred-status', `Saved ${data.carrierCode}.`, 'success');
      document.getElementById('cred-password').value = '';
      loadCredList();
    } catch (err) {
      setStatus('cred-status', err.message, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });

  refreshBtn.addEventListener('click', loadCredList);

  table.addEventListener('click', async (e) => {
    const row = e.target.closest('tr[data-carrier]');
    if (!row) return;
    const carrierCode = row.getAttribute('data-carrier');

    if (e.target.classList.contains('cred-reveal-btn')) {
      try {
        const r = await fetch(
          `/api/credentials/${encodeURIComponent(carrierCode)}/reveal`
        );
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Reveal failed');
        const mask = row.querySelector('.cred-pw-mask');
        const clear = row.querySelector('.cred-pw-clear');
        const copyBtn = row.querySelector('.cred-copy-btn');
        mask.hidden = true;
        clear.hidden = false;
        clear.textContent = data.password;
        copyBtn.hidden = false;
        e.target.textContent = 'Hide';
        e.target.classList.remove('cred-reveal-btn');
        e.target.classList.add('cred-hide-btn');
      } catch (err) {
        alert(err.message);
      }
      return;
    }

    if (e.target.classList.contains('cred-hide-btn')) {
      const mask = row.querySelector('.cred-pw-mask');
      const clear = row.querySelector('.cred-pw-clear');
      const copyBtn = row.querySelector('.cred-copy-btn');
      mask.hidden = false;
      clear.hidden = true;
      clear.textContent = '';
      copyBtn.hidden = true;
      e.target.textContent = 'Reveal';
      e.target.classList.remove('cred-hide-btn');
      e.target.classList.add('cred-reveal-btn');
      return;
    }

    if (e.target.classList.contains('cred-copy-btn')) {
      const clear = row.querySelector('.cred-pw-clear');
      try {
        await navigator.clipboard.writeText(clear.textContent || '');
        e.target.textContent = 'Copied!';
        setTimeout(() => (e.target.textContent = 'Copy'), 1500);
      } catch {
        alert('Clipboard write failed — select & copy manually.');
      }
      return;
    }

    if (e.target.classList.contains('cred-delete-btn')) {
      if (!confirm(`Delete stored credential for ${carrierCode}?`)) return;
      try {
        const r = await fetch(
          `/api/credentials/${encodeURIComponent(carrierCode)}`,
          { method: 'DELETE' }
        );
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Delete failed');
        loadCredList();
      } catch (err) {
        alert(err.message);
      }
    }
  });
})();

function setStatus(elId, msg, type) {
  const el = document.getElementById(elId);
  el.className = 'status-inline ' + (type || '');
  el.textContent = msg;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
