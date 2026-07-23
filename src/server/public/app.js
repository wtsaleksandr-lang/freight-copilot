// ---------- Toast notifications (lightweight, non-blocking) ----------
// Replaces blocking alert() with auto-dismissing toasts in the
// bottom-right corner. window.toast(message, kind) where kind is one
// of 'info' | 'success' | 'error'. Stays alert()-compatible: if a
// toast can't render (DOM not ready), falls back to alert.
(function installToastSystem() {
  if (window.toast) return;
  function getStack() {
    let stack = document.getElementById('toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'toast-stack';
      stack.className = 'toast-stack';
      document.body.appendChild(stack);
    }
    return stack;
  }
  window.toast = function (message, kind = 'info', timeoutMs = 5000) {
    try {
      const stack = getStack();
      const t = document.createElement('div');
      t.className = `toast toast-${kind}`;
      t.innerHTML = `<span class="toast-msg"></span><button type="button" class="toast-close" title="Dismiss">✕</button>`;
      t.querySelector('.toast-msg').textContent = message;
      stack.appendChild(t);
      const close = () => { t.classList.add('is-out'); setTimeout(() => t.remove(), 240); };
      t.querySelector('.toast-close').addEventListener('click', close);
      if (timeoutMs > 0) setTimeout(close, timeoutMs);
      // Stack overflow guard — keep at most 6 toasts visible.
      while (stack.children.length > 6) stack.firstChild?.remove();
    } catch {
      try { alert(message); } catch (_) { /* nothing left to do */ }
    }
  };
})();

// ---------- PWA: register service worker so Chrome offers "Install" ----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .catch((err) => console.warn('[sw] register failed:', err));
  });
}

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

// Tab switching — accepts both nav .tab buttons AND .footer-tab-link <a>
// elements so Tools (Record / Agent / Bundles / Secrets) can be reached
// from the footer without taking up nav real estate.
function activateTabBy(name) {
  document
    .querySelectorAll('.tab')
    .forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document
    .querySelectorAll('.tab-pane')
    .forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'history') loadHistory();
  if (name === 'bundles') loadBundles();
  if (name === 'drayage') loadDrayageList();
  if (name === 'trucking') loadTruckingList();
  // Scroll to the top of the active pane so the user lands at the start
  // of the new content (esp. relevant when triggered from the footer).
  window.scrollTo({ top: 0, behavior: 'instant' });
}
// Tab activation persists the last-opened tab so refresh / restart
// drops the user back where they were.
const LAST_TAB_KEY = 'freight.lastTab';
const ORIGINAL_activateTabBy = activateTabBy;
// Wrap activateTabBy to also persist.
// eslint-disable-next-line no-func-assign
activateTabBy = function (name) {
  ORIGINAL_activateTabBy(name);
  try { localStorage.setItem(LAST_TAB_KEY, name); } catch (_) { /* private mode */ }
};
document.querySelectorAll('[data-tab]').forEach((el) => {
  el.addEventListener('click', (e) => {
    if (el.tagName === 'A') e.preventDefault();
    activateTabBy(el.dataset.tab);
  });
});

// Restore last tab on load. Top-level (header) tab keys only — footer
// links like "agent" / "record" are excluded so we don't accidentally
// pin them as the default after a one-off click.
const HEADER_TAB_KEYS = ['new', 'shipments', 'drayage', 'trucking', 'history', 'delaypredict'];
(function restoreLastTab() {
  try {
    const last = localStorage.getItem(LAST_TAB_KEY);
    if (last && HEADER_TAB_KEYS.includes(last)) {
      // Defer to next tick so any tab-specific init (loadDrayageList,
      // loadHistory, etc.) wires before activation runs them.
      setTimeout(() => activateTabBy(last), 0);
    }
  } catch (_) { /* ignore */ }
})();

// Keyboard shortcuts — Alt+1..5 jump between header tabs, ? shows
// help. Standard browser shortcuts (Cmd/Ctrl-based) are left alone.
document.addEventListener('keydown', (e) => {
  // Don't steal keys from form fields / contenteditable.
  const t = e.target;
  if (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  ) {
    return;
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const idx = ['1', '2', '3', '4', '5', '6'].indexOf(e.key);
    if (idx >= 0 && HEADER_TAB_KEYS[idx]) {
      e.preventDefault();
      activateTabBy(HEADER_TAB_KEYS[idx]);
    }
  } else if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    showShortcutsHelp();
  }
});

// Make the help button (top-right, "?") open the same overlay as the
// keyboard shortcut. tabIndex/active class would be inherited from the
// .tab styling but we don't want it to steal the active state.
document.getElementById('help-btn')?.addEventListener('click', (e) => {
  e.preventDefault();
  showShortcutsHelp();
});

function showShortcutsHelp() {
  document.querySelectorAll('.shortcuts-help-overlay').forEach((n) => n.remove());
  const o = document.createElement('div');
  o.className = 'shortcuts-help-overlay';
  o.innerHTML = `
    <div class="shortcuts-help-backdrop"></div>
    <div class="shortcuts-help-frame">
      <div class="shortcuts-help-toolbar">
        <strong>Keyboard shortcuts</strong>
        <span style="flex:1"></span>
        <button type="button" class="shortcuts-help-close" title="Close (Esc)">✕</button>
      </div>
      <div class="shortcuts-help-body">
        <h4>Navigation</h4>
        <kbd>Alt</kbd> + <kbd>1</kbd> Ocean tab<br>
        <kbd>Alt</kbd> + <kbd>2</kbd> Shipments tab<br>
        <kbd>Alt</kbd> + <kbd>3</kbd> Drayage tab<br>
        <kbd>Alt</kbd> + <kbd>4</kbd> Trucking tab<br>
        <kbd>Alt</kbd> + <kbd>5</kbd> History tab<br>
        <kbd>Alt</kbd> + <kbd>6</kbd> DelayPredict tab<br>
        <kbd>?</kbd> show this help
        <h4>Shipments</h4>
        <kbd>Click</kbd> Ref → copy to clipboard<br>
        <kbd>Click</kbd> any cell → make it the active cell<br>
        <kbd>Cmd/Ctrl</kbd> + <kbd>C</kbd> copy active cell<br>
        <kbd>Right-click</kbd> any cell → Copy cell / row<br>
        <kbd>Click</kbd> status → pick a new status<br>
        <kbd>Double-click</kbd> a cell → inline edit<br>
        <kbd>Drag</kbd> a column edge → resize the column
        <h4>Cost / Sell panel</h4>
        <kbd>Click</kbd> a line → edit name + amount + ×N multiply<br>
        <kbd>Esc</kbd> close panel / cancel edit
        <h4>Modals</h4>
        <kbd>Esc</kbd> close (preview, attachments, clarify)
      </div>
    </div>
  `;
  document.body.appendChild(o);
  function close() {
    o.remove();
    document.removeEventListener('keydown', onKey, true);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  o.querySelector('.shortcuts-help-close').addEventListener('click', close);
  o.querySelector('.shortcuts-help-backdrop').addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
}

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

  // (pickup/delivery dates, special equipment, accessorials, client,
  // notes — all removed from the form; nothing to populate.)

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

// Clear button — wipes the calculator form back to defaults.
document.getElementById('dr-clear-btn')?.addEventListener('click', () => {
  document.getElementById('dr-cargo-type').value = 'general';
  document.getElementById('dr-container').value = '40 Dry High';
  document.getElementById('dr-weight').value = '10000';
  // Reset radios + endpoint fields
  const setRadio = (name, val) => {
    const el = document.querySelector(`input[name="${name}"][value="${val}"]`);
    if (el) {
      el.checked = true;
      el.dispatchEvent(new Event('change'));
    }
  };
  setRadio('dr-origin-type', 'CY');
  setRadio('dr-destination-type', 'DOOR');
  ['dr-origin-port-code', 'dr-origin-port-name', 'dr-origin-terminal',
   'dr-origin-address', 'dr-origin-city', 'dr-origin-state', 'dr-origin-zip',
   'dr-destination-port-code', 'dr-destination-port-name', 'dr-destination-terminal',
   'dr-destination-address', 'dr-destination-city', 'dr-destination-state', 'dr-destination-zip',
   'dr-intake-text']
    .forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  setStatus('dr-status', 'Form cleared.', 'info');
  // Also wipe the matches table.
  renderDrayageMatches([]);
  document.getElementById('dr-matches-count').textContent = '— click Run after editing the form';
});

// Run button — query the rate library by form fields, render matches.
document.getElementById('dr-run-btn').addEventListener('click', async () => {
  await runDrayageMatchSearch();
});
document.getElementById('dr-matches-refresh')?.addEventListener('click', async () => {
  await runDrayageMatchSearch();
});

// ---- Match-search helpers -------------------------------------------
// Build a rate-library query string from the current calculator form.
// We use city/state/port fields as the "from"/"to" partial match and
// the container type as the exact-match `cntr`. Empty fields are
// skipped so the query degrades gracefully.
function drayageMatchParams() {
  const params = new URLSearchParams();
  const originType = document.querySelector('input[name="dr-origin-type"]:checked')?.value;
  const destType = document.querySelector('input[name="dr-destination-type"]:checked')?.value;
  const fromBits =
    originType === 'CY'
      ? [
          document.getElementById('dr-origin-port-code').value.trim(),
          document.getElementById('dr-origin-port-name').value.trim(),
        ]
      : [
          document.getElementById('dr-origin-city').value.trim(),
          document.getElementById('dr-origin-state').value.trim(),
          document.getElementById('dr-origin-zip').value.trim(),
        ];
  const toBits =
    destType === 'CY'
      ? [
          document.getElementById('dr-destination-port-code').value.trim(),
          document.getElementById('dr-destination-port-name').value.trim(),
        ]
      : [
          document.getElementById('dr-destination-city').value.trim(),
          document.getElementById('dr-destination-state').value.trim(),
          document.getElementById('dr-destination-zip').value.trim(),
        ];
  const from = fromBits.filter(Boolean).join(' ').trim();
  const to = toBits.filter(Boolean).join(' ').trim();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  // Translate the calculator's friendly label to a rate-library code.
  const cntrLabel = document.getElementById('dr-container').value;
  const cntrCode = drayageContainerLabelToCode(cntrLabel);
  if (cntrCode) params.set('cntr', cntrCode);
  return { params, from, to, cntrCode };
}

function drayageContainerLabelToCode(label) {
  const map = {
    '20 Dry Standard': '20GP',
    '40 Dry Standard': '40GP',
    '40 Dry High': '40HC',
    '20 Reefer': '20RF',
    '40 Reefer': '40RF',
    '40 Reefer High Cube': '40RH',
    '20 Open Top': '20OT',
    '40 Open Top': '40OT',
    '20 Flat Rack': '20FR',
    '40 Flat Rack': '40FR',
    '20 Tank': '20TK',
    '40 NOR (Non-Operating Reefer)': '40NOR',
  };
  return map[label] || '';
}

window.runDrayageMatchSearch = runDrayageMatchSearch;
async function runDrayageMatchSearch() {
  const { params, from, to, cntrCode } = drayageMatchParams();
  const summaryBits = [];
  if (from) summaryBits.push(`from "${from}"`);
  if (to) summaryBits.push(`to "${to}"`);
  if (cntrCode) summaryBits.push(`cntr ${cntrCode}`);
  const summary = summaryBits.length ? summaryBits.join(' · ') : 'all rates';
  setStatus('dr-status', `Searching library — ${summary}…`, 'info');
  try {
    const r = await fetch('/api/drayage-rate-library?' + params.toString());
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'search failed');
    const rates = data.rates || [];
    const cnt = document.getElementById('dr-matches-count');
    if (cnt) {
      cnt.textContent =
        rates.length > 0
          ? `— ${rates.length} match${rates.length === 1 ? '' : 'es'} (${summary})`
          : `— no matches (${summary})`;
    }
    renderDrayageMatches(rates);
    setStatus('dr-status', `${rates.length} matching rate(s).`, 'success');
  } catch (err) {
    setStatus('dr-status', err.message, 'error');
  }
}

function renderDrayageMatches(rates) {
  const table = document.getElementById('dr-matches-table');
  if (!table) return;
  if (rates.length === 0) {
    table.innerHTML =
      `<tbody><tr><td class="empty">No matching rates yet — refine the form fields and click Run, or upload more rate sheets above.</td></tr></tbody>`;
    return;
  }
  const head = `<thead><tr>
    <th>Rate date</th>
    <th>Pickup</th>
    <th>Delivery</th>
    <th>Miles</th>
    <th>Cntr</th>
    <th>Max wt (kg)</th>
    <th>Total rate</th>
    <th>Provider</th>
    <th>Uploaded</th>
  </tr></thead>`;
  const body = rates
    .map((r) => {
      const date = r.rateDate || '—';
      const uploaded = r.createdAt
        ? new Date(r.createdAt).toISOString().slice(0, 10)
        : '—';
      const total = r.totalRate != null ? formatMoney(r.totalRate, 'USD') : '—';
      const miles = r.totalMiles != null ? r.totalMiles : '—';
      const wt = r.maxWeightKg != null ? Math.round(r.maxWeightKg) : '—';
      return `<tr data-id="${r.id}">
        <td>${esc(date)}</td>
        <td title="${esc(r.pickupLabel || '')}">${esc(r.pickupLabel || '—')}</td>
        <td title="${esc(r.deliveryLabel || '')}">${esc(r.deliveryLabel || '—')}</td>
        <td>${esc(String(miles))}</td>
        <td>${esc(r.containerType || '—')}</td>
        <td>${esc(String(wt))}</td>
        <td class="cell-money">${esc(total)}</td>
        <td>${esc(r.providerName || '—')}</td>
        <td class="when-cell">${esc(uploaded)}</td>
      </tr>`;
    })
    .join('');
  table.innerHTML = head + `<tbody>${body}</tbody>`;
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
  // Special equipment / accessorials dropdowns were removed from the
  // calculator when it was simplified to a rate-library lookup form.
  // Function kept as a no-op so existing call sites still resolve.
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
    const [carriersResp, sessionsResp, probesResp] = await Promise.all([
      fetch('/api/carriers').then((r) => r.json()),
      fetch('/api/sessions').then((r) => r.json()),
      fetch('/api/sessions/probe')
        .then((r) => r.json())
        .catch(() => ({ probes: [] })),
    ]);
    const sessionByCode = Object.fromEntries(
      (sessionsResp.sessions || []).map((s) => [s.carrierCode, s])
    );
    const probeByCode = Object.fromEntries(
      (probesResp.probes || []).map((p) => [p.carrierCode, p])
    );

    const opts = carriersResp.carriers.map((c) => {
      const s = sessionByCode[c.code];
      const probe = probeByCode[c.code];
      let dotClass = 'status-missing';
      let label = 'no session';
      if (!c.isActive) {
        dotClass = 'status-onboarding';
        label = 'onboarding';
      } else if (probe) {
        // Real Chrome mode: live probe wins.
        if (probe.loggedIn) {
          const ageMin = Math.round(
            (Date.now() - new Date(probe.checkedAt).getTime()) / 60000
          );
          dotClass = 'status-fresh';
          label = `live · ${ageMin}m ago`;
        } else {
          dotClass = 'status-expired';
          label = 'logged out — re-login';
        }
      } else if (s?.status === 'fresh') {
        dotClass = 'status-fresh';
        label = `${s.daysLeft}d session`;
      } else if (s?.status === 'expiring') {
        dotClass = 'status-expiring';
        label = `${s.daysLeft}d left`;
      } else if (s?.status === 'expired') {
        dotClass = 'status-expired';
        label = 'expired — re-login';
      }
      const suffix =
        `<span class="status-dot ${dotClass}"></span>${esc(label)}`;
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

// "Re-check sessions now" — fires an on-demand probe of every carrier.
// Useful right after the user logs into a portal in Chrome (Freight
// Copilot); they don't have to wait the 10-min cycle to see green dots.
const recheckBtn = document.getElementById('recheck-sessions-btn');
if (recheckBtn) {
  recheckBtn.addEventListener('click', async () => {
    const status = document.getElementById('recheck-status');
    recheckBtn.disabled = true;
    if (status) status.textContent = 'probing all carriers (~20s)…';
    try {
      const r = await fetch('/api/sessions/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'probe failed');
      const okCount = (data.probes || []).filter((p) => p.loggedIn).length;
      if (status) {
        status.textContent = `${okCount}/${data.probes.length} logged in`;
      }
      // Refresh dropdown so badges update.
      await loadCarriers();
    } catch (err) {
      if (status) status.textContent = `error: ${err.message}`;
    } finally {
      recheckBtn.disabled = false;
    }
  });
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

  // Pre-bundle gate: if we have probe data, warn about carriers that are
  // logged out before the user spends 5 minutes waiting for them to time
  // out. Skipped if /api/sessions/probe has no data yet (e.g. just-started
  // server, bundled-Chromium mode).
  try {
    const probeResp = await fetch('/api/sessions/probe');
    if (probeResp.ok) {
      const { probes } = await probeResp.json();
      const probeByCode = Object.fromEntries(
        (probes || []).map((p) => [p.carrierCode, p])
      );
      const loggedOut = carriers.filter((c) => {
        const p = probeByCode[c];
        return p && !p.loggedIn;
      });
      if (loggedOut.length > 0) {
        const proceed = confirm(
          `${loggedOut.length} of ${carriers.length} selected carriers appear to be LOGGED OUT:\n\n` +
            loggedOut.map((c) => `  • ${c}`).join('\n') +
            `\n\nThese carriers will fail. Log in to them in your "Chrome (LoadMode)" window first, then click "Re-check sessions now".\n\nProceed anyway?`
        );
        if (!proceed) return;
      }
    }
  } catch {
    // probe unavailable — proceed without the gate
  }

  const btn = document.getElementById('run-btn');
  btn.disabled = true;
  setStatus(
    'run-status',
    `Running ${carriers.length} carrier(s) — Chrome will open per carrier. This takes ~${carriers.length * 60}s…`,
    'info'
  );

  // Client-generated refId so we can poll /api/bundle/:refId/progress
  // while the POST is still in flight.
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  const refId = `Q-${today}-${rand}`;
  body.refId = refId;

  // Seed UI list so the row appears immediately
  renderBundleProgress({
    status: 'running',
    carriers: carriers.map((code) => ({ code, name: code, stage: 'pending' })),
  });

  let pollHandle = null;
  const startPolling = () => {
    pollHandle = setInterval(async () => {
      try {
        const r = await fetch(`/api/bundle/${encodeURIComponent(refId)}/progress`);
        if (!r.ok) return; // expected during startup
        const entry = await r.json();
        renderBundleProgress(entry);
      } catch {
        // network blip — keep polling
      }
    }, 1500);
  };
  startPolling();

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
    if (pollHandle) clearInterval(pollHandle);
    // Final progress refresh so the UI reflects the terminal state.
    try {
      const r = await fetch(`/api/bundle/${encodeURIComponent(refId)}/progress`);
      if (r.ok) renderBundleProgress(await r.json());
    } catch {
      /* noop */
    }
    btn.disabled = false;
  }
});

function renderBundleProgress(entry) {
  const card = document.getElementById('run-progress');
  const list = document.getElementById('run-progress-list');
  if (!card || !list) return;
  card.hidden = false;
  const STAGE_LABEL = {
    pending: 'queued',
    running: 'running…',
    success: 'done',
    failed: 'failed',
    skipped: 'skipped',
    captcha_blocked: 'captcha',
  };
  list.innerHTML = entry.carriers
    .map((c) => {
      const cls = c.stage || 'pending';
      const label = STAGE_LABEL[cls] || cls;
      const detail =
        c.stage === 'success'
          ? `${c.rateCount ?? 0} rate${c.rateCount === 1 ? '' : 's'}`
          : c.stage === 'failed' || c.stage === 'captcha_blocked' || c.stage === 'skipped'
            ? c.reason
              ? c.reason.split('\n')[0].slice(0, 80)
              : ''
            : '';
      return `<li>
        <span class="carrier-code">${esc(c.code)}</span>
        <span class="carrier-name">${esc(c.name)}</span>
        ${detail ? `<span class="muted small">— ${esc(detail)}</span>` : ''}
        <span class="stage ${cls}">${esc(label)}</span>
      </li>`;
    })
    .join('');
}

function renderBundleResults(input, data) {
  const card = document.getElementById('results-card');
  const title = document.getElementById('results-title');
  const meta = document.getElementById('results-meta');
  const table = document.getElementById('results-table');
  card.hidden = false;
  const markup = getMarkup();

  title.textContent = `${data.refId}: ${input.from} → ${input.to} (${input.container})`;

  // Build a per-carrier badge list with quick links to the saved artifacts.
  // Artifacts live under /quotes-files/<refId>/rates/<code>-{screenshot.png,
  // page.html, aria.yaml, parsed.json}. Reachable via Tailscale Funnel too —
  // not file:// URLs that only work locally.
  const refId = data.refId;
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
      const baseLabel =
        c.status === 'captcha_blocked'
          ? `${esc(c.carrierName)}: captcha (${esc(c.captchaType || 'unknown')})`
          : `${esc(c.carrierName)}: ${esc(c.status)}`;
      const codeFs = c.carrierCode.toLowerCase();
      const links =
        c.status === 'ok'
          ? ` <a class="artifact-link" href="/quotes-files/${encodeURIComponent(refId)}/rates/${codeFs}-screenshot.png" target="_blank" rel="noopener">screenshot</a>` +
            ` · <a class="artifact-link" href="/quotes-files/${encodeURIComponent(refId)}/rates/${codeFs}-page.html" target="_blank" rel="noopener">page</a>` +
            ` · <a class="artifact-link" href="/quotes-files/${encodeURIComponent(refId)}/rates/${codeFs}-parsed.json" target="_blank" rel="noopener">parsed JSON</a>`
          : '';
      return `<span class="flag ${cls}">${baseLabel}</span>${links}`;
    })
    .join(' &nbsp; ');
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

        // Freight charges + destination charges breakdown — shown in a
        // collapsed-by-default <details> so the row stays clean. Empty
        // arrays mean the carrier didn't surface a breakdown (we still
        // log a hint instead of a silent gap).
        const fc = Array.isArray(r.freight_charges) ? r.freight_charges : [];
        const dc = Array.isArray(r.destination_charges)
          ? r.destination_charges
          : [];
        const destTotal = r.destination_total ?? 0;
        const destCcy = r.destination_currency ?? '';
        const breakdownRows = [];
        if (fc.length > 0) {
          breakdownRows.push(
            '<div class="bd-section"><strong>Freight charges (in total)</strong>' +
              fc
                .map(
                  (c) =>
                    `<div class="bd-row"><span>${esc(c.name)}</span><span>${esc(c.currency || '')} ${(c.total ?? 0).toLocaleString()}</span></div>`
                )
                .join('') +
              '</div>'
          );
        }
        if (dc.length > 0) {
          breakdownRows.push(
            `<div class="bd-section"><strong>Destination charges (collected separately, NOT in total)</strong>` +
              dc
                .map(
                  (c) =>
                    `<div class="bd-row"><span>${esc(c.name)}</span><span>${esc(c.currency || '')} ${(c.total ?? 0).toLocaleString()}</span></div>`
                )
                .join('') +
              (destTotal
                ? `<div class="bd-row"><strong>Subtotal</strong><strong>${esc(destCcy)} ${destTotal.toLocaleString()}</strong></div>`
                : '') +
              '</div>'
          );
        }
        const breakdown =
          breakdownRows.length > 0
            ? `<details class="rate-breakdown"><summary>Breakdown</summary>${breakdownRows.join('')}</details>`
            : '<span class="muted small">no breakdown captured</span>';

        return `<tr>
          <td class="rank">#${idx + 1}</td>
          <td><strong>${esc(r.carrierName)}</strong></td>
          <td>${esc(r.sailing_date ?? '—')}</td>
          <td>${transit}</td>
          <td>${esc(dnd)}</td>
          <td>${esc(r.vessel_voyage ?? '—')}</td>
          <td>${esc(r.service_name)}<br>${breakdown}</td>
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

// ---- Scheduled agents ----
(function wireScheduledAgents() {
  const nameIn = document.getElementById('sched-name');
  const intervalIn = document.getElementById('sched-interval');
  const urlIn = document.getElementById('sched-url');
  const goalIn = document.getElementById('sched-goal');
  const editIdIn = document.getElementById('sched-edit-id');
  const saveBtn = document.getElementById('sched-save-btn');
  const clearBtn = document.getElementById('sched-clear-btn');
  const refreshBtn = document.getElementById('sched-refresh-btn');
  const statusEl = document.getElementById('sched-status');
  const table = document.getElementById('sched-list-table');
  if (!table) return;

  function setStat(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'status-inline' + (kind ? ' status-' + kind : '');
  }
  function clearForm() {
    nameIn.value = '';
    intervalIn.value = '60';
    urlIn.value = '';
    goalIn.value = '';
    editIdIn.value = '';
    clearBtn.hidden = true;
    saveBtn.textContent = 'Save schedule';
  }
  function loadIntoForm(a) {
    nameIn.value = a.name;
    intervalIn.value = a.intervalMinutes;
    urlIn.value = a.url;
    goalIn.value = a.goal;
    editIdIn.value = a.id;
    clearBtn.hidden = false;
    saveBtn.textContent = 'Update schedule';
  }

  async function loadList() {
    try {
      const r = await fetch('/api/scheduled-agents');
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'load failed');
      const agents = data.agents || [];
      if (agents.length === 0) {
        table.innerHTML =
          '<tbody><tr><td class="empty">No schedules yet — fill the form above to add one.</td></tr></tbody>';
        return;
      }
      const head = `<thead><tr>
        <th>Name</th>
        <th>Interval</th>
        <th>Last run</th>
        <th>Status</th>
        <th>Enabled</th>
        <th></th>
      </tr></thead>`;
      const body = agents
        .map((a) => {
          const lastRun = a.lastRunAt
            ? new Date(a.lastRunAt).toISOString().slice(0, 16).replace('T', ' ')
            : '—';
          const status = a.lastRunStatus || '—';
          const cls = status === 'success'
            ? 'success'
            : status === 'failed'
              ? 'error'
              : status === 'incomplete' ? 'warn' : '';
          return `<tr data-id="${a.id}">
            <td><strong>${esc(a.name)}</strong></td>
            <td>${a.intervalMinutes} min</td>
            <td>${esc(lastRun)}</td>
            <td><span class="status-inline ${cls}">${esc(status)}</span></td>
            <td><label class="cy-door-radio"><input type="checkbox" class="sched-enabled" data-id="${a.id}"${a.enabled ? ' checked' : ''} /> ${a.enabled ? 'on' : 'off'}</label></td>
            <td class="actions-cell">
              <button class="btn-sm sched-run-btn" data-id="${a.id}" title="Run now">▶ Run</button>
              <button class="btn-sm sched-edit-btn" data-id="${a.id}" title="Edit">✎</button>
              <button class="ship-delete-btn sched-del-btn" data-id="${a.id}" title="Delete">✕</button>
            </td>
          </tr>`;
        })
        .join('');
      table.innerHTML = head + `<tbody>${body}</tbody>`;
      table.querySelectorAll('.sched-run-btn').forEach((b) => {
        b.addEventListener('click', async () => {
          const id = b.getAttribute('data-id');
          b.disabled = true;
          toast(`Running schedule #${id}…`, 'info');
          try {
            const r = await fetch(`/api/scheduled-agents/${id}/run`, { method: 'POST' });
            const data = await r.json();
            toast(
              data.ok
                ? `Schedule #${id} finished: ${data.message}`
                : `Schedule #${id} ${data.status}: ${data.message}`,
              data.ok ? 'success' : 'error'
            );
            await loadList();
          } catch (err) {
            toast(err.message, 'error');
          } finally {
            b.disabled = false;
          }
        });
      });
      table.querySelectorAll('.sched-edit-btn').forEach((b) => {
        b.addEventListener('click', () => {
          const id = Number(b.getAttribute('data-id'));
          const a = agents.find((x) => x.id === id);
          if (a) loadIntoForm(a);
        });
      });
      table.querySelectorAll('.sched-del-btn').forEach((b) => {
        b.addEventListener('click', async () => {
          const id = b.getAttribute('data-id');
          if (!confirm(`Delete schedule #${id}?`)) return;
          try {
            const r = await fetch(`/api/scheduled-agents/${id}`, { method: 'DELETE' });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || 'delete failed');
            await loadList();
            toast(`Schedule #${id} deleted.`, 'success');
          } catch (err) { toast(err.message, 'error'); }
        });
      });
      // Toggle enabled — re-uses upsert with the existing row data.
      table.querySelectorAll('.sched-enabled').forEach((cb) => {
        cb.addEventListener('change', async () => {
          const id = Number(cb.getAttribute('data-id'));
          const a = agents.find((x) => x.id === id);
          if (!a) return;
          try {
            await fetch('/api/scheduled-agents', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...a, enabled: cb.checked }),
            });
            await loadList();
          } catch (err) { toast(err.message, 'error'); }
        });
      });
    } catch (err) {
      table.innerHTML = `<tbody><tr><td class="empty">Error: ${esc(err.message)}</td></tr></tbody>`;
    }
  }

  saveBtn.addEventListener('click', async () => {
    const name = nameIn.value.trim();
    const url = urlIn.value.trim();
    const goal = goalIn.value.trim();
    const intervalMinutes = parseInt(intervalIn.value, 10);
    const id = editIdIn.value ? Number(editIdIn.value) : undefined;
    if (!name || !url || !goal) {
      setStat('Name, URL and goal are required.', 'error');
      return;
    }
    saveBtn.disabled = true;
    setStat('Saving…', 'info');
    try {
      const r = await fetch('/api/scheduled-agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, url, goal, intervalMinutes }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'save failed');
      setStat(`Saved "${data.name}" (every ${data.intervalMinutes}m).`, 'success');
      clearForm();
      await loadList();
    } catch (err) {
      setStat(err.message, 'error');
    } finally { saveBtn.disabled = false; }
  });
  clearBtn?.addEventListener('click', clearForm);
  refreshBtn?.addEventListener('click', loadList);
  document.querySelector('[data-tab="agent"]')?.addEventListener('click', loadList);
  loadList();
})();

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
  const listEl = document.getElementById('rec-upload-list');

  const files = Array.from(fileInput.files || []);
  if (files.length === 0) {
    setStatus('rec-upload-status', 'Pick at least one recording file.', 'error');
    return;
  }

  btn.disabled = true;
  document.getElementById('rec-analysis-card').hidden = true;
  listEl.innerHTML =
    '<h3 class="bd-title">Upload progress</h3><ul class="rec-upload-progress">' +
    files
      .map(
        (f, i) =>
          `<li data-idx="${i}"><span class="cred-pw-mask">${esc(f.name)}</span> · <span class="upload-state muted">queued</span></li>`
      )
      .join('') +
    '</ul>';

  setStatus(
    'rec-upload-status',
    `Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`,
    'info'
  );

  let lastSuccessful = null; // { meta, analysis }
  let okCount = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const stateEl = listEl.querySelector(`li[data-idx="${i}"] .upload-state`);
    if (stateEl) {
      stateEl.textContent = 'reading…';
      stateEl.className = 'upload-state info';
    }
    try {
      const content = await f.text();
      if (!content.trim()) throw new Error('Empty file');
      if (stateEl) stateEl.textContent = 'analyzing with Claude…';
      // Tag part-N when there are multiple files so descriptions stay distinct.
      const partDesc =
        files.length > 1
          ? `${description ?? f.name.replace(/\.[^.]+$/, '')} (part ${i + 1}/${files.length})`
          : description;
      const r = await fetch('/api/record/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          filename: f.name,
          carrierCode: carrier,
          description: partDesc,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Upload failed');
      lastSuccessful = data;
      okCount++;
      if (stateEl) {
        stateEl.textContent = `done — ${data.analysis.steps.length} steps, ${data.analysis.parameters.length} params`;
        stateEl.className = 'upload-state success';
      }
    } catch (err) {
      if (stateEl) {
        stateEl.textContent = `failed — ${err.message}`;
        stateEl.className = 'upload-state error';
      }
    }
  }

  if (okCount === files.length) {
    setStatus(
      'rec-upload-status',
      `All ${okCount} file${okCount > 1 ? 's' : ''} analyzed.`,
      'success'
    );
  } else if (okCount > 0) {
    setStatus(
      'rec-upload-status',
      `${okCount} of ${files.length} succeeded; see list above for failures.`,
      'info'
    );
  } else {
    setStatus('rec-upload-status', 'All uploads failed.', 'error');
  }
  // Show the last successful analysis (typically the most recent / final part).
  if (lastSuccessful) {
    renderAnalysis(lastSuccessful.meta, lastSuccessful.analysis);
  }
  fileInput.value = '';
  loadRecList();
  btn.disabled = false;
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
    const thead = '<thead><tr><th>Started</th><th>URL</th><th>Carrier</th><th>Status</th><th>File</th><th></th></tr></thead>';
    const rows = data.recordings
      .map((r) => {
        const started = new Date(r.startedAt).toISOString().slice(0, 16).replace('T', ' ');
        const statusCls = r.status === 'finished' ? 'success' : r.status === 'failed' ? 'error' : 'info';
        const replayBtn = r.status === 'finished'
          ? `<button class="btn-sm rec-replay-btn" data-id="${esc(r.id)}" title="Replay this recording">▶ Replay</button>`
          : `<span class="muted small">—</span>`;
        return `<tr>
          <td>${esc(started)}</td>
          <td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url.slice(0, 50))}</a></td>
          <td>${esc(r.carrierCode || '—')}</td>
          <td><span class="status-inline ${statusCls}">${esc(r.status)}</span></td>
          <td><code class="muted small">${esc(r.outFile.split(/[\\/]/).slice(-2).join('/'))}</code></td>
          <td class="actions-cell">${replayBtn}</td>
        </tr>`;
      })
      .join('');
    table.innerHTML = thead + '<tbody>' + rows + '</tbody>';
    table.querySelectorAll('.rec-replay-btn').forEach((btn) => {
      btn.addEventListener('click', () => replayRecording(btn.getAttribute('data-id')));
    });
  } catch (err) {
    table.innerHTML = `<tbody><tr><td class="empty">Error: ${esc(err.message)}</td></tr></tbody>`;
  }
}
loadRecList();

// Replay a saved recording: spawns the script via /api/record/replay/:id
// and then polls /status/:id every 1.5s for live stdout/stderr until
// the proc exits. Result is shown in a toast + log line.
async function replayRecording(recordingId) {
  if (!recordingId) return;
  toast('Starting replay…', 'info');
  try {
    const r = await fetch(`/api/record/replay/${encodeURIComponent(recordingId)}`, {
      method: 'POST',
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'replay failed to start');
    const replayId = data.id;
    toast(`Replay started (id: ${replayId.slice(0, 8)}…)`, 'success');
    // Poll until exit.
    const start = Date.now();
    const TIMEOUT_MS = 5 * 60 * 1000; // 5 min — bail if the script hangs
    while (Date.now() - start < TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 1500));
      const sr = await fetch(`/api/record/replay/status/${encodeURIComponent(replayId)}`);
      const sd = await sr.json();
      if (!sr.ok) throw new Error(sd.error || 'status check failed');
      if (sd.status !== 'running') {
        const ok = sd.status === 'finished' && sd.exitCode === 0;
        toast(
          ok
            ? `Replay finished cleanly (exit ${sd.exitCode}).`
            : `Replay ${sd.status} (exit ${sd.exitCode}). ${(sd.stderr || '').slice(0, 200)}`,
          ok ? 'success' : 'error'
        );
        console.log('[replay stdout]', sd.stdout);
        if (sd.stderr) console.log('[replay stderr]', sd.stderr);
        return;
      }
    }
    toast('Replay still running after 5 min — check server logs.', 'info');
  } catch (err) {
    toast('Replay failed: ' + err.message, 'error');
  }
}

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
        toast(err.message, 'error');
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
        toast('Clipboard write failed — select & copy manually.', 'error');
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
        toast(err.message, 'error');
      }
    }
  });
})();

// ---- Rate-sheet drop / parse ----
(function wireSheetsTab() {
  const dropzone = document.getElementById('sheet-dropzone');
  const fileInput = document.getElementById('sheet-files');
  const parseBtn = document.getElementById('sheet-parse-btn');
  const progress = document.getElementById('sheet-progress-list');
  if (!dropzone || !fileInput || !parseBtn) return;

  let selectedFiles = [];

  function renderQueue() {
    if (selectedFiles.length === 0) {
      progress.innerHTML = '';
      parseBtn.disabled = true;
      parseBtn.textContent = 'Parse selected sheet(s)';
      return;
    }
    progress.innerHTML =
      '<h3 class="bd-title">Queued</h3><ul class="rec-upload-progress">' +
      selectedFiles
        .map(
          (f, i) =>
            `<li data-idx="${i}"><span>${esc(f.name)}</span> <span class="muted small">(${Math.round(f.size / 1024)} KB)</span> <span class="upload-state muted">queued</span><button class="upload-delete" data-remove="${i}" title="Remove from queue">✕</button></li>`
        )
        .join('') +
      '</ul>';
    parseBtn.disabled = false;
    parseBtn.textContent = `Parse ${selectedFiles.length} sheet${selectedFiles.length > 1 ? 's' : ''}`;

    // Wire per-file delete buttons. Removing while parsing is allowed but
    // only affects the next click of "Parse" — files already submitted to
    // Claude will continue.
    progress.querySelectorAll('.upload-delete').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute('data-remove'));
        if (!Number.isFinite(idx)) return;
        selectedFiles = selectedFiles.filter((_, i) => i !== idx);
        renderQueue();
      });
    });
  }

  function setItemState(i, msg, cls) {
    const li = progress.querySelector(`li[data-idx="${i}"] .upload-state`);
    if (li) {
      li.textContent = msg;
      li.className = 'upload-state ' + (cls || '');
    }
  }

  function ingestFiles(fileList) {
    const arr = Array.from(fileList || []);
    const accepted = arr.filter((f) =>
      /^(application\/pdf|image\/(png|jpe?g|webp|gif))$/i.test(f.type)
    );
    if (accepted.length !== arr.length) {
      setStatus(
        'sheet-status',
        `Skipped ${arr.length - accepted.length} unsupported file${arr.length - accepted.length === 1 ? '' : 's'}.`,
        'info'
      );
    }
    selectedFiles = selectedFiles.concat(accepted);
    renderQueue();
  }

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    ingestFiles(fileInput.files);
    fileInput.value = '';
  });
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('is-drag');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-drag'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-drag');
    ingestFiles(e.dataTransfer?.files);
  });

  // Ctrl+V paste support: intercept only when the Sheets tab is active
  // AND the paste target isn't a typing input (so we don't break paste
  // into the credentials/search/etc. fields elsewhere). Synthesizes a
  // filename from the clipboard mime type since clipboard images have no
  // intrinsic name.
  document.addEventListener('paste', (e) => {
    // The rate-sheet drop zone now lives inside the Ocean tab (#tab-new)
    // since the Sheets/Ocean merge. Old guard checked #tab-sheets.active
    // which no longer exists, so Ctrl+V was silently no-oping. Gate on
    // the Ocean tab instead.
    const oceanActive = document
      .getElementById('tab-new')
      ?.classList.contains('active');
    if (!oceanActive) return;
    const target = e.target;
    const isTypingInput =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable);
    if (isTypingInput) return;

    const items = (e.clipboardData || {}).items || [];
    const pastedFiles = [];
    for (const item of items) {
      if (!item.type || !item.type.startsWith('image/')) continue;
      const blob = item.getAsFile();
      if (!blob) continue;
      const ext = item.type.split('/')[1] || 'png';
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const named = new File(
        [blob],
        `pasted-${ts}.${ext}`,
        { type: item.type }
      );
      pastedFiles.push(named);
    }
    if (pastedFiles.length > 0) {
      e.preventDefault();
      ingestFiles(pastedFiles);
      setStatus(
        'sheet-status',
        `Pasted ${pastedFiles.length} image${pastedFiles.length > 1 ? 's' : ''} from clipboard.`,
        'info'
      );
    }
  });

  async function fileToBase64(file) {
    const buf = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  parseBtn.addEventListener('click', async () => {
    if (selectedFiles.length === 0) return;
    parseBtn.disabled = true;
    setStatus('sheet-status', 'Reading files…', 'info');

    const payload = [];
    for (let i = 0; i < selectedFiles.length; i++) {
      const f = selectedFiles[i];
      setItemState(i, 'reading…', 'info');
      try {
        const b64 = await fileToBase64(f);
        payload.push({
          filename: f.name,
          contentBase64: b64,
          mediaType: f.type || 'application/pdf',
        });
        setItemState(i, 'queued for Claude…', 'info');
      } catch (err) {
        setItemState(i, 'read failed: ' + err.message, 'error');
      }
    }

    setStatus('sheet-status', 'Sending to Claude…', 'info');
    try {
      const r = await fetch('/api/rates/parse-sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: payload }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'parse failed');

      data.results.forEach((res, i) => {
        if (res.ok) {
          const lanes = res.parsed.lanes.length;
          const rates = res.parsed.lanes.reduce(
            (n, l) => n + l.rates_per_container.length,
            0
          );
          setItemState(
            i,
            `${res.parsed.carrier_code} · ${lanes} lane(s) · ${rates} rate(s)`,
            'success'
          );
        } else {
          setItemState(i, 'failed: ' + (res.reason || 'unknown'), 'error');
        }
      });

      const okResults = data.results.filter((r) => r.ok);
      const totalRates = okResults.reduce(
        (n, r) =>
          n +
          r.parsed.lanes.reduce(
            (m, l) => m + l.rates_per_container.length,
            0
          ),
        0
      );
      setStatus(
        'sheet-status',
        `${okResults.length}/${data.results.length} parsed · ${totalRates} rates total · saved to ${data.outputFolder}`,
        okResults.length === data.results.length ? 'success' : 'info'
      );
      renderSheetResults(data);
      document.dispatchEvent(new Event('sheet-parse-complete'));
    } catch (err) {
      setStatus('sheet-status', err.message, 'error');
    } finally {
      selectedFiles = [];
      parseBtn.disabled = false;
      parseBtn.textContent = 'Parse selected sheet(s)';
    }
  });
})();

// Most recently rendered rate rows — kept globally so the Generate Email
// button can read them without having to re-fetch from the table DOM.
let lastSheetRows = [];
// refId of the sheet currently displayed (so Generate Email can persist
// the new email back to the saved row).
let lastSheetRefId = null;

function renderSheetResults(data) {
  const card = document.getElementById('sheet-results-card');
  const title = document.getElementById('sheet-results-title');
  const meta = document.getElementById('sheet-results-meta');
  const table = document.getElementById('sheet-results-table');
  if (!card || !table) return;
  card.hidden = false;

  const okResults = data.results.filter((r) => r.ok);
  if (okResults.length === 0) {
    title.textContent = 'No rates extracted';
    meta.textContent = data.refId;
    table.innerHTML =
      '<tbody><tr><td class="empty">All files failed. See queue above.</td></tr></tbody>';
    lastSheetRows = [];
    return;
  }

  // Flatten: one row per (file, lane, container).
  const rows = [];
  for (const res of okResults) {
    const carrier = res.parsed.carrier_code || 'UNK';
    const validityFrom = res.parsed.validity_from || null;
    const validityTo = res.parsed.validity_to || null;
    const validity =
      validityFrom && validityTo
        ? `${validityFrom} → ${validityTo}`
        : validityFrom || validityTo || null;
    for (const lane of res.parsed.lanes) {
      for (const r of lane.rates_per_container) {
        rows.push({
          carrier,
          validity,
          validityFrom,
          validityTo,
          filename: res.filename,
          source: res.artifacts?.source,
          parsed: res.artifacts?.parsed,
          // POL = Port of Loading (origin), POD = Port of Discharge (destination)
          pol: lane.origin || '',
          polCode: lane.origin_code || null,
          pod: lane.destination || '',
          podCode: lane.destination_code || null,
          serviceName: lane.service_name || null,
          transitDays: lane.transit_days,
          detentionDays: lane.detention_freetime_days,
          demurrageDays: lane.demurrage_freetime_days,
          containerType: r.container_type,
          freightCharges: r.freight_charges || [],
          freightTotal: r.freight_total,
          freightCurrency: r.freight_currency,
          destCharges: r.destination_charges || [],
          destTotal: r.destination_total,
          destCurrency: r.destination_currency,
        });
      }
    }
  }
  rows.sort(
    (a, b) =>
      a.pol.localeCompare(b.pol) ||
      a.pod.localeCompare(b.pod) ||
      a.containerType.localeCompare(b.containerType)
  );

  lastSheetRows = rows;
  lastSheetRefId = data.refId || null;

  // Auto-suggest the overweight surcharge: if the user gave a weight on
  // the lane and any container exceeds the carrier-typical limits, tick
  // the box and add a green "(auto-applied)" hint. They can untick if
  // it's wrong; we don't enforce.
  // Limits: 17.7 t for 20', 19.8 t for 40'.
  const overweightTarget = lastSheetRows.find((r) => {
    const t = String(r.containerType || '').toUpperCase();
    if (t.startsWith('20') && (r.weightKg || 0) > 17_700) return true;
    if ((t.startsWith('40') || t.startsWith('45')) && (r.weightKg || 0) > 19_800) return true;
    return false;
  });
  const owToggle = document.getElementById('surch-overweight');
  const owRow = owToggle?.closest('.surcharge-row');
  if (owToggle && owRow) {
    if (overweightTarget) {
      owToggle.checked = true;
      owRow.classList.add('is-auto-applied');
    } else {
      owRow.classList.remove('is-auto-applied');
    }
  }

  title.textContent = `${data.refId}: ${rows.length} rate row(s) from ${okResults.length} sheet(s)`;
  meta.innerHTML = `Saved to <code>${esc(data.outputFolder)}</code>`;

  const thead = `<thead><tr>
    <th>Carrier</th>
    <th>POL → POD</th>
    <th>Container</th>
    <th>Transit</th>
    <th>Det/Dem free</th>
    <th>Freight total<br><span class="muted small">(in total)</span></th>
    <th>Destination<br><span class="muted small">(separate)</span></th>
    <th>Source</th>
  </tr></thead>`;

  // Consistent two-line POL/POD cell: line 1 = POL with code if present,
  // line 2 = POD with code if present. "—" for missing values, never the
  // word "UNKNOWN" leaking through.
  function locCell(name, code) {
    if (!name && !code) return '—';
    const main = name || code || '—';
    const codeStr = code && name ? ` <code>${esc(code)}</code>` : '';
    return `${esc(main)}${codeStr}`;
  }

  const body = rows
    .map((r, idx) => {
      const polPodCell =
        `<div><span class="muted small">POL</span> ${locCell(r.pol, r.polCode)}</div>` +
        `<div><span class="muted small">POD</span> ${locCell(r.pod, r.podCode)}</div>`;

      const transit = r.transitDays != null ? `${r.transitDays}d` : '—';
      const dnd =
        r.detentionDays != null || r.demurrageDays != null
          ? `${r.detentionDays ?? '?'}d / ${r.demurrageDays ?? '?'}d`
          : '—';

      const fc = (r.freightCharges || [])
        .map(
          (c) =>
            `<div class="bd-row"><span>${esc(c.name)}</span><span>${esc(c.currency)} ${(c.amount ?? 0).toLocaleString()}</span></div>`
        )
        .join('');
      const dc = (r.destCharges || [])
        .map(
          (c) =>
            `<div class="bd-row"><span>${esc(c.name)}</span><span>${esc(c.currency)} ${(c.amount ?? 0).toLocaleString()}</span></div>`
        )
        .join('');

      const freightCell =
        `<strong>${esc(r.freightCurrency)} ${r.freightTotal.toLocaleString()}</strong>` +
        (fc
          ? `<details class="rate-breakdown"><summary>breakdown</summary><div class="bd-section">${fc}</div></details>`
          : '');

      const destCell =
        r.destTotal != null
          ? `<strong>${esc(r.destCurrency || '')} ${r.destTotal.toLocaleString()}</strong>` +
            (dc
              ? `<details class="rate-breakdown"><summary>breakdown</summary><div class="bd-section">${dc}</div></details>`
              : '')
          : '<span class="muted small">—</span>';

      // Source link: PDFs still open in a new tab (browser PDF viewer);
      // images open the in-page modal so the user can compare the
      // extracted figures against the original side-by-side.
      const isImage = r.source && /\.(png|jpe?g|webp|gif)$/i.test(r.source);
      const sourceCell = r.source
        ? isImage
          ? `<a href="#" data-image-src="${esc(r.source)}" data-image-name="${esc(r.filename)}" class="artifact-link sheet-source-link" data-row-idx="${idx}">${esc(r.filename)}</a>`
          : `<a href="${esc(r.source)}" target="_blank" rel="noopener" class="artifact-link">${esc(r.filename)}</a>`
        : esc(r.filename);

      return `<tr>
        <td><strong>${esc(r.carrier)}</strong>${r.serviceName ? `<br><span class="muted small">${esc(r.serviceName)}</span>` : ''}${r.validity ? `<br><span class="muted small">${esc(r.validity)}</span>` : ''}</td>
        <td>${polPodCell}</td>
        <td><code>${esc(r.containerType)}</code></td>
        <td>${transit}</td>
        <td>${esc(dnd)}</td>
        <td class="price">${freightCell}</td>
        <td>${destCell}</td>
        <td>${sourceCell}</td>
      </tr>`;
    })
    .join('');

  table.innerHTML = thead + '<tbody>' + body + '</tbody>';

  // Wire image-source links to the modal viewer.
  table.querySelectorAll('a.sheet-source-link').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const src = a.getAttribute('data-image-src');
      const name = a.getAttribute('data-image-name') || '';
      if (src) openImageModal(src, name);
    });
  });

  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---- Image preview modal (Sheets tab source thumbnails) ----
(function wireImageModal() {
  const modal = document.getElementById('image-modal');
  if (!modal) return;
  const img = document.getElementById('image-modal-img');
  const nameEl = document.getElementById('image-modal-name');
  const zoomPct = document.getElementById('image-modal-zoom-pct');

  let zoom = 1;
  function applyZoom() {
    img.style.transform = `scale(${zoom})`;
    zoomPct.textContent = Math.round(zoom * 100) + '%';
  }

  function close() {
    modal.hidden = true;
    img.src = '';
    zoom = 1;
  }
  function fit() {
    zoom = 1;
    applyZoom();
  }
  function zoomIn() {
    zoom = Math.min(zoom + 0.2, 5);
    applyZoom();
  }
  function zoomOut() {
    zoom = Math.max(zoom - 0.2, 0.2);
    applyZoom();
  }

  document.getElementById('image-modal-close').addEventListener('click', close);
  document
    .getElementById('image-modal-zoom-in')
    .addEventListener('click', zoomIn);
  document
    .getElementById('image-modal-zoom-out')
    .addEventListener('click', zoomOut);
  document.getElementById('image-modal-fit').addEventListener('click', fit);
  modal.querySelector('.image-modal-backdrop').addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (modal.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === '+' || e.key === '=') zoomIn();
    else if (e.key === '-' || e.key === '_') zoomOut();
    else if (e.key === '0') fit();
  });
  // Mouse-wheel zoom inside the modal body
  document
    .querySelector('.image-modal-body')
    ?.addEventListener('wheel', (e) => {
      if (modal.hidden) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY < 0) zoomIn();
        else zoomOut();
      }
    });

  window.openImageModal = function (src, name) {
    img.src = src;
    nameEl.textContent = name || '';
    modal.hidden = false;
    fit();
  };
})();

// ---- Sheets: margin sliders + surcharges + email templates ----

// Three named templates the user can pick from. Each is editable and
// persisted independently (localStorage key per template id), so the user
// can tweak the "Concise" one without disturbing the others.
const EMAIL_TEMPLATES = {
  concise: {
    label: 'Concise',
    default: `Dear ___,

Pls find below our quote-
POL <POL CITY/PORT>
POD <POD CITY/COUNTRY>
$<20GP price>/20'GP ; $<40HQ price>/40'HQ , <CARRIER>, <transit>d t/t ; Destination charges $<dest>/cntr
$<20GP price>/20'GP ; $<40HQ price>/40'HQ , <CARRIER>, <transit>d t/t ; Destination charges $<dest>/cntr
<applicable surcharges as separate lines, one each>
All origin charges (ocean carrier/terminal) included.`,
  },
  structured: {
    label: 'Structured',
    default: `Hi ___,

Thanks for your enquiry. Below is our quote:

Routing: <POL> -> <POD>
Container(s): <list>
Validity: <dates if known>

<per-carrier block>
- 20'GP: $<price>
- 40'HQ: $<price>
- Carrier: <name>, transit <X>d
- Destination charges (on collect, paid by consignee): $<dest>/cntr

<applicable surcharges as a list>

All origin charges (ocean carrier and terminal) are included.
Please confirm and we will proceed with booking.`,
  },
  conversational: {
    label: 'Conversational',
    default: `Hello ___,

Pleased to share our spot rates as follows.

We can move <POL> to <POD> with the following options:
<for each carrier, one short paragraph: price per container, transit, what's included>

Destination charges are paid on collect at <POD>: <amount>/cntr.
<if surcharges apply: one short note per surcharge>

All origin handling (ocean carrier and terminal) is on us.
Let me know how you'd like to proceed.`,
  },
};
const SHEET_TEMPLATE_KEY = (id) => `freight.sheet.email.template.${id}`;
const SHEET_TEMPLATE_SELECTED_KEY = 'freight.sheet.email.template.selected';

(function wireSheetEmailControls() {
  const pctSlider = document.getElementById('sheet-markup-pct-slider');
  const pctNum = document.getElementById('sheet-markup-pct');
  const flatSlider = document.getElementById('sheet-markup-flat-slider');
  const flatNum = document.getElementById('sheet-markup-flat');
  const btn = document.getElementById('sheet-email-btn');
  const ta = document.getElementById('sheet-email-text');
  const row = document.getElementById('sheet-email-row');
  const copyBtn = document.getElementById('sheet-email-copy-btn');
  const templateTa = document.getElementById('sheet-email-template');
  const templateRadios = document.querySelectorAll('input[name="email-template"]');
  if (!btn) return;

  // Template picker — load whichever was last selected, prefill its
  // textarea with the saved (or default) body. Switching radios swaps
  // the textarea content; edits autosave to that template's slot.
  let currentTemplateId =
    localStorage.getItem(SHEET_TEMPLATE_SELECTED_KEY) || 'concise';

  function loadTemplateBody(id) {
    if (!templateTa || !EMAIL_TEMPLATES[id]) return;
    const stored = localStorage.getItem(SHEET_TEMPLATE_KEY(id));
    templateTa.value =
      stored != null ? stored : EMAIL_TEMPLATES[id].default;
  }
  function selectTemplate(id) {
    if (!EMAIL_TEMPLATES[id]) return;
    currentTemplateId = id;
    localStorage.setItem(SHEET_TEMPLATE_SELECTED_KEY, id);
    const radio = document.getElementById(`tpl-${id}`);
    if (radio) radio.checked = true;
    loadTemplateBody(id);
  }
  selectTemplate(currentTemplateId);
  templateRadios.forEach((r) => {
    r.addEventListener('change', () => {
      if (r.checked) selectTemplate(r.value);
    });
  });
  if (templateTa) {
    templateTa.addEventListener('input', () => {
      localStorage.setItem(
        SHEET_TEMPLATE_KEY(currentTemplateId),
        templateTa.value
      );
    });
  }

  function bindPair(slider, num) {
    slider.addEventListener('input', () => (num.value = slider.value));
    num.addEventListener('input', () => (slider.value = num.value));
  }
  bindPair(pctSlider, pctNum);
  bindPair(flatSlider, flatNum);

  btn.addEventListener('click', async () => {
    if (!lastSheetRows || lastSheetRows.length === 0) {
      setStatus('sheet-email-status', 'No parsed rates — drop a sheet first.', 'error');
      return;
    }
    const markupPct = Number(pctNum.value) || 0;
    const markupFlat = Number(flatNum.value) || 0;

    // Surcharge picker — three optional clauses. Each toggle is read
    // here; the values are sent to the backend so the prompt can include
    // them as separate lines in the email when checked.
    const exportDeclChecked = document.getElementById('surch-export-decl')?.checked;
    const exportDeclFee = Number(
      document.getElementById('surch-export-decl-fee')?.value
    ) || 0;
    const overweightChecked = document.getElementById('surch-overweight')?.checked;
    const overweightFee = Number(
      document.getElementById('surch-overweight-fee')?.value
    ) || 0;
    const waitingChecked = document.getElementById('surch-waiting')?.checked;
    const waitingHourlyRate = Number(
      document.getElementById('surch-waiting-fee')?.value
    ) || 0;

    const surcharges = [];
    if (exportDeclChecked && exportDeclFee > 0) {
      surcharges.push({
        kind: 'export_declaration',
        label: 'Export declaration',
        amount: exportDeclFee,
        currency: 'USD',
        basis: 'per shipment',
      });
    }
    if (overweightChecked && overweightFee > 0) {
      surcharges.push({
        kind: 'overweight',
        label: 'Overweight surcharge',
        amount: overweightFee,
        currency: 'USD',
        basis:
          'per container that exceeds 17.7t (20\') / 19.8t (40\') gross',
      });
    }
    if (waitingChecked && waitingHourlyRate > 0) {
      surcharges.push({
        kind: 'waiting_time',
        label: 'Loading wait time',
        amount: waitingHourlyRate,
        currency: 'USD',
        basis: '1 hour free, then $/hr thereafter',
      });
    }

    const sheetTpl = document.getElementById('sheet-email-template');
    const emailTemplate = sheetTpl?.value.trim() || undefined;
    const clientName =
      document.getElementById('client-name')?.value.trim() || undefined;

    btn.disabled = true;
    setStatus('sheet-email-status', 'Composing email…', 'info');

    try {
      const r = await fetch('/api/sheets/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: lastSheetRows.map((row) => ({
            carrier: row.carrier,
            pol: row.pol,
            polCode: row.polCode,
            pod: row.pod,
            podCode: row.podCode,
            containerType: row.containerType,
            transitDays: row.transitDays,
            detentionFreetimeDays: row.detentionDays,
            demurrageFreetimeDays: row.demurrageDays,
            freightTotal: row.freightTotal,
            freightCurrency: row.freightCurrency,
            freightCharges: row.freightCharges.map((c) => ({
              name: c.name,
              amount: c.amount,
              currency: c.currency,
            })),
            destinationTotal: row.destTotal,
            destinationCurrency: row.destCurrency,
            destinationCharges: row.destCharges.map((c) => ({
              name: c.name,
              amount: c.amount,
              currency: c.currency,
            })),
            validityFrom: row.validityFrom,
            validityTo: row.validityTo,
            serviceName: row.serviceName,
          })),
          markupPct,
          markupFlat,
          surcharges,
          clientName,
          emailTemplate,
          refId: lastSheetRefId,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'email generation failed');
      ta.value = data.text;
      ta.hidden = false;
      row.hidden = false;
      setStatus('sheet-email-status', 'Email ready.', 'success');
    } catch (err) {
      setStatus('sheet-email-status', err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  copyBtn?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(ta.value);
      copyBtn.textContent = '✓ Copied';
      setTimeout(() => (copyBtn.textContent = '📋 Copy to clipboard'), 1500);
    } catch {
      ta.select();
      toast('Clipboard write failed — text is selected for manual copy.', 'error');
    }
  });
})();

// ---- Past sheet quotes: search + load-back ----
(function wireSheetHistory() {
  const searchInput = document.getElementById('sheet-history-search');
  const list = document.getElementById('sheet-history-list');
  const refreshBtn = document.getElementById('sheet-history-refresh');
  if (!searchInput || !list) return;

  let debounceTimer = null;

  async function load(query) {
    list.innerHTML = '<div class="muted small">Loading…</div>';
    try {
      const r = await fetch(
        '/api/sheets/history?q=' + encodeURIComponent(query || '')
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'load failed');
      renderList(data.uploads || []);
    } catch (err) {
      list.innerHTML = `<div class="muted small">Error: ${esc(err.message)}</div>`;
    }
  }

  function renderList(uploads) {
    if (uploads.length === 0) {
      list.innerHTML =
        '<div class="muted small">No saved quotes yet. Drop a sheet above and they\'ll start showing up here.</div>';
      return;
    }
    list.innerHTML = uploads
      .map((u) => {
        const when = new Date(u.createdAt)
          .toISOString()
          .replace('T', ' ')
          .slice(0, 16);
        const lanesHtml = u.lanes
          .slice(0, 3)
          .map((l) => `<span class="lane">${esc(l)}</span>`)
          .join('');
        const more =
          u.lanes.length > 3
            ? `<span class="muted small">+${u.lanes.length - 3} more</span>`
            : '';
        const carriers = u.carriers
          .map((c) => `<span class="carrier-pill">${esc(c)}</span>`)
          .join(' ');
        const containers =
          u.containerTypes.length > 0
            ? u.containerTypes.map((c) => `<code>${esc(c)}</code>`).join(' ')
            : '';
        const emailFlag = u.generatedEmail
          ? '<span class="has-email">✓ email saved</span>'
          : '';
        return `<div class="sheet-history-row" data-ref="${esc(u.refId)}">
          <div class="when">${esc(when)}<br><code class="muted small">${esc(u.refId)}</code></div>
          <div class="lanes">${lanesHtml}${more}</div>
          <div class="meta">${carriers} ${containers} <span class="muted small">${u.rateRowCount} rate${u.rateRowCount === 1 ? '' : 's'}</span> ${emailFlag}</div>
        </div>`;
      })
      .join('');

    list.querySelectorAll('.sheet-history-row').forEach((row) => {
      row.addEventListener('click', () => loadSavedUpload(row.dataset.ref));
    });
  }

  async function loadSavedUpload(refId) {
    try {
      const r = await fetch(`/api/sheets/history/${encodeURIComponent(refId)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'load failed');
      // results was stored as the ORIGINAL parse-sheet response payload —
      // hand it to the same renderer the live parse uses.
      if (data.results) {
        renderSheetResults(data.results);
      }
      // Restore the saved email + markup state.
      const ta = document.getElementById('sheet-email-text');
      const row = document.getElementById('sheet-email-row');
      if (data.generatedEmail && ta) {
        ta.value = data.generatedEmail;
        ta.hidden = false;
        if (row) row.hidden = false;
        setStatus(
          'sheet-email-status',
          'Loaded saved email — adjust and re-generate or copy as-is.',
          'info'
        );
      } else if (ta) {
        ta.value = '';
        ta.hidden = true;
        if (row) row.hidden = true;
      }
      const pctNum = document.getElementById('sheet-markup-pct');
      const pctSlider = document.getElementById('sheet-markup-pct-slider');
      const flatNum = document.getElementById('sheet-markup-flat');
      const flatSlider = document.getElementById('sheet-markup-flat-slider');
      if (pctNum && pctSlider) {
        pctNum.value = data.markupPct ?? 0;
        pctSlider.value = data.markupPct ?? 0;
      }
      if (flatNum && flatSlider) {
        flatNum.value = data.markupFlat ?? 0;
        flatSlider.value = data.markupFlat ?? 0;
      }
      const decTog = document.getElementById('sheet-export-decl-toggle');
      const decFee = document.getElementById('sheet-export-decl-fee');
      if (decTog) decTog.checked = !!data.addExportDeclaration;
      if (decFee && data.exportDeclarationFee != null) {
        decFee.value = data.exportDeclarationFee;
      }
    } catch (err) {
      setStatus('sheet-email-status', 'Load failed: ' + err.message, 'error');
    }
  }

  searchInput.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => load(searchInput.value), 250);
  });
  refreshBtn?.addEventListener('click', () => load(searchInput.value));

  // Initial load
  load('');

  // Refresh after every successful parse so the new quote appears immediately.
  document.addEventListener('sheet-parse-complete', () => load(searchInput.value));
})();

// ---- Shipment board ----
// Statuses are user-managed (not DelayPredict). Each maps to a colored
// dot + a hover label. DelayPredict's tracking, when configured, is
// available via the row-detail modal (separate concern).
// Operational status — icon-driven so the user can scan the column at
// a glance without learning a colour code. Order = lifecycle order:
// booking → loaded → sailed → invoiced. Keep values stable; legacy
// pre-rename values (processing/shipped/pending_invoice/pending_payment)
// are mapped onto the new set in statusFor() below.
const STATUS_OPTIONS = [
  { value: '',         label: '— none —',                 icon: '⚪' },
  { value: 'booking',  label: 'Booking in progress',      icon: '📝' },
  { value: 'loaded',   label: 'Loaded — awaiting sailing', icon: '⚓' },
  { value: 'sailed',   label: 'Sailed — invoice due',     icon: '🚢' },
  { value: 'invoiced', label: 'Invoiced — awaiting payment', icon: '🧾' },
];
const STATUS_LEGACY_MAP = {
  processing: 'booking',
  shipped: 'sailed',
  pending_invoice: 'sailed',
  pending_payment: 'invoiced',
};
function statusFor(value) {
  const v = value || '';
  const mapped = STATUS_LEGACY_MAP[v] ?? v;
  return (
    STATUS_OPTIONS.find((s) => s.value === mapped) || STATUS_OPTIONS[0]
  );
}

const SHIP_COLS = [
  // Status — colored dot, hover label, double-click to change.
  { key: 'operationalStatus', label: 'Status', editable: true, kind: 'status', cls: 'track-cell' },
  { key: 'refId', label: 'Ref', editable: false, cls: 'ref-cell' },
  { key: 'createdAt', label: 'Created', editable: false, cls: 'when-cell' },
  { key: 'shipperName', label: 'Shipper', editable: true },
  { key: 'receiverName', label: 'Receiver', editable: true },
  { key: 'customerName', label: 'Customer', editable: true },
  { key: 'loadingAddress', label: 'Pickup', editable: true, kind: 'short-modal' },
  // FPOL — first port / inland terminal (Kansas City, Chicago, etc.).
  { key: 'fpol', label: 'FPOL', editable: true },
  { key: 'pol', label: 'POL', editable: true },
  { key: 'pod', label: 'POD', editable: true },
  // Shipment Type (FCL / LCL / Road).
  { key: 'shipmentType', label: 'Type', editable: true, kind: 'shipment-type' },
  { key: 'containerType', label: 'Cntr', editable: true },
  // Container quantity — drives the per-container × quantity math the
  // AI applies to cost line items.
  { key: 'containerQuantity', label: 'Qty', editable: true, type: 'number' },
  // Merged Cargo (type — name) — preview only, double-click for modal.
  { key: 'cargo', label: 'Cargo', editable: true, kind: 'cargo-modal' },
  // Sell — total only; click for breakdown modal (analogous to Cost).
  // Double-click still allows manual override of the cell.
  { key: 'soldRate', label: 'Sell', editable: false, kind: 'sell-modal' },
  // Our Cost — total only; click for breakdown modal.
  { key: 'ourCost', label: 'Cost', editable: false, kind: 'cost-modal' },
  // Estimated profit — computed from soldRate − ourCost; not editable.
  { key: 'profit', label: 'Profit', editable: false, kind: 'profit' },
  { key: 'carrierPreference', label: 'Carrier', editable: true },
  // Booking Ref — carrier's booking number (separate from our internal ref).
  { key: 'bookingRef', label: 'Book#', editable: true },
  { key: 'notes', label: 'Notes', editable: true, kind: 'notes-modal' },
];

const SHIPMENT_TYPE_OPTIONS = [
  '', 'FCL', 'LCL', 'RORO', 'BreakBulk', 'LTL', 'FTL', 'AIR',
];

// Cargo icons stay — those are short categorical tags (general/hazmat/
// reefer/high_value/oog) where an icon reads faster than the word.
const CARGO_ICON = {
  general: '📦',
  hazmat: '⚠️',
  reefer: '❄️',
  high_value: '💎',
  oog: '🚧',
};

function truncate(s, n = 60) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const CUR_SYMBOL = {
  USD: '$',
  CAD: 'C$',
  EUR: '€',
  GBP: '£',
  AUD: 'A$',
  JPY: '¥',
  CNY: '¥',
};
function formatMoney(n, cur) {
  if (n == null || !Number.isFinite(n)) return '';
  const code = (cur || 'USD').toUpperCase();
  const sym = CUR_SYMBOL[code] || `${code} `;
  const abs = Math.abs(n);
  const fixed = abs >= 1000 ? Math.round(n).toString() : n.toFixed(2);
  const withSep = fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `-${sym}${withSep.replace(/^-/, '')}` : `${sym}${withSep}`;
}

(function wireShipmentsTab() {
  const dropzone = document.getElementById('ship-dropzone');
  const fileInput = document.getElementById('ship-files');
  const parseBtn = document.getElementById('ship-parse-btn');
  const addBlankBtn = document.getElementById('ship-add-blank-btn');
  const refreshBtn = document.getElementById('ship-refresh-btn');
  const searchInput = document.getElementById('ship-search');
  const table = document.getElementById('ship-table');
  if (!dropzone || !table) return;

  let pendingFiles = [];

  const pendingFilesList = document.getElementById('ship-pending-files');
  function fileTypeLabel(f) {
    const lower = (f.name || '').toLowerCase();
    if (f.type === 'application/pdf' || lower.endsWith('.pdf'))
      return { icon: '📄', label: 'PDF' };
    if (/^image\//.test(f.type) || /\.(png|jpe?g|webp|gif)$/.test(lower))
      return { icon: '🖼️', label: (f.type.split('/')[1] || 'image').toUpperCase() };
    if (lower.endsWith('.msg')) return { icon: '📧', label: 'Outlook .msg' };
    if (f.type === 'message/rfc822' || lower.endsWith('.eml'))
      return { icon: '📧', label: 'Email (.eml)' };
    if (f.type === 'text/html' || /\.(html?)$/.test(lower))
      return { icon: '🌐', label: 'HTML' };
    if (f.type === 'text/plain' || lower.endsWith('.txt'))
      return { icon: '📝', label: 'Text' };
    return { icon: '📎', label: f.type || 'unknown' };
  }
  function fileSize(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  function renderPendingList() {
    if (!pendingFilesList) return;
    if (pendingFiles.length === 0) {
      pendingFilesList.hidden = true;
      pendingFilesList.innerHTML = '';
      return;
    }
    pendingFilesList.hidden = false;
    pendingFilesList.innerHTML = pendingFiles
      .map((f, i) => {
        const t = fileTypeLabel(f);
        return `<li class="pending-file" data-i="${i}">
          <span class="pending-file-icon">${t.icon}</span>
          <span class="pending-file-name" title="${esc(f.name)}">${esc(f.name)}</span>
          <span class="pending-file-meta">${esc(t.label)}${f.size ? ' · ' + esc(fileSize(f.size)) : ''}</span>
          <button type="button" class="pending-file-remove" data-i="${i}" title="Remove">✕</button>
        </li>`;
      })
      .join('');
    pendingFilesList.querySelectorAll('.pending-file-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = Number(btn.getAttribute('data-i'));
        if (!Number.isFinite(i)) return;
        pendingFiles.splice(i, 1);
        refreshDropState();
      });
    });
  }
  function refreshDropState() {
    parseBtn.disabled = pendingFiles.length === 0;
    parseBtn.textContent =
      pendingFiles.length > 0
        ? `Extract & create shipment (${pendingFiles.length} file${pendingFiles.length > 1 ? 's' : ''})`
        : 'Extract & create shipment';
    renderPendingList();
  }
  function ingestFiles(fl) {
    const arr = Array.from(fl || []);
    if (arr.length === 0) {
      setStatus(
        'ship-status',
        "No file detected — if you dragged an email directly from Outlook or webmail, save it to disk first (PDF or .eml) and drop the file.",
        'error'
      );
      return;
    }
    const accepted = [];
    const rejected = []; // { name, reason }
    for (const f of arr) {
      // Accept by mime first
      if (
        /^(application\/pdf|image\/(png|jpe?g|webp|gif)|message\/rfc822|text\/(html|plain))$/i.test(
          f.type
        )
      ) {
        accepted.push(f);
        continue;
      }
      // Then by filename extension (browsers often miss the mime on
      // .eml / .msg / .html). .msg is decoded server-side by msgreader
      // and forwarded to Claude as plain email text.
      const lower = (f.name || '').toLowerCase();
      if (/\.(eml|msg|html?|txt)$/.test(lower)) {
        accepted.push(f);
        continue;
      }
      rejected.push({
        name: f.name || '(unnamed)',
        reason: `Unsupported type "${f.type || 'unknown'}" — drop a PDF, screenshot, .eml, .html, or .txt instead.`,
      });
    }
    if (rejected.length > 0) {
      const msg = rejected
        .map((r) => `${r.name}: ${r.reason}`)
        .join('\n');
      setStatus(
        'ship-status',
        rejected.length === 1
          ? rejected[0].reason
          : `${rejected.length} file(s) rejected:\n${msg}`,
        'error'
      );
    } else if (accepted.length > 0) {
      setStatus('ship-status', '', '');
    }
    pendingFiles = pendingFiles.concat(accepted);
    refreshDropState();
  }

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    ingestFiles(fileInput.files);
    fileInput.value = '';
  });
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('is-drag');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-drag'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-drag');
    ingestFiles(e.dataTransfer?.files);
  });
  document.addEventListener('paste', (e) => {
    const tabActive = document
      .getElementById('tab-shipments')
      ?.classList.contains('active');
    if (!tabActive) return;
    const target = e.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return;
    }
    const items = (e.clipboardData || {}).items || [];
    const pastedFiles = [];
    for (const item of items) {
      if (!item.type || !item.type.startsWith('image/')) continue;
      const blob = item.getAsFile();
      if (!blob) continue;
      const ext = item.type.split('/')[1] || 'png';
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      pastedFiles.push(
        new File([blob], `pasted-${ts}.${ext}`, { type: item.type })
      );
    }
    if (pastedFiles.length > 0) {
      e.preventDefault();
      ingestFiles(pastedFiles);
      setStatus(
        'ship-status',
        `Pasted ${pastedFiles.length} screenshot${pastedFiles.length > 1 ? 's' : ''} from clipboard.`,
        'info'
      );
    }
  });

  async function fileToBase64(file) {
    const buf = await file.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  async function buildPayload() {
    const out = [];
    for (const f of pendingFiles) {
      out.push({
        filename: f.name,
        contentBase64: await fileToBase64(f),
        mediaType:
          f.type && f.type !== 'application/octet-stream' ? f.type : undefined,
      });
    }
    return out;
  }

  async function callParse(payload, ephemeral, userAnswers) {
    const r = await fetch('/api/shipments/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: payload,
        ephemeral,
        userAnswers,
        fxRates: getFxRates(),
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'parse failed');
    return data;
  }

  parseBtn.addEventListener('click', async () => {
    if (pendingFiles.length === 0) return;
    parseBtn.disabled = true;
    setStatus('ship-status', 'Reading files & calling Claude…', 'info');
    try {
      const ephemeral = !!document.getElementById('ship-ephemeral')?.checked;
      const payload = await buildPayload();

      // First-pass extraction
      let data = await callParse(payload, ephemeral);

      // If Claude wants clarification, pop the modal and wait for answers.
      let mergedPayload = payload;
      if (data.pendingClarification && Array.isArray(data.questions)) {
        setStatus(
          'ship-status',
          `${data.questions.length} clarification${data.questions.length === 1 ? '' : 's'} needed…`,
          'info'
        );
        const result = await openClarificationModal(data.questions);
        if (!result) {
          setStatus('ship-status', 'Cancelled. Files still queued.', 'info');
          parseBtn.disabled = pendingFiles.length === 0;
          return;
        }
        const { answers, additionalFiles } = result;
        if (additionalFiles && additionalFiles.length > 0) {
          const extra = await filesToPayload(additionalFiles);
          mergedPayload = payload.concat(extra);
        }
        setStatus('ship-status', 'Re-running extraction with your answers…', 'info');
        data = await callParse(mergedPayload, ephemeral, answers);
      }

      if (!data.shipment) {
        throw new Error('No shipment returned by server.');
      }
      setStatus(
        'ship-status',
        `Created ${data.shipment.refId} — review & edit cells as needed.`,
        'success'
      );
      pendingFiles = [];
      refreshDropState();
      await loadList();
      const newRow = table.querySelector(
        `tr[data-ref="${CSS.escape(data.shipment.refId)}"]`
      );
      newRow?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (err) {
      setStatus('ship-status', err.message, 'error');
    } finally {
      parseBtn.disabled = pendingFiles.length === 0;
    }
  });

  addBlankBtn?.addEventListener('click', async () => {
    setStatus('ship-status', 'Creating blank row…', 'info');
    try {
      const r = await fetch('/api/shipments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'create failed');
      setStatus('ship-status', `Created ${data.refId} — start filling.`, 'success');
      await loadList();
    } catch (err) {
      setStatus('ship-status', err.message, 'error');
    }
  });

  refreshBtn?.addEventListener('click', loadList);
  let searchTimer = null;
  searchInput?.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(loadList, 250);
  });

  // CSV export — downloads the currently-FILTERED rows. Columns mirror
  // the visible table; computed Profit included for convenience.
  document.getElementById('ship-export-csv-btn')?.addEventListener('click', () => {
    const rows = applyFilters(allRows || []);
    if (rows.length === 0) {
      toast('No rows to export.', 'info');
      return;
    }
    const headers = [
      'Ref','Created','Status','Shipper','Receiver','Customer','Pickup',
      'FPOL','POL','POD','Type','Cntr','Qty','CargoType','CargoName',
      'Sell USD','Cost USD','Profit USD','Carrier','BookingRef','Notes',
    ];
    function csvCell(v) {
      if (v == null) return '';
      const s = String(v);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    }
    const lines = [headers.join(',')];
    for (const r of rows) {
      const created = r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : '';
      const status = (r.operationalStatus || '').replace(/_/g, ' ');
      const sell = typeof r.soldRate === 'number' ? r.soldRate : '';
      const cost = typeof r.ourCost === 'number' ? r.ourCost : '';
      const profit = (typeof r.soldRate === 'number' && typeof r.ourCost === 'number')
        ? (r.soldRate - r.ourCost) : '';
      lines.push([
        r.refId, created, status,
        r.shipperName, r.receiverName, r.customerName, r.loadingAddress,
        r.fpol, r.pol, r.pod,
        r.shipmentType, r.containerType, r.containerQuantity,
        r.cargoType, r.cargoName,
        sell, cost, profit,
        r.carrierPreference, r.bookingRef, r.notes,
      ].map(csvCell).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `shipments-${stamp}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'} to CSV.`, 'success');
  });

  // Row data state — allRows is the latest server response, filters
  // narrow it down client-side without re-fetching.
  let allRows = [];
  const filters = {};

  async function loadList() {
    const q = searchInput?.value || '';
    const r = await fetch(
      '/api/shipments?q=' + encodeURIComponent(q)
    ).catch(() => null);
    if (!r) {
      table.innerHTML =
        '<tbody><tr><td class="empty">Network error.</td></tr></tbody>';
      return;
    }
    const data = await r.json();
    if (!r.ok) {
      table.innerHTML = `<tbody><tr><td class="empty">Error: ${esc(data.error || '')}</td></tr></tbody>`;
      return;
    }
    allRows = data.shipments || [];
    renderTable(applyFilters(allRows));
  }

  // Per-column filter logic. Returns rows that match every active
  // filter. Empty filters are skipped. Status / Type use exact
  // equality; everything else is case-insensitive substring.
  function applyFilters(rows) {
    const active = Object.entries(filters).filter(([, v]) => v !== '' && v != null);
    if (active.length === 0) return rows;
    return rows.filter((row) => {
      for (const [key, needle] of active) {
        const col = SHIP_COLS.find((c) => c.key === key);
        if (!col) continue;
        const haystack = filterValueFor(row, col);
        if (col.filter === 'select') {
          if (haystack !== needle) return false;
        } else {
          if (!haystack.toLowerCase().includes(String(needle).toLowerCase())) {
            return false;
          }
        }
      }
      return true;
    });
  }

  function filterValueFor(row, col) {
    if (col.kind === 'status') return row.operationalStatus || '';
    if (col.kind === 'shipment-type') return row.shipmentType || '';
    if (col.kind === 'cargo-modal') {
      return `${row.cargoType || ''} ${row.cargoName || ''}`.trim();
    }
    if (col.kind === 'cost-modal') {
      return row.ourCost == null ? '' : String(row.ourCost);
    }
    if (col.kind === 'profit') {
      const s = row.soldRate, c = row.ourCost;
      return s == null || c == null ? '' : String(s - c);
    }
    if (col.key === 'createdAt' && row.createdAt) {
      return new Date(row.createdAt).toISOString().slice(0, 10);
    }
    const v = row[col.key];
    return v == null ? '' : String(v);
  }

  // Build header band ONCE (label row + filter row) so input focus
  // doesn't drop when the user types. Only the body re-renders on
  // each filter change / data refresh.
  let headerMounted = false;
  function ensureHeaderMounted() {
    if (headerMounted) return;
    table.innerHTML = `${colgroupHtml()}<thead>${headerHtml()}${filterRowHtml()}</thead><tbody></tbody>`;
    wireFilterInputs();
    updateClearFiltersButton();
    wireColumnResize();
    headerMounted = true;
  }

  function renderTable(rows) {
    ensureHeaderMounted();
    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    if (rows.length === 0) {
      const anyFilter = Object.values(filters).some((v) => v !== '' && v != null);
      const msg = anyFilter
        ? 'No shipments match the current filters.'
        : 'No shipments yet. Drop a booking briefing above or click "Add blank row".';
      tbody.innerHTML = `<tr><td colspan="${SHIP_COLS.length + 2}" class="empty">${esc(msg)}</td></tr>`;
      return;
    }
    tbody.innerHTML = rows
      .map((row) => {
        const cells = SHIP_COLS.map((col) => cellHtml(row, col)).join('');
        const arts = Array.isArray(row.artifactsJson) ? row.artifactsJson : [];
        const badge =
          arts.length > 0
            ? `<button type="button" class="ship-attach-badge" data-action="attachments" title="${arts.length} attachment${arts.length === 1 ? '' : 's'}">📎 ${arts.length}</button>`
            : '';
        return `<tr data-ref="${esc(row.refId)}">${cells}<td class="actions-cell">${badge}<button class="ship-delete-btn" data-action="delete" title="Delete">✕</button></td></tr>`;
      })
      .join('');
    wireRowSelection();
    wireCellInteractions(rows);
    wireDeleteButtons();
    wireAttachmentBadges(rows);
    wireRowDropTargets(rows);
    wireRefCopy();
  }

  // Single-click on a Ref cell copies the ref to the clipboard. The
  // ref is the most-copied value (paste into carrier portals, email
  // threads, the DelayPredict tracker), and the cell isn't editable,
  // so a click gesture has nothing else to do.
  function wireRefCopy() {
    table.querySelectorAll('td.ref-cell').forEach((td) => {
      td.title = 'Click to copy';
      td.addEventListener('click', async (e) => {
        e.stopPropagation();
        markActiveCell(td);
        const text = (td.textContent || '').trim();
        if (!text) return;
        await copyText(text);
        flashCell(td);
      });
    });
  }

  let selectedRowRef = null;
  // The "active cell" is the last cell the user clicked. Cmd/Ctrl+C
  // copies its visible text. Persisted as a (refId, fieldKey) tuple
  // so it survives table re-renders (filter input, refresh, etc).
  let activeCell = null; // { refId, key }
  function wireRowSelection() {
    table.querySelectorAll('tbody tr[data-ref]').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        // Don't steal clicks meant for delete buttons / source links.
        if (
          e.target.closest('.ship-delete-btn, .ship-source-link, .actions-cell')
        ) {
          return;
        }
        table
          .querySelectorAll('tbody tr.is-selected')
          .forEach((x) => x.classList.remove('is-selected'));
        tr.classList.add('is-selected');
        selectedRowRef = tr.dataset.ref;
        // Mark the clicked cell as active for Cmd+C copy.
        const td = e.target.closest('td');
        if (td && td.parentElement === tr) markActiveCell(td);
      });
    });
    if (selectedRowRef) {
      const tr = table.querySelector(
        `tr[data-ref="${CSS.escape(selectedRowRef)}"]`
      );
      tr?.classList.add('is-selected');
    }
    // Restore active-cell highlight after a re-render.
    if (activeCell) {
      const sel = `tr[data-ref="${CSS.escape(activeCell.refId)}"] td[data-field="${CSS.escape(activeCell.key)}"]`;
      table.querySelector(sel)?.classList.add('is-active-cell');
    }
  }

  function markActiveCell(td) {
    table
      .querySelectorAll('td.is-active-cell')
      .forEach((x) => x.classList.remove('is-active-cell'));
    td.classList.add('is-active-cell');
    const tr = td.closest('tr[data-ref]');
    const key = td.getAttribute('data-field');
    if (tr && key) activeCell = { refId: tr.dataset.ref, key };
  }

  function cellDisplayText(td) {
    // Prefer a more meaningful label for cells that don't render text:
    //   - Status: read the operational status from the row.
    //   - Attachments badge: count.
    //   - Otherwise use the rendered textContent.
    const tr = td.closest('tr[data-ref]');
    const refId = tr?.dataset.ref;
    if (refId) {
      const row = (allRows || []).find((r) => r.refId === refId);
      if (row && td.classList.contains('track-cell')) {
        return row.operationalStatus || '';
      }
    }
    return (td.textContent || '').trim();
  }

  async function copyText(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for older browsers / non-secure contexts.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) { /* ignore */ }
      ta.remove();
    }
  }

  function flashCell(td) {
    td.classList.add('is-copied');
    setTimeout(() => td.classList.remove('is-copied'), 800);
  }

  async function copyActiveCell() {
    const td = table.querySelector('td.is-active-cell');
    if (!td) return false;
    const text = cellDisplayText(td);
    if (!text) return false;
    await copyText(text);
    flashCell(td);
    return true;
  }

  async function copyRowAsTsv(tr) {
    if (!tr) return;
    const cells = Array.from(tr.querySelectorAll('td')).filter(
      (td) => !td.classList.contains('actions-cell')
    );
    const text = cells.map((td) => cellDisplayText(td)).join('\t');
    await copyText(text);
    cells.forEach((td) => flashCell(td));
  }

  // Right-click context menu on cells: Copy cell / Copy row.
  let openMenu = null;
  function closeContextMenu() {
    if (!openMenu) return;
    openMenu.remove();
    openMenu = null;
    document.removeEventListener('mousedown', onDocMouseDown, true);
    document.removeEventListener('keydown', onCtxKey, true);
  }
  function onDocMouseDown(e) {
    if (openMenu && !openMenu.contains(e.target)) closeContextMenu();
  }
  function onCtxKey(e) {
    if (e.key === 'Escape') closeContextMenu();
  }
  function showCellContextMenu(td, x, y) {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'cell-context-menu';
    menu.innerHTML = `
      <button type="button" data-action="copy-cell">Copy cell</button>
      <button type="button" data-action="copy-row">Copy row (TSV)</button>
    `;
    document.body.appendChild(menu);
    // Position, flipping if it would overflow the viewport.
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const left = x + mw + 8 > window.innerWidth ? x - mw : x;
    const top = y + mh + 8 > window.innerHeight ? y - mh : y;
    menu.style.left = `${Math.max(4, left + window.scrollX)}px`;
    menu.style.top = `${Math.max(4, top + window.scrollY)}px`;
    openMenu = menu;
    menu.querySelector('[data-action="copy-cell"]').addEventListener('click', async () => {
      markActiveCell(td);
      await copyActiveCell();
      closeContextMenu();
    });
    menu.querySelector('[data-action="copy-row"]').addEventListener('click', async () => {
      await copyRowAsTsv(td.closest('tr'));
      closeContextMenu();
    });
    setTimeout(() => {
      document.addEventListener('mousedown', onDocMouseDown, true);
      document.addEventListener('keydown', onCtxKey, true);
    }, 0);
  }
  // Attach contextmenu handler once on the table (delegated).
  if (!table.__cellCtxMenuInstalled) {
    table.addEventListener('contextmenu', (e) => {
      const td = e.target.closest('tbody td');
      if (!td) return;
      // Don't override native menu when text is actually selected
      // (user wants to copy a sub-string they highlighted).
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      e.preventDefault();
      showCellContextMenu(td, e.clientX, e.clientY);
    });
    table.__cellCtxMenuInstalled = true;
  }
  // Cmd/Ctrl+C copies the active cell when there's no native selection.
  if (!window.__shipCopyKeyInstalled) {
    document.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== 'c' && e.key !== 'C') return;
      // Only handle when the Shipments tab is active.
      const tabActive = document
        .getElementById('tab-shipments')
        ?.classList.contains('active');
      if (!tabActive) return;
      // Don't fight with native copy of selected text or input fields.
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      const td = table.querySelector('td.is-active-cell');
      if (!td) return;
      e.preventDefault();
      copyActiveCell();
    });
    window.__shipCopyKeyInstalled = true;
  }

  function wireCellInteractions(rows) {
    const byRef = new Map(rows.map((r) => [r.refId, r]));
    table.querySelectorAll('tbody td[data-field]').forEach((td) => {
      const kind = td.getAttribute('data-kind');
      const field = td.getAttribute('data-field');
      const tr = td.closest('tr');
      const refId = tr?.dataset.ref;
      if (!refId) return;
      const row = byRef.get(refId);
      if (!row) return;

      // Our Cost cell:
      //   single click → compact breakdown panel (review the audit trail)
      //   double click → inline edit (manually override the total)
      if (kind === 'cost-modal') {
        let clickTimer = null;
        td.addEventListener('click', (e) => {
          e.stopPropagation();
          if (clickTimer) return;
          clickTimer = setTimeout(() => {
            clickTimer = null;
            openBreakdownModal('cost', row, refId, td);
          }, 220);
        });
        td.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          if (clickTimer) {
            clearTimeout(clickTimer);
            clickTimer = null;
          }
          startInlineEdit(td, refId, 'ourCost', { type: 'number', side: 'cost' });
        });
        return;
      }

      // Sell cell mirrors the Cost cell behaviour.
      if (kind === 'sell-modal') {
        let clickTimer = null;
        td.addEventListener('click', (e) => {
          e.stopPropagation();
          if (clickTimer) return;
          clickTimer = setTimeout(() => {
            clickTimer = null;
            openBreakdownModal('sold', row, refId, td);
          }, 220);
        });
        td.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          if (clickTimer) {
            clearTimeout(clickTimer);
            clickTimer = null;
          }
          startInlineEdit(td, refId, 'soldRate', { type: 'number', side: 'sold' });
        });
        return;
      }

      // Profit cell is read-only; nothing to wire.
      if (kind === 'profit') return;

      // Notes / Cargo / short-modal → double-click opens modal
      if (kind === 'notes-modal' || kind === 'cargo-modal' || kind === 'short-modal') {
        td.addEventListener('dblclick', () => {
          if (kind === 'cargo-modal') openCargoModal(row, refId);
          else if (kind === 'notes-modal') openTextModal('Notes', row.notes, async (v) => {
            await patchField(refId, 'notes', v);
            td.textContent = truncate(v || '', 50);
            td.classList.toggle('cell-empty', !v);
          });
          else openTextModal('Loading address', row.loadingAddress, async (v) => {
            await patchField(refId, 'loadingAddress', v);
            td.textContent = truncate(v || '', 35);
            td.classList.toggle('cell-empty', !v);
          });
        });
        return;
      }

      // Status → single-click opens dropdown. Stop propagation so the
      // row-click handler doesn't also try to mark this cell active
      // while the picker is mid-render. Pass the MAPPED status value
      // so legacy stored values (pending_invoice, shipped, etc.) show
      // the right option pre-selected in the dropdown.
      if (kind === 'status') {
        td.addEventListener('click', (e) => {
          e.stopPropagation();
          // Already open — don't re-render the picker mid-interaction.
          if (td.querySelector('select')) return;
          const mappedCurrent = statusFor(row.operationalStatus).value;
          openStatusPicker(td, refId, mappedCurrent);
        });
        return;
      }

      // Shipment Type → double-click opens dropdown
      if (kind === 'shipment-type') {
        td.addEventListener('dblclick', () => {
          openShipmentTypePicker(td, refId, row.shipmentType || '');
        });
        return;
      }

      // Generic editable text/number → double-click activates contenteditable
      td.addEventListener('dblclick', () => {
        const original = td.textContent;
        td.contentEditable = 'true';
        td.classList.add('is-editing');
        td.focus();
        // Select all
        const range = document.createRange();
        range.selectNodeContents(td);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        function commit(save) {
          td.contentEditable = 'false';
          td.classList.remove('is-editing');
          const newVal = td.textContent.trim();
          if (!save || newVal === original.trim()) {
            td.textContent = original;
            return;
          }
          patchField(
            refId,
            field,
            td.dataset.type === 'number'
              ? newVal === ''
                ? null
                : Number(newVal.replace(/[^\d.\-]/g, ''))
              : newVal === ''
                ? null
                : newVal
          )
            .then(() => {
              td.classList.add('is-saved');
              setTimeout(() => td.classList.remove('is-saved'), 1200);
              td.classList.toggle('cell-empty', newVal === '');
            })
            .catch((err) => {
              td.textContent = original;
              toast('Save failed: ' + err.message, 'error');
            });
        }
        td.addEventListener('blur', () => commit(true), { once: true });
        td.addEventListener('keydown', function onKey(e) {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            td.removeEventListener('keydown', onKey);
            commit(true);
            td.blur();
          } else if (e.key === 'Escape') {
            td.removeEventListener('keydown', onKey);
            commit(false);
            td.blur();
          }
        });
      });
    });
  }

  async function patchField(refId, field, value) {
    const r = await fetch(`/api/shipments/${encodeURIComponent(refId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'save failed');
    return data;
  }

  // Inline-edit a cell. Used by Our Cost (which doesn't go through the
  // generic editable-cell wiring because click-vs-dblclick is special).
  function startInlineEdit(td, refId, field, opts = {}) {
    const original = td.textContent;
    td.contentEditable = 'true';
    td.classList.add('is-editing');
    td.focus();
    const range = document.createRange();
    range.selectNodeContents(td);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    function commit(save) {
      td.contentEditable = 'false';
      td.classList.remove('is-editing');
      const newVal = td.textContent.trim();
      if (!save || newVal === original.trim()) {
        td.textContent = original;
        return;
      }
      const value =
        opts.type === 'number'
          ? newVal === ''
            ? null
            : Number(newVal.replace(/[^\d.\-]/g, ''))
          : newVal === ''
            ? null
            : newVal;

      // For Cost / Sell cells (opts.side present), routing through the
      // breakdown endpoint with set-total replaces the breakdown with a
      // single "Manual total" item, so the panel always sums to the
      // displayed value. Other fields go through the generic PATCH.
      const promise = opts.side
        ? fetch(`/api/shipments/${encodeURIComponent(refId)}/breakdown`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              side: opts.side,
              op: 'set-total',
              amount: value == null ? 0 : value,
            }),
          }).then(async (r) => {
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || 'save failed');
            return data;
          })
        : patchField(refId, field, value);

      promise
        .then(() => {
          td.classList.add('is-saved');
          setTimeout(() => td.classList.remove('is-saved'), 1200);
          td.classList.toggle('cell-empty', newVal === '');
          // Reload so derived columns (Profit) recompute.
          loadList();
        })
        .catch((err) => {
          td.textContent = original;
          toast('Save failed: ' + err.message, 'error');
        });
    }
    td.addEventListener('blur', () => commit(true), { once: true });
    td.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        td.removeEventListener('keydown', onKey);
        commit(true);
        td.blur();
      } else if (e.key === 'Escape') {
        td.removeEventListener('keydown', onKey);
        commit(false);
        td.blur();
      }
    });
  }

  function openStatusPicker(td, refId, current) {
    const sel = document.createElement('select');
    sel.className = 'cell-inline-select';
    sel.innerHTML = STATUS_OPTIONS.map(
      (o) =>
        `<option value="${esc(o.value)}"${o.value === current ? ' selected' : ''}>${o.icon}  ${esc(o.label)}</option>`
    ).join('');
    const previousIcon = td.querySelector('.status-icon')?.outerHTML;
    td.replaceChildren(sel);
    sel.focus();
    // Open the dropdown immediately on the first click so the user
    // doesn't have to click the cell, then click the select.
    if (typeof sel.showPicker === 'function') {
      try { sel.showPicker(); } catch (_) { /* unsupported in some browsers */ }
    }

    // The flag prevents races between `change` and `blur` (both fire
    // when the user picks an option — change is synchronous, blur
    // follows when focus leaves the select). Whichever fires first
    // owns the save; the other becomes a no-op.
    let resolved = false;

    // Helper: build the icon span as a node (not via innerHTML). Using
    // replaceChildren below is more robust than innerHTML because the
    // browser may relocate the <select> internally during blur/focus
    // transitions, and innerHTML's implicit remove-children step
    // throws "The node to be removed is no longer a child of this
    // node" when that happens.
    function makeIconSpan(icon) {
      const span = document.createElement('span');
      span.className = 'status-icon';
      span.textContent = icon;
      return span;
    }
    function restore() {
      const fallbackIcon = '⚪';
      let restoredIcon = fallbackIcon;
      if (previousIcon) {
        // previousIcon is the outerHTML string captured at open time;
        // extract the text inside the span to rebuild the node safely.
        const m = /<span[^>]*>([\s\S]*?)<\/span>/i.exec(previousIcon);
        if (m && m[1]) restoredIcon = m[1];
      }
      try {
        td.replaceChildren(makeIconSpan(restoredIcon));
      } catch {
        /* td detached from DOM — nothing to restore */
      }
    }
    async function commit(rawVal) {
      if (resolved) return;
      resolved = true;
      const newVal = rawVal || null;
      const s = statusFor(newVal);

      // OPTIMISTIC UPDATE — paint the new icon immediately so the user
      // sees feedback within one frame, regardless of network latency.
      // The PATCH happens in the background; we only roll back if it
      // actually fails.
      if (td.isConnected) {
        try {
          td.replaceChildren(makeIconSpan(s.icon));
          td.title = s.label;
          td.classList.add('is-saved');
          setTimeout(() => td.classList.remove('is-saved'), 1200);
        } catch {
          /* td detached — next render will reflect the new state. */
        }
      }
      // Keep the in-memory row in sync so any concurrent re-render
      // (filter input, refresh) shows the new icon.
      const ref = (allRows || []).find((r) => r.refId === refId);
      const prevValue = ref ? ref.operationalStatus : current;
      if (ref) ref.operationalStatus = newVal;

      // Persist in the background. If it fails, revert UI + data.
      try {
        await patchField(refId, 'operationalStatus', newVal);
      } catch (err) {
        if (td.isConnected) {
          try {
            const prevS = statusFor(prevValue);
            td.replaceChildren(makeIconSpan(prevS.icon));
            td.title = prevS.label;
          } catch {
            /* ignore */
          }
        }
        if (ref) ref.operationalStatus = prevValue;
        toast('Save failed (status reverted): ' + err.message, 'error');
      }
    }

    sel.addEventListener('change', () => commit(sel.value));
    sel.addEventListener('blur', () => {
      if (resolved) return;
      // If the select's value differs from `current`, a pick happened
      // (some browsers don't fire `change` consistently with showPicker
      // — especially when picking the FIRST option of an unselected
      // dropdown). Treat it as a commit rather than a cancel.
      if ((sel.value || '') !== (current || '')) {
        commit(sel.value);
        return;
      }
      resolved = true;
      restore();
    });
    sel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!resolved) {
          resolved = true;
          restore();
        }
        sel.blur();
      } else if (e.key === 'Enter') {
        // Enter commits the highlighted option (same as change).
        e.preventDefault();
        commit(sel.value);
      }
    });
  }

  function openShipmentTypePicker(td, refId, current) {
    const sel = document.createElement('select');
    sel.className = 'cell-inline-select';
    sel.innerHTML = SHIPMENT_TYPE_OPTIONS.map(
      (o) => `<option value="${esc(o)}"${o === current ? ' selected' : ''}>${esc(o || '— none —')}</option>`
    ).join('');
    const previousText = td.textContent;
    td.replaceChildren(sel);
    sel.focus();
    async function close(save) {
      if (save) {
        try {
          const newVal = sel.value || null;
          await patchField(refId, 'shipmentType', newVal);
          td.textContent = newVal || '';
          td.classList.toggle('cell-empty', !newVal);
          td.classList.add('is-saved');
          setTimeout(() => td.classList.remove('is-saved'), 1200);
          return;
        } catch (err) {
          toast('Save failed: ' + err.message, 'error');
        }
      }
      td.textContent = previousText;
    }
    sel.addEventListener('change', () => close(true));
    sel.addEventListener('blur', () => close(true), { once: true });
  }

  function wireTrackingDots(rows) {
    const byRef = new Map(rows.map((r) => [r.refId, r]));
    table.querySelectorAll('button[data-action="track-detail"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tr = btn.closest('tr');
        const refId = tr?.dataset.ref;
        if (!refId) return;
        const row = byRef.get(refId);
        if (!row) return;
        openTrackingDetail(row);
      });
    });
  }

  function openTrackingDetail(row) {
    const t = row.tracking || { color: 'gray', label: 'Not tracked', data: null };
    const d = t.data;
    const detail = document.getElementById('track-detail-modal');
    const body = document.getElementById('track-detail-body');
    const refLabel = document.getElementById('track-detail-ref');
    if (!detail || !body) return;

    refLabel.textContent = row.refId;
    if (!d) {
      body.innerHTML =
        `<p class="muted">${esc(t.label)}.</p>` +
        `<p class="muted small">No DelayPredict shipment matches this ref. Either DelayPredict isn't running, or no shipment has been created there with personal_ref = <code>${esc(row.refId)}</code>.</p>`;
    } else {
      const rows_ = [
        ['Status', d.status || '—'],
        ['ETD', d.etd || '—'],
        ['ETA', d.eta || '—'],
        ['Actual arrival', d.actual_arrival || '—'],
        [
          'Actual delay',
          d.actual_delay_days != null ? `${d.actual_delay_days} day(s)` : '—',
        ],
        [
          'Predicted arrival',
          d.predicted_arrival ? d.predicted_arrival.slice(0, 16).replace('T', ' ') : '—',
        ],
        [
          'Predicted delay',
          d.predicted_delay_days != null
            ? `${d.predicted_delay_days} day(s)`
            : '—',
        ],
        ['Vessel', d.vessel_name || '—'],
        ['Risk score', d.risk_score != null ? String(d.risk_score) : '—'],
        [
          'Last tracking event',
          d.tracking_last_event_at
            ? new Date(d.tracking_last_event_at).toISOString().slice(0, 16).replace('T', ' ')
            : '—',
        ],
      ];
      const inner = rows_
        .map(
          ([k, v]) =>
            `<div class="track-detail-row"><span class="muted">${esc(k)}</span><strong>${esc(v)}</strong></div>`
        )
        .join('');
      body.innerHTML =
        `<div class="track-detail-status track-status-${esc(t.color)}"><span class="track-dot dot-${esc(t.color)}"></span> ${esc(t.label)}</div>` +
        `<div class="track-detail-grid">${inner}</div>` +
        (d.recommendation
          ? `<p class="muted small" style="margin-top: 10px"><em>${esc(d.recommendation)}</em></p>`
          : '');
    }
    detail.hidden = false;

    // Wire close + refresh handlers (idempotent)
    const closeBtn = document.getElementById('track-detail-close');
    const refreshBtn = document.getElementById('track-detail-refresh');
    function close() {
      detail.hidden = true;
      closeBtn?.removeEventListener('click', close);
      refreshBtn?.removeEventListener('click', refresh);
      detail.querySelector('.image-modal-backdrop')?.removeEventListener('click', close);
    }
    async function refresh() {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Refreshing…';
      try {
        const r = await fetch(
          `/api/shipments/${encodeURIComponent(row.refId)}/refresh-tracking`,
          { method: 'POST' }
        );
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'refresh failed');
        // Re-fetch the whole list (cheap; cache on server is now invalidated).
        await loadList();
        close();
      } catch (err) {
        toast('Refresh failed: ' + err.message, 'error');
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = '↻ Refresh tracking';
      }
    }
    closeBtn?.addEventListener('click', close);
    refreshBtn?.addEventListener('click', refresh);
    detail.querySelector('.image-modal-backdrop')?.addEventListener('click', close);
  }

  // Default starting widths per column (px). Used when no user-saved
  // value exists for that key. Tweak by feel — user will resize anyway.
  const COL_DEFAULT_WIDTHS = {
    operationalStatus: 40,
    refId: 95,
    createdAt: 100,
    shipperName: 130,
    receiverName: 130,
    customerName: 150,
    loadingAddress: 180,
    fpol: 90,
    pol: 90,
    pod: 90,
    shipmentType: 60,
    containerType: 90,
    containerQuantity: 50,
    cargo: 160,
    soldRate: 110,
    ourCost: 110,
    profit: 110,
    carrierPreference: 110,
    bookingRef: 110,
    notes: 200,
  };
  // Column widths persist per browser. Stored as { [colKey]: pxNumber }.
  const COL_WIDTHS_KEY = 'freight.shipments.colWidths';
  function loadColWidths() {
    try {
      const raw = localStorage.getItem(COL_WIDTHS_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch {
      return {};
    }
  }
  function saveColWidths(map) {
    try {
      localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(map));
    } catch {
      /* quota / private mode — silently ignore */
    }
  }
  let columnWidths = loadColWidths();

  // <colgroup> drives the resizable widths. Each <col> maps 1:1 to a
  // SHIP_COLS entry, plus a final <col> for the actions column.
  function colgroupHtml() {
    const cols = SHIP_COLS.map((c) => {
      const saved = columnWidths[c.key];
      const def = COL_DEFAULT_WIDTHS[c.key];
      const w = Number.isFinite(saved) ? saved : def;
      const style = w ? ` style="width:${Number(w)}px"` : '';
      return `<col data-col-key="${esc(c.key)}"${style}>`;
    }).join('');
    return `<colgroup>${cols}<col data-col-key="__actions" style="width:90px"></colgroup>`;
  }

  function headerHtml() {
    return (
      '<tr class="ship-th-row">' +
      SHIP_COLS.map(
        (c) =>
          `<th data-col-key="${esc(c.key)}">${esc(c.label)}<span class="col-resize-handle" data-col-key="${esc(c.key)}" title="Drag to resize"></span></th>`
      ).join('') +
      '<th class="actions-cell" title="Clear all filters"><button type="button" id="ship-clear-filters" class="ship-clear-filters" hidden>✕ Clear</button></th></tr>'
    );
  }

  function wireColumnResize() {
    table.querySelectorAll('.col-resize-handle').forEach((handle) => {
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const key = handle.getAttribute('data-col-key');
        const col = table.querySelector(`col[data-col-key="${CSS.escape(key)}"]`);
        if (!col) return;
        // Use the current rendered width as the start.
        const th = handle.parentElement;
        const startWidth = th.getBoundingClientRect().width;
        const startX = e.clientX;
        document.body.classList.add('is-col-resizing');
        function onMove(ev) {
          const delta = ev.clientX - startX;
          const next = Math.max(40, Math.round(startWidth + delta));
          col.style.width = `${next}px`;
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.classList.remove('is-col-resizing');
          // Persist the final value (read off the col, not startWidth+delta,
          // so any min-clamp from above is captured).
          const final = parseInt(col.style.width, 10);
          if (Number.isFinite(final) && final > 0) {
            columnWidths[key] = final;
            saveColWidths(columnWidths);
          }
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }

  // Per-column filter row. Status + Type are <select>s with exact-match
  // values; every other column gets a small text input that does
  // case-insensitive substring filtering.
  function filterRowHtml() {
    const cells = SHIP_COLS.map((c) => {
      if (c.kind === 'status') {
        const opts = STATUS_OPTIONS.map(
          (o) => `<option value="${esc(o.value)}">${esc(o.label === '— none —' ? 'All' : o.label)}</option>`
        ).join('');
        c.filter = 'select';
        return `<th class="filter-th"><select class="filter-input" data-filter-key="${c.key}">${opts}</select></th>`;
      }
      if (c.kind === 'shipment-type') {
        const opts = SHIPMENT_TYPE_OPTIONS.map(
          (v) => `<option value="${esc(v)}">${esc(v === '' ? 'All' : v)}</option>`
        ).join('');
        c.filter = 'select';
        return `<th class="filter-th"><select class="filter-input" data-filter-key="${c.key}">${opts}</select></th>`;
      }
      c.filter = 'text';
      return `<th class="filter-th"><input type="search" class="filter-input" data-filter-key="${c.key}" placeholder="filter…" /></th>`;
    }).join('');
    return `<tr class="ship-filter-row">${cells}<th class="filter-th"></th></tr>`;
  }

  function wireFilterInputs() {
    table.querySelectorAll('.filter-input').forEach((el) => {
      const key = el.getAttribute('data-filter-key');
      const evt = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evt, () => {
        const v = el.value;
        if (v === '' || v == null) delete filters[key];
        else filters[key] = v;
        updateClearFiltersButton();
        renderTable(applyFilters(allRows));
      });
    });
    const clearBtn = document.getElementById('ship-clear-filters');
    clearBtn?.addEventListener('click', () => {
      Object.keys(filters).forEach((k) => delete filters[k]);
      table.querySelectorAll('.filter-input').forEach((el) => {
        el.value = '';
      });
      updateClearFiltersButton();
      renderTable(applyFilters(allRows));
    });
  }

  function updateClearFiltersButton() {
    const btn = document.getElementById('ship-clear-filters');
    if (!btn) return;
    btn.hidden = Object.keys(filters).length === 0;
  }

  function cellHtml(row, col) {
    // Status — icon (emoji) hint, single-click opens the picker.
    if (col.kind === 'status') {
      const s = statusFor(row.operationalStatus);
      const dpBits = [];
      if (row.tracking?.data?.eta) dpBits.push(`ETA ${row.tracking.data.eta}`);
      if (row.tracking?.data?.vessel_name) dpBits.push(row.tracking.data.vessel_name);
      const tooltip = [s.label, ...dpBits].filter(Boolean).join(' · ');
      return `<td class="cell track-cell" data-field="operationalStatus" data-kind="status" title="${esc(tooltip)}" aria-label="${esc(tooltip)}"><span class="status-icon">${s.icon}</span></td>`;
    }

    // Merged Cargo — icon (cargo type) + truncated name. Click for modal.
    if (col.kind === 'cargo-modal') {
      const t = (row.cargoType || '').toLowerCase();
      const n = row.cargoName || '';
      const icon = CARGO_ICON[t] || '';
      const cls = ['cell', 'cell-cargo'];
      if (!t && !n) cls.push('cell-empty');
      const tip = [t, n].filter(Boolean).join(' — ');
      const inner = icon
        ? `<span class="cargo-icon" title="${esc(t)}">${icon}</span> ${esc(truncate(n, 36))}`
        : esc(truncate(n, 40));
      return `<td class="${cls.join(' ')}" data-field="cargo" data-kind="cargo-modal" title="${esc(tip)} — double-click to edit">${inner}</td>`;
    }

    // Notes — preview only, click/double-click for modal with full text.
    if (col.kind === 'notes-modal') {
      const v = row.notes || '';
      const cls = ['cell', 'cell-notes'];
      if (!v) cls.push('cell-empty');
      return `<td class="${cls.join(' ')}" data-field="notes" data-kind="notes-modal" title="Double-click to edit">${esc(truncate(v, 50))}</td>`;
    }

    // Long-text fields like Loading address — also expand on double-click.
    if (col.kind === 'short-modal') {
      const v = row[col.key] || '';
      const cls = ['cell', col.editable ? 'cell-editable' : ''];
      if (!v) cls.push('cell-empty');
      return `<td class="${cls.join(' ')}" data-field="${col.key}" data-kind="short-modal" data-type="${col.type || 'text'}">${esc(truncate(v, 35))}</td>`;
    }

    // Shipment Type — short text label. Double-click opens a dropdown
    // with all supported modes (FCL/LCL/RORO/BreakBulk/LTL/FTL/AIR).
    if (col.kind === 'shipment-type') {
      const v = row.shipmentType || '';
      const cls = ['cell', 'cell-editable', 'cell-shipment-type'];
      if (!v) cls.push('cell-empty');
      return `<td class="${cls.join(' ')}" data-field="shipmentType" data-kind="shipment-type" title="${esc(v || 'Double-click to set type')}">${esc(v)}</td>`;
    }

    // ---- Money cells: ALWAYS rendered in USD ----------------------
    // We agreed every total on the dashboard is in USD. Even if a row
    // was created before the FX-normalisation work and still carries
    // a non-USD currency tag in the DB, the cell shows USD. Going
    // forward, the server stores USD-only, so old labels die out as
    // rows get touched.

    // Sell — editable inline; opens breakdown on single click.
    if (col.kind === 'money') {
      const v = row[col.key];
      const cls = ['cell', 'cell-money', col.editable ? 'cell-editable' : ''];
      if (v == null || v === '') cls.push('cell-empty');
      const display = v == null || v === '' ? '' : formatMoney(Number(v), 'USD');
      const editAttrs = col.editable
        ? ` data-field="${col.key}" data-type="number"`
        : '';
      return `<td class="${cls.filter(Boolean).join(' ')}"${editAttrs}>${esc(display)}</td>`;
    }

    // Sell breakdown cell.
    if (col.kind === 'sell-modal') {
      const total = row.soldRate;
      const items = Array.isArray(row.soldBreakdownJson) ? row.soldBreakdownJson : [];
      const cls = ['cell', 'cell-money'];
      if (total == null) cls.push('cell-empty');
      const display = total != null ? formatMoney(total, 'USD') : '';
      const hint = items.length > 0
        ? `${items.length} line item${items.length === 1 ? '' : 's'} — click to edit`
        : 'No line items yet — click to add or set manually';
      return `<td class="${cls.join(' ')}" data-field="soldRate" data-kind="sell-modal" title="${esc(hint)}">${esc(display)}</td>`;
    }

    // Our Cost — total only; click opens compact breakdown modal.
    if (col.kind === 'cost-modal') {
      const total = row.ourCost;
      const items = Array.isArray(row.costBreakdownJson) ? row.costBreakdownJson : [];
      const cls = ['cell', 'cell-cost'];
      if (total == null) cls.push('cell-empty');
      const display = total != null ? formatMoney(total, 'USD') : '';
      const hint = items.length > 0
        ? `${items.length} line item${items.length === 1 ? '' : 's'} — click for breakdown`
        : 'No cost items yet — drop an invoice/quote on this row';
      return `<td class="${cls.join(' ')}" data-field="ourCost" data-kind="cost-modal" title="${esc(hint)}">${esc(display)}</td>`;
    }

    // Estimated profit — soldRate − ourCost; computed at render time.
    if (col.kind === 'profit') {
      const sold = typeof row.soldRate === 'number' ? row.soldRate : null;
      const cost = typeof row.ourCost === 'number' ? row.ourCost : null;
      const cls = ['cell', 'cell-profit'];
      let display = '';
      if (sold != null && cost != null) {
        const p = sold - cost;
        cls.push(p > 0 ? 'profit-positive' : p < 0 ? 'profit-negative' : 'profit-zero');
        display = formatMoney(p, 'USD');
      } else {
        cls.push('cell-empty');
      }
      return `<td class="${cls.join(' ')}" data-field="profit" data-kind="profit">${esc(display)}</td>`;
    }

    // Generic
    const raw = row[col.key];
    let display;
    if (col.key === 'createdAt' && raw) {
      display = new Date(raw).toISOString().slice(0, 10);
    } else if (col.key === 'containerType' && raw) {
      // Embed the quantity inline so it's visible even if the user
      // doesn't scroll to the dedicated Qty column.
      const q = row.containerQuantity;
      display = q && q > 1 ? `${raw} × ${q}` : String(raw);
    } else if (raw == null || raw === '') {
      display = '';
    } else {
      display = String(raw);
    }
    const cls = ['cell', col.editable ? 'cell-editable' : ''];
    if (col.cls) cls.push(col.cls);
    if (display === '') cls.push('cell-empty');
    const editAttrs = col.editable
      ? ` data-field="${col.key}" data-type="${col.type || 'text'}"`
      : '';
    return `<td class="${cls.filter(Boolean).join(' ')}"${editAttrs}>${esc(display)}</td>`;
  }

  function wireCellEditors() {
    table.querySelectorAll('td.cell-editable').forEach((td) => {
      const original = td.textContent;
      td.addEventListener('focus', () => {
        td.classList.add('is-editing');
      });
      td.addEventListener('blur', async () => {
        td.classList.remove('is-editing');
        const newVal = td.textContent.trim();
        if (newVal === original.trim()) return;
        const tr = td.closest('tr');
        const refId = tr?.dataset.ref;
        const field = td.dataset.field;
        const type = td.dataset.type || 'text';
        if (!refId || !field) return;
        td.classList.add('is-saving');
        try {
          const value =
            type === 'number'
              ? newVal === ''
                ? null
                : Number(newVal.replace(/[^\d.\-]/g, ''))
              : newVal === ''
                ? null
                : newVal;
          const r = await fetch(
            `/api/shipments/${encodeURIComponent(refId)}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ [field]: value }),
            }
          );
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || 'save failed');
          td.classList.remove('is-saving');
          td.classList.add('is-saved');
          setTimeout(() => td.classList.remove('is-saved'), 1200);
          if (newVal === '') td.classList.add('cell-empty');
          else td.classList.remove('cell-empty');
        } catch (err) {
          td.classList.remove('is-saving');
          td.textContent = original;
          toast('Save failed: ' + err.message, 'error');
        }
      });
      td.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          td.blur();
        } else if (e.key === 'Escape') {
          td.textContent = td.dataset.originalOnFocus || '';
          td.blur();
        }
      });
    });
  }

  function wireDeleteButtons() {
    table.querySelectorAll('.ship-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tr = btn.closest('tr');
        const refId = tr?.dataset.ref;
        if (!refId) return;
        if (!confirm(`Delete shipment ${refId}? This can't be undone.`)) return;
        try {
          const r = await fetch(
            `/api/shipments/${encodeURIComponent(refId)}`,
            { method: 'DELETE' }
          );
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || 'delete failed');
          await loadList();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  }

  // ──── Modals: long-text editor + Cargo (type+name) editor ────────────
  function openTextModal(title, value, onSave) {
    const modal = document.getElementById('cell-edit-modal');
    const titleEl = document.getElementById('cell-edit-title');
    const ta = document.getElementById('cell-edit-textarea');
    const cargoFields = document.getElementById('cell-edit-cargo-fields');
    const saveBtn = document.getElementById('cell-edit-save');
    const cancelBtn = document.getElementById('cell-edit-cancel');
    const closeBtn = document.getElementById('cell-edit-close');
    if (!modal) return;
    titleEl.textContent = title;
    ta.hidden = false;
    cargoFields.hidden = true;
    ta.value = value ?? '';
    modal.hidden = false;
    setTimeout(() => ta.focus(), 30);

    function close() {
      modal.hidden = true;
      saveBtn.removeEventListener('click', save);
      cancelBtn.removeEventListener('click', close);
      closeBtn.removeEventListener('click', close);
      modal.querySelector('.image-modal-backdrop')?.removeEventListener('click', close);
    }
    async function save() {
      saveBtn.disabled = true;
      try {
        await onSave(ta.value.trim() || null);
        close();
      } catch (err) {
        toast('Save failed: ' + err.message, 'error');
      } finally {
        saveBtn.disabled = false;
      }
    }
    saveBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', close);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.image-modal-backdrop')?.addEventListener('click', close);
  }

  function openCargoModal(row, refId) {
    const modal = document.getElementById('cell-edit-modal');
    const titleEl = document.getElementById('cell-edit-title');
    const ta = document.getElementById('cell-edit-textarea');
    const cargoFields = document.getElementById('cell-edit-cargo-fields');
    const cargoTypeIn = document.getElementById('cell-edit-cargo-type');
    const cargoNameIn = document.getElementById('cell-edit-cargo-name');
    const saveBtn = document.getElementById('cell-edit-save');
    const cancelBtn = document.getElementById('cell-edit-cancel');
    const closeBtn = document.getElementById('cell-edit-close');
    if (!modal) return;
    titleEl.textContent = 'Cargo (type + description)';
    ta.hidden = true;
    cargoFields.hidden = false;
    cargoTypeIn.value = row.cargoType || '';
    cargoNameIn.value = row.cargoName || '';
    modal.hidden = false;
    setTimeout(() => cargoNameIn.focus(), 30);

    function close() {
      modal.hidden = true;
      saveBtn.removeEventListener('click', save);
      cancelBtn.removeEventListener('click', close);
      closeBtn.removeEventListener('click', close);
      modal.querySelector('.image-modal-backdrop')?.removeEventListener('click', close);
    }
    async function save() {
      saveBtn.disabled = true;
      try {
        const t = cargoTypeIn.value.trim() || null;
        const n = cargoNameIn.value.trim() || null;
        await patchField(refId, 'cargoType', t);
        await patchField(refId, 'cargoName', n);
        await loadList();
        close();
      } catch (err) {
        toast('Save failed: ' + err.message, 'error');
      } finally {
        saveBtn.disabled = false;
      }
    }
    saveBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', close);
    closeBtn.addEventListener('click', close);
    modal.querySelector('.image-modal-backdrop')?.addEventListener('click', close);
  }

  // ── Compact, non-blocking floating panel ──────────────────────────────
  // Renders next to the source cell/button, doesn't dim the dashboard.
  // Click outside or Esc closes it.
  function openCompactPanel(anchorEl, contentNode, opts = {}) {
    // Tear down any existing panel first.
    document.querySelectorAll('.compact-panel').forEach((n) => n.remove());
    const panel = document.createElement('div');
    panel.className = 'compact-panel';
    let head = null;
    if (opts.title) {
      head = document.createElement('div');
      head.className = 'compact-panel-head';
      head.innerHTML = `<strong>${esc(opts.title)}</strong><button type="button" class="compact-panel-close" title="Close (Esc)">✕</button>`;
      panel.appendChild(head);
    }
    const body = document.createElement('div');
    body.className = 'compact-panel-body';
    body.appendChild(contentNode);
    panel.appendChild(body);
    document.body.appendChild(panel);

    // Position near the anchor — prefer below, flip up if no room.
    const rect = anchorEl.getBoundingClientRect();
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    const margin = 8;
    let left = rect.left;
    let top = rect.bottom + margin;
    if (left + pw > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - pw - margin);
    }
    if (top + ph > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - ph - margin);
    }
    panel.style.left = `${Math.round(left + window.scrollX)}px`;
    panel.style.top = `${Math.round(top + window.scrollY)}px`;

    // Drag-to-move from the header. Skips when the user is clicking
    // the close button or selecting text inside the title.
    if (head) {
      head.classList.add('is-draggable');
      head.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        if (e.button !== 0) return;
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const startLeft = parseFloat(panel.style.left) || 0;
        const startTop = parseFloat(panel.style.top) || 0;
        document.body.classList.add('is-panel-dragging');
        function onMove(ev) {
          const nl = startLeft + (ev.clientX - startX);
          const nt = startTop + (ev.clientY - startY);
          // Soft clamp to the viewport so the panel can't be dragged
          // entirely off-screen and abandoned.
          const minLeft = window.scrollX - panel.offsetWidth + 80;
          const maxLeft = window.scrollX + window.innerWidth - 80;
          const minTop = window.scrollY;
          const maxTop = window.scrollY + window.innerHeight - 40;
          panel.style.left = `${Math.min(maxLeft, Math.max(minLeft, nl))}px`;
          panel.style.top = `${Math.min(maxTop, Math.max(minTop, nt))}px`;
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.classList.remove('is-panel-dragging');
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    function close() {
      panel.remove();
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
    }
    function onDocDown(e) {
      if (panel.contains(e.target)) return;
      // A layered modal (file preview) is open in front of this panel.
      // Clicks inside it shouldn't close the panel underneath — the
      // user closes the preview first, then the panel via outside-click
      // or its ✕ button.
      if (e.target.closest && e.target.closest('.file-preview-overlay')) return;
      close();
    }
    function onKey(e) {
      if (e.key !== 'Escape') return;
      // Same deferral: if a preview overlay is open, let it eat the Esc.
      if (document.querySelector('.file-preview-overlay')) return;
      close();
    }
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    panel.querySelector('.compact-panel-close')?.addEventListener('click', close);
    return { panel, close };
  }

  // Unified breakdown panel — used for both Cost (side='cost') and
  // Sell (side='sold'). Lets the user view, add, and delete line
  // items, with the cell total auto-recomputed on every change.
  function openBreakdownModal(side, row, refId, anchorEl) {
    const isCost = side === 'cost';
    const breakdownKey = isCost ? 'costBreakdownJson' : 'soldBreakdownJson';
    const totalKey = isCost ? 'ourCost' : 'soldRate';
    const title = isCost
      ? `Cost breakdown — ${row.refId}`
      : `Sell breakdown — ${row.refId}`;

    // Local copy that we mutate optimistically; reloaded after each
    // server response.
    let items = Array.isArray(row[breakdownKey]) ? row[breakdownKey].slice() : [];
    let total = typeof row[totalKey] === 'number' ? row[totalKey] : null;
    // Hard-pin display currency to USD — the agreed invariant. Legacy
    // rows that still carry a non-USD tag in the DB get rendered USD.
    const cur = 'USD';
    const arts = Array.isArray(row.artifactsJson) ? row.artifactsJson : [];
    // Index of the line item currently in edit mode (-1 = none).
    let editingIndex = -1;

    const wrap = document.createElement('div');
    wrap.className = 'cost-breakdown';

    function render() {
      const qtyForRow = Number(row.containerQuantity) || 0;
      const linesHtml =
        items.length === 0
          ? `<p class="muted small" style="margin: 0 0 8px;">No line items yet.</p>` +
            (isCost
              ? `<p class="muted small" style="margin: 0 0 12px;">Drop an invoice/quote on the row, or add manually below.</p>`
              : `<p class="muted small" style="margin: 0 0 12px;">Add items the customer is being charged (base freight, export declaration, markup, etc.).</p>`)
          : `<div class="cost-lines">${items
              .map((it, i) => {
                if (i === editingIndex) {
                  // Edit form — replaces the static line until the
                  // user clicks Save / Cancel.
                  const multToggle =
                    qtyForRow > 1
                      ? `<label class="bd-edit-multiply">
                          <input type="checkbox" class="bd-edit-mult" />
                          <span>× ${qtyForRow} containers</span>
                        </label>`
                      : '';
                  return `<div class="cost-line cost-line-editing" data-i="${i}">
                    <input class="bd-edit-name" type="text" value="${esc(it.name || '')}" placeholder="Name" />
                    <input class="bd-edit-amount" type="number" step="0.01" value="${Number(it.amount) || 0}" />
                    <button type="button" class="bd-edit-save" data-i="${i}" title="Save">✓</button>
                    <button type="button" class="bd-edit-cancel" data-i="${i}" title="Cancel">✕</button>
                    ${multToggle}
                  </div>`;
                }
                const amt = formatMoney(Number(it.amount) || 0, 'USD');
                const src = it.sourceFile
                  ? ` <span class="muted small">· ${esc(it.sourceFile)}</span>`
                  : '';
                return `<div class="cost-line cost-line-clickable" data-i="${i}" title="Click to edit">
                  <span class="cost-line-name">${esc(it.name || '—')}</span>
                  <span class="cost-line-amount">${esc(amt)}</span>${src}
                  <button type="button" class="cost-line-remove" data-i="${i}" title="Remove">✕</button>
                </div>`;
              })
              .join('')}</div>` +
            (total != null
              ? `<div class="cost-total"><span>Total</span><span>${esc(formatMoney(total, cur))}</span></div>`
              : '');

      // Currency selector: USD default. When the user picks a non-USD
      // option, the server converts using the calc-panel rate before
      // saving, and the line item is stored in USD with an annotation
      // showing the original amount + rate.
      // Multiply-by-quantity toggle: per-container amounts × N. OFF by
      // default — most user-entered figures are already shipment-level
      // totals, so silent auto-multiplying would inflate them.
      const qty = Number(row.containerQuantity) || 0;
      const multiplyToggleHtml =
        qty > 1
          ? `<label class="bd-add-multiply-row">
              <input type="checkbox" class="bd-add-multiply" />
              <span>× ${qty} containers (per-container amount — multiply for total)</span>
            </label>`
          : '';
      const addFormHtml = `
        <form class="bd-add-form">
          <input class="bd-add-name" type="text" placeholder="Line item name" required />
          <input class="bd-add-amount" type="number" step="0.01" placeholder="Amount" required />
          <select class="bd-add-currency" title="Currency — non-USD will be auto-converted to USD">
            <option value="USD" selected>USD</option>
            <option value="CAD">CAD</option>
            <option value="EUR">EUR</option>
            <option value="GBP">GBP</option>
            <option value="AUD">AUD</option>
            <option value="JPY">JPY</option>
            <option value="CNY">CNY</option>
          </select>
          <button type="submit" class="bd-add-btn">+ Add</button>
          ${multiplyToggleHtml}
        </form>
      `;

      let extraHtml = '';
      // Re-check button only on the cost panel (extracts from files).
      if (isCost && arts.length > 0) {
        extraHtml = `<button type="button" class="cost-recheck-btn">🔄 Re-check costs from ${arts.length} saved file${arts.length > 1 ? 's' : ''}</button>`;
      }

      wrap.innerHTML = linesHtml + addFormHtml + extraHtml;

      // Wire delete buttons.
      wrap.querySelectorAll('.cost-line-remove').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const idx = Number(btn.getAttribute('data-i'));
          await mutate({ side, op: 'remove', index: idx });
        });
      });

      // Click an existing line to edit it inline (name, amount,
      // optional × N container multiply).
      wrap.querySelectorAll('.cost-line-clickable').forEach((row) => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('.cost-line-remove')) return;
          const idx = Number(row.getAttribute('data-i'));
          if (!Number.isInteger(idx)) return;
          editingIndex = idx;
          render();
        });
      });

      // Wire the in-place edit-form controls.
      wrap.querySelectorAll('.cost-line-editing').forEach((line) => {
        const idx = Number(line.getAttribute('data-i'));
        const nameInput = line.querySelector('.bd-edit-name');
        const amountInput = line.querySelector('.bd-edit-amount');
        const multCheckbox = line.querySelector('.bd-edit-mult');
        const saveBtn = line.querySelector('.bd-edit-save');
        const cancelBtn = line.querySelector('.bd-edit-cancel');
        // Capture starting amount so toggling the checkbox
        // multiplies the *original*, not whatever is in the field.
        const startAmount = Number(amountInput.value) || 0;
        // When the user toggles "× N", live-update the displayed
        // amount so what they see is what will be saved.
        multCheckbox?.addEventListener('change', () => {
          if (qtyForRow <= 1) return;
          if (multCheckbox.checked) {
            amountInput.value = String(startAmount * qtyForRow);
          } else {
            amountInput.value = String(startAmount);
          }
        });
        const cancel = () => {
          editingIndex = -1;
          render();
        };
        cancelBtn?.addEventListener('click', cancel);
        // Esc cancels.
        line.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') cancel();
          if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
            e.preventDefault();
            saveBtn.click();
          }
        });
        saveBtn?.addEventListener('click', async () => {
          const newName = nameInput.value.trim();
          const newAmount = Number(amountInput.value);
          if (!newName || !Number.isFinite(newAmount) || newAmount === 0) return;
          // If the user used the × N toggle, annotate the name with
          // (×N) so they can audit later (mirrors the add-form path).
          const used = !!multCheckbox?.checked;
          let finalName = newName;
          if (used && qtyForRow > 1 && !/\(×\d+\)/.test(newName)) {
            finalName = `${newName} (×${qtyForRow})`;
          }
          editingIndex = -1;
          await mutate({
            side,
            op: 'update',
            index: idx,
            item: { name: finalName, amount: newAmount, currency: 'USD' },
          });
        });
        // Auto-focus the amount input on enter — that's what the user
        // typically wants to edit when they click a line.
        setTimeout(() => amountInput?.focus(), 30);
      });
      // Wire the "Add" form.
      const form = wrap.querySelector('.bd-add-form');
      form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const rawName = form.querySelector('.bd-add-name').value.trim();
        const rawAmount = Number(form.querySelector('.bd-add-amount').value);
        const currency =
          form.querySelector('.bd-add-currency')?.value || 'USD';
        const multiply = !!form.querySelector('.bd-add-multiply')?.checked;
        if (!rawName || !Number.isFinite(rawAmount) || rawAmount === 0) return;
        // When multiply is checked AND the row has a container qty > 1,
        // scale the amount and annotate the name so the user can audit.
        const useMultiply = multiply && qty > 1;
        const amount = useMultiply ? rawAmount * qty : rawAmount;
        const name = useMultiply ? `${rawName} (×${qty})` : rawName;
        await mutate({
          side,
          op: 'add',
          item: { name, amount, currency },
        });
      });
      // Wire re-check (cost only).
      if (isCost) {
        const recheckBtn = wrap.querySelector('.cost-recheck-btn');
        recheckBtn?.addEventListener('click', () =>
          recheckCostsFromSaved(refId, recheckBtn)
        );
      }
    }

    async function mutate(body) {
      wrap.classList.add('is-busy');
      try {
        const r = await fetch(
          `/api/shipments/${encodeURIComponent(refId)}/breakdown`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, fxRates: getFxRates() }),
          }
        );
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'breakdown update failed');
        // Apply server response to local state, re-render panel.
        const sh = data.shipment;
        if (sh) {
          items = Array.isArray(sh[breakdownKey]) ? sh[breakdownKey] : [];
          total = typeof sh[totalKey] === 'number' ? sh[totalKey] : null;
          // Update the row reference too so the table reflects after refresh.
          row[breakdownKey] = items;
          row[totalKey] = total;
        }
        render();
        // Keep the table in sync.
        await loadList();
      } catch (err) {
        toast('Save failed: ' + err.message, 'error');
      } finally {
        wrap.classList.remove('is-busy');
      }
    }

    render();
    openCompactPanel(anchorEl, wrap, { title });
  }

  async function recheckCostsFromSaved(refId, btn) {
    btn.disabled = true;
    btn.textContent = 'Re-checking…';
    setStatus('ship-status', `${refId}: re-checking $ from saved files…`, 'info');
    try {
      // Extra files attached during the clarify modal are merged in
      // alongside useExistingFiles=true (backend handles the union).
      let extraPayload = [];
      async function call(userAnswers) {
        const r = await fetch(
          `/api/shipments/${encodeURIComponent(refId)}/parse`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              useExistingFiles: true,
              files: extraPayload,
              mode: 'money',
              userAnswers,
              fxRates: getFxRates(),
            }),
          }
        );
        const ct = r.headers.get('content-type') || '';
        const raw = await r.text();
        if (!ct.includes('application/json')) {
          throw new Error(`Server returned ${r.status} ${r.statusText} (not JSON).`);
        }
        const data = JSON.parse(raw);
        if (!r.ok) throw new Error(data.error || 'recheck failed');
        return data;
      }
      let data = await call();
      if (data.pendingClarification && Array.isArray(data.questions)) {
        setStatus(
          'ship-status',
          `${refId}: ${data.questions.length} clarification${data.questions.length === 1 ? '' : 's'} — review and pick.`,
          'info'
        );
        const result = await openClarificationModal(data.questions);
        if (!result) {
          setStatus('ship-status', `${refId}: cancelled — no changes applied.`, 'info');
          return;
        }
        const { answers, additionalFiles } = result;
        if (additionalFiles && additionalFiles.length > 0) {
          extraPayload = await filesToPayload(additionalFiles);
        }
        data = await call(answers);
      }
      setStatus(
        'ship-status',
        `${refId}: re-checked. ${data.fieldsFilled || 0} field(s) updated, ${data.costItemsAdded || 0} cost line(s) added.`,
        'success'
      );
      await loadList();
      // Close the panel after refresh — the data behind it is stale.
      document.querySelectorAll('.compact-panel').forEach((n) => n.remove());
    } catch (err) {
      setStatus('ship-status', `${refId}: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  function wireAttachmentBadges(rows) {
    const byRef = new Map(rows.map((r) => [r.refId, r]));
    table.querySelectorAll('button.ship-attach-badge').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tr = btn.closest('tr');
        const refId = tr?.dataset.ref;
        if (!refId) return;
        const row = byRef.get(refId);
        if (!row) return;
        openAttachmentsModal(row, btn);
      });
    });
  }

  // In-app preview for an attachment. Routes by file type:
  //   image  → <img>
  //   pdf    → <iframe> (browser native PDF viewer)
  //   html   → <iframe sandbox> (preserves layout, blocks scripts)
  //   eml/txt/msg → fetch text via /artifacts/:index/text and show in <pre>
  // Falls back to "Open in new tab" when the type isn't previewable.
  async function openFilePreview(refId, artifactIndex, artifact) {
    // Tear down any existing preview overlay.
    document.querySelectorAll('.file-preview-overlay').forEach((n) => n.remove());

    const overlay = document.createElement('div');
    overlay.className = 'file-preview-overlay';
    overlay.innerHTML = `
      <div class="file-preview-backdrop"></div>
      <div class="file-preview-frame">
        <div class="file-preview-toolbar">
          <strong class="file-preview-title"></strong>
          <span class="file-preview-spacer"></span>
          <a class="file-preview-open" target="_blank" rel="noopener" title="Open in new tab">↗ Open</a>
          <button type="button" class="file-preview-close" title="Close (Esc)">✕</button>
        </div>
        <div class="file-preview-body"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    const titleEl = overlay.querySelector('.file-preview-title');
    const bodyEl = overlay.querySelector('.file-preview-body');
    const openLink = overlay.querySelector('.file-preview-open');
    const closeBtn = overlay.querySelector('.file-preview-close');
    const backdrop = overlay.querySelector('.file-preview-backdrop');

    titleEl.textContent = artifact.filename || 'Preview';
    openLink.href = artifact.url || '#';

    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
    }
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', close);
    document.addEventListener('keydown', onKey);

    const filename = (artifact.filename || '').toLowerCase();
    const mt = (artifact.mediaType || '').toLowerCase();
    const isImage = mt.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|svg)$/.test(filename);
    const isPdf = mt === 'application/pdf' || filename.endsWith('.pdf');
    const isHtml = mt === 'text/html' || /\.(html?)$/.test(filename);
    const isText =
      mt === 'text/plain' ||
      mt === 'message/rfc822' ||
      filename.endsWith('.txt') ||
      filename.endsWith('.eml') ||
      filename.endsWith('.msg');

    if (isImage) {
      bodyEl.classList.add('preview-image');
      const img = document.createElement('img');
      img.src = artifact.url;
      img.alt = artifact.filename || 'image';
      bodyEl.appendChild(img);
    } else if (isPdf) {
      bodyEl.classList.add('preview-pdf');
      const iframe = document.createElement('iframe');
      iframe.src = artifact.url;
      iframe.title = artifact.filename || 'pdf';
      bodyEl.appendChild(iframe);
    } else if (isHtml) {
      bodyEl.classList.add('preview-html');
      // Sandboxed iframe — render layout but block scripts / forms / popups.
      const iframe = document.createElement('iframe');
      iframe.src = artifact.url;
      iframe.sandbox = 'allow-same-origin';
      iframe.title = artifact.filename || 'html';
      bodyEl.appendChild(iframe);
    } else if (isText) {
      bodyEl.classList.add('preview-text');
      bodyEl.textContent = 'Loading…';
      try {
        const r = await fetch(
          `/api/shipments/${encodeURIComponent(refId)}/artifacts/${artifactIndex}/text`
        );
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'preview failed');
        const pre = document.createElement('pre');
        pre.textContent = data.text || '(empty)';
        bodyEl.replaceChildren(pre);
      } catch (err) {
        bodyEl.textContent = `Could not load preview: ${err.message}`;
      }
    } else {
      bodyEl.classList.add('preview-unsupported');
      bodyEl.innerHTML = `
        <p>No inline preview for this file type.</p>
        <p><a href="${esc(artifact.url || '#')}" target="_blank" rel="noopener">↗ Open in a new tab</a></p>
      `;
    }
  }

  function openAttachmentsModal(row, anchorEl) {
    const refId = row.refId;
    const wrap = document.createElement('div');
    wrap.className = 'attachments-list';

    let arts = Array.isArray(row.artifactsJson) ? row.artifactsJson.slice() : [];

    function fmtTime(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '—';
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
    }

    // ---- Static structural pieces (built once, re-used across renders) ----
    // Drop / browse zone — explicit "click to browse OR drop here".
    const dropzone = document.createElement('div');
    dropzone.className = 'attachments-dropzone';
    dropzone.innerHTML = `
      <span class="attachments-dropzone-prompt">📂 Drop files here, or click to browse</span>
      <span class="attachments-dropzone-hint">Image · PDF · EML · MSG · HTML · TXT</span>
      <input type="file" multiple accept="application/pdf,image/png,image/jpeg,image/webp,image/gif,message/rfc822,application/vnd.ms-outlook,text/html,text/plain,.pdf,.png,.jpg,.jpeg,.webp,.gif,.eml,.msg,.html,.htm,.txt" hidden />
    `;

    // Dedicated paste zone — separate from the drop zone so the user
    // knows exactly where Ctrl+V is captured. It's a focusable
    // contenteditable so paste events fire on it directly.
    const pasteZone = document.createElement('div');
    pasteZone.className = 'attachments-paste-zone';
    pasteZone.setAttribute('tabindex', '0');
    pasteZone.setAttribute('contenteditable', 'true');
    pasteZone.setAttribute('spellcheck', 'false');
    pasteZone.innerHTML = `<span class="attachments-paste-prompt">📋 Click here, then press Ctrl+V to paste a screenshot</span>`;

    function renderList() {
      // List
      const listEl = document.createElement('div');
      listEl.className = 'attachments-rows';
      if (arts.length === 0) {
        listEl.innerHTML = `<p class="muted small" style="margin: 0;">No attachments yet.</p>`;
      } else {
        listEl.innerHTML = arts
          .map((a, i) => {
            const filename = a.filename || a.url || '(unnamed)';
            return `<div class="attachment-row" data-i="${i}">
              <button type="button" class="attachment-link" data-preview-i="${i}" title="Preview ${esc(filename)}">
                <span class="attachment-icon">📎</span>
                <span class="attachment-name">${esc(filename)}</span>
              </button>
              <span class="attachment-time">${esc(fmtTime(a.addedAt))}</span>
              <a class="attachment-open" href="${esc(a.url || '#')}" target="_blank" rel="noopener" title="Open in new tab">↗</a>
              <button type="button" class="attachment-remove" data-i="${i}" title="Remove">✕</button>
            </div>`;
          })
          .join('');
      }
      // Rebuild wrap: list, then drop zone, then paste zone
      wrap.replaceChildren();
      wrap.appendChild(listEl);
      wrap.appendChild(dropzone);
      wrap.appendChild(pasteZone);
      // Wire delete buttons on every render.
      listEl.querySelectorAll('.attachment-remove').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const idx = Number(btn.getAttribute('data-i'));
          if (!Number.isInteger(idx)) return;
          if (!confirm(`Remove ${arts[idx]?.filename || 'this file'}?`)) return;
          await removeArtifact(idx);
        });
      });
      // Wire preview clicks (clicking the filename opens the in-app
      // preview overlay; the ↗ icon still opens in a new tab).
      listEl.querySelectorAll('.attachment-link').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const idx = Number(btn.getAttribute('data-preview-i'));
          if (!Number.isInteger(idx)) return;
          const a = arts[idx];
          if (!a) return;
          openFilePreview(refId, idx, a);
        });
      });
    }
    renderList();

    const { panel, close } = openCompactPanel(anchorEl, wrap, {
      title: `Attachments — ${refId}`,
    });

    async function removeArtifact(idx) {
      panel.classList.add('is-uploading');
      try {
        const r = await fetch(
          `/api/shipments/${encodeURIComponent(refId)}/artifacts/${idx}`,
          { method: 'DELETE' }
        );
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'delete failed');
        if (data.shipment) {
          arts = Array.isArray(data.shipment.artifactsJson)
            ? data.shipment.artifactsJson
            : [];
          row.artifactsJson = arts;
        }
        renderList();
        await loadList();
      } catch (err) {
        toast('Delete failed: ' + err.message, 'error');
      } finally {
        panel.classList.remove('is-uploading');
      }
    }

    async function uploadFiles(filesIn) {
      const arr = Array.from(filesIn || []);
      if (arr.length === 0) return;
      const accepted = arr.filter((f) => {
        if (
          /^(application\/pdf|image\/(png|jpe?g|webp|gif)|message\/rfc822|text\/(html|plain))$/i.test(f.type)
        ) {
          return true;
        }
        const lower = (f.name || '').toLowerCase();
        return /\.(eml|msg|html?|txt)$/.test(lower);
      });
      if (accepted.length === 0) {
        setStatus(
          'ship-status',
          'Unsupported file — use image, PDF, .eml, .msg, .html, or .txt.',
          'error'
        );
        return;
      }
      panel.classList.add('is-uploading');
      setStatus(
        'ship-status',
        `${refId}: attaching ${accepted.length} file${accepted.length > 1 ? 's' : ''}…`,
        'info'
      );
      try {
        const payload = await filesToPayload(accepted);
        const r = await fetch(
          `/api/shipments/${encodeURIComponent(refId)}/parse`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              files: payload,
              mode: 'all',
              fxRates: getFxRates(),
            }),
          }
        );
        const ct = r.headers.get('content-type') || '';
        const raw = await r.text();
        if (!ct.includes('application/json')) {
          throw new Error(`Server returned ${r.status} ${r.statusText} (not JSON).`);
        }
        const data = JSON.parse(raw);
        if (!r.ok) throw new Error(data.error || 'attach failed');
        if (data.pendingClarification) {
          setStatus(
            'ship-status',
            `${refId}: clarification needed — review and pick.`,
            'info'
          );
          close();
          const result = await openClarificationModal(data.questions || []);
          if (result) {
            const extra =
              result.additionalFiles && result.additionalFiles.length > 0
                ? await filesToPayload(result.additionalFiles)
                : [];
            const r2 = await fetch(
              `/api/shipments/${encodeURIComponent(refId)}/parse`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  files: payload.concat(extra),
                  mode: 'all',
                  userAnswers: result.answers,
                  fxRates: getFxRates(),
                }),
              }
            );
            await r2.json().catch(() => null);
          }
          await loadList();
          return;
        }
        if (data.shipment && Array.isArray(data.shipment.artifactsJson)) {
          arts = data.shipment.artifactsJson;
          row.artifactsJson = arts;
          renderList();
        }
        setStatus(
          'ship-status',
          `${refId}: attached. ${data.fieldsFilled || 0} field(s) filled, ${data.costItemsAdded || 0} cost line(s) added.`,
          'success'
        );
        await loadList();
      } catch (err) {
        setStatus('ship-status', `${refId}: ${err.message}`, 'error');
      } finally {
        panel.classList.remove('is-uploading');
      }
    }

    // ---- Drop / browse wiring ----
    const fileInput = dropzone.querySelector('input[type="file"]');
    dropzone.addEventListener('click', (e) => {
      if (e.target.closest('input')) return;
      fileInput.click();
    });
    fileInput.addEventListener('change', () => {
      uploadFiles(fileInput.files);
      fileInput.value = '';
    });
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('is-drag');
    });
    dropzone.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && dropzone.contains(e.relatedTarget)) return;
      dropzone.classList.remove('is-drag');
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('is-drag');
      uploadFiles(e.dataTransfer?.files);
    });

    // ---- Paste-zone wiring (separate, focusable, distinct purpose) ----
    pasteZone.addEventListener('paste', (e) => {
      const items = (e.clipboardData || {}).items || [];
      const pasted = [];
      for (const item of items) {
        if (!item.type || !item.type.startsWith('image/')) continue;
        const blob = item.getAsFile();
        if (!blob) continue;
        const ext = item.type.split('/')[1] || 'png';
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        pasted.push(new File([blob], `pasted-${ts}.${ext}`, { type: item.type }));
      }
      e.preventDefault(); // never let pasted text show inside the zone
      if (pasted.length > 0) {
        uploadFiles(pasted);
      } else {
        setStatus(
          'ship-status',
          'Clipboard had no image — copy a screenshot first.',
          'error'
        );
      }
    });
    // Block typing inside the contenteditable zone — it's only a paste
    // target, not a text editor.
    pasteZone.addEventListener('keydown', (e) => {
      // Allow Ctrl+V / Cmd+V; swallow everything else.
      const isPaste = (e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V');
      if (!isPaste) e.preventDefault();
    });
    pasteZone.addEventListener('input', () => {
      // If anything sneaks in, immediately wipe it back to the prompt.
      pasteZone.innerHTML = `<span class="attachments-paste-prompt">📋 Click here, then press Ctrl+V to paste a screenshot</span>`;
    });
  }

  // Per-row drop targets — drop a file/email onto a shipment row, the
  // server merges any new fields and appends cost items + the file
  // itself to the existing record.
  //
  // Note: we MUST preventDefault on dragenter/dragover unconditionally,
  // otherwise the browser falls back to its default "open the file"
  // behavior. Some sources (Outlook, attachments saved with no proper
  // mime) don't populate dataTransfer.types during drag, so a strict
  // hasFiles() gate would silently allow the browser navigation.
  // Single dragover listener on <tbody>. Reads which row the pointer is
  // over from each dragover event (which fires continuously while the
  // file is being held over the table). Race-free — no per-cell
  // dragenter/dragleave counting, no flicker as the cursor crosses
  // cell boundaries.
  //
  // ALSO tracks whether the cursor is over a money cell (Sell, Cost,
  // Profit). When yes, the drop is treated as money-only — the AI
  // skips routing/cargo/parties and focuses entirely on cost math.
  function wireRowDropTargets(rows) {
    const byRef = new Map(rows.map((r) => [r.refId, r]));
    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    let currentRow = null;
    let currentCell = null;
    function setCurrent(tr, td) {
      if (tr !== currentRow) {
        if (currentRow) currentRow.classList.remove('is-drop-target', 'is-drop-target-money');
        currentRow = tr;
      }
      if (td !== currentCell) {
        if (currentCell) currentCell.classList.remove('is-drop-target-cell');
        currentCell = td;
      }
      if (currentRow) {
        currentRow.classList.add('is-drop-target');
        currentRow.classList.toggle('is-drop-target-money', !!td);
      }
      if (currentCell) currentCell.classList.add('is-drop-target-cell');
    }
    function isMoneyCell(td) {
      if (!td) return false;
      return (
        td.classList.contains('cell-money') ||
        td.classList.contains('cell-cost') ||
        td.classList.contains('cell-profit')
      );
    }
    tbody.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      const tr = e.target.closest && e.target.closest('tr[data-ref]');
      const td = e.target.closest && e.target.closest('td');
      setCurrent(tr || null, isMoneyCell(td) ? td : null);
    });
    tbody.addEventListener('dragleave', (e) => {
      // Only clear when the pointer leaves the table body entirely.
      if (!e.relatedTarget || !tbody.contains(e.relatedTarget)) {
        setCurrent(null, null);
      }
    });
    tbody.addEventListener('drop', async (e) => {
      e.preventDefault();
      const tr = e.target.closest && e.target.closest('tr[data-ref]');
      const td = e.target.closest && e.target.closest('td');
      const moneyDrop = isMoneyCell(td);
      setCurrent(null, null);
      if (!tr) return;
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const refId = tr.dataset.ref;
      if (!refId) return;
      const row = byRef.get(refId);
      await dropFilesOnRow(refId, files, tr, row, moneyDrop ? 'money' : 'all');
    });
  }

  async function dropFilesOnRow(refId, files, tr, row, mode = 'all') {
    const arr = Array.from(files || []);
    if (arr.length === 0) return;
    // Reuse the same accept rules as the top dropzone.
    const accepted = [];
    for (const f of arr) {
      if (
        /^(application\/pdf|image\/(png|jpe?g|webp|gif)|message\/rfc822|text\/(html|plain))$/i.test(f.type)
      ) {
        accepted.push(f);
        continue;
      }
      const lower = (f.name || '').toLowerCase();
      if (/\.(eml|msg|html?|txt)$/.test(lower)) accepted.push(f);
    }
    if (accepted.length === 0) {
      setStatus(
        'ship-status',
        'Unsupported file dropped — use PDF, image, .eml, .msg, .html, or .txt.',
        'error'
      );
      return;
    }
    tr.classList.add('is-updating');
    setStatus(
      'ship-status',
      mode === 'money'
        ? `Re-checking $ for ${refId} from ${accepted.length} file${accepted.length > 1 ? 's' : ''}…`
        : `Updating ${refId} from ${accepted.length} file${accepted.length > 1 ? 's' : ''}…`,
      'info'
    );
    try {
      const payload = [];
      for (const f of accepted) {
        const buf = await f.arrayBuffer();
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
        payload.push({
          filename: f.name,
          contentBase64: btoa(bin),
          mediaType:
            f.type && f.type !== 'application/octet-stream' ? f.type : undefined,
        });
      }
      const ephemeral = !!document.getElementById('ship-ephemeral')?.checked;

      // Mutable payload — clarification modal can append more files
      // (paste / drop / browse inside the modal) before the re-call.
      let currentPayload = payload;
      async function callRowParse(userAnswers) {
        const r = await fetch(
          `/api/shipments/${encodeURIComponent(refId)}/parse`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              files: currentPayload,
              ephemeral,
              userAnswers,
              mode,
              fxRates: getFxRates(),
            }),
          }
        );
        const ct = r.headers.get('content-type') || '';
        const raw = await r.text();
        if (!ct.includes('application/json')) {
          if (r.status === 404) {
            throw new Error(
              'Per-row drop endpoint not registered on the running server. Restart `freight-copilot serve` to pick up the new route.'
            );
          }
          throw new Error(`Server returned ${r.status} ${r.statusText} (not JSON).`);
        }
        const out = JSON.parse(raw);
        if (!r.ok) throw new Error(out.error || 'update failed');
        return out;
      }

      // First pass — let the AI surface clarification questions if it
      // sees ambiguous money/cost/sell figures.
      let data = await callRowParse();
      if (data.pendingClarification && Array.isArray(data.questions)) {
        setStatus(
          'ship-status',
          `${refId}: ${data.questions.length} clarification${data.questions.length === 1 ? '' : 's'} needed — review and pick.`,
          'info'
        );
        const result = await openClarificationModal(data.questions);
        if (!result) {
          setStatus('ship-status', `${refId}: cancelled — no changes applied.`, 'info');
          return;
        }
        const { answers, additionalFiles } = result;
        if (additionalFiles && additionalFiles.length > 0) {
          const extra = await filesToPayload(additionalFiles);
          currentPayload = currentPayload.concat(extra);
        }
        setStatus('ship-status', `${refId}: re-running with your answers…`, 'info');
        data = await callRowParse(answers);
      }
      setStatus(
        'ship-status',
        `${refId}: filled ${data.fieldsFilled || 0} field(s), added ${data.costItemsAdded || 0} cost line(s).`,
        'success'
      );
      await loadList();
    } catch (err) {
      setStatus('ship-status', `${refId}: ${err.message}`, 'error');
    } finally {
      tr.classList.remove('is-updating');
    }
  }

  // Drag-to-pan on the table wrapper — palm cursor on hover, fist
  // while dragging. Only kicks in when the user grabs whitespace
  // between rows, headers, or non-interactive cells (we don't fight
  // text selection inside an editing cell or interfere with buttons).
  const wrap = document.getElementById('ship-table-wrap');
  if (wrap) {
    // Drag-to-pan via POINTER events + pointer capture (not mouse events). This
    // is what stops the twitch on touch / trackpad: with plain mouse events the
    // browser ALSO runs its own native touch/inertial scroll on the same
    // gesture, and the two fight over scrollLeft every frame -> jitter. Capturing
    // the pointer + `touch-action:none` (see style.css) makes the JS the SOLE
    // owner of the gesture, so there is nothing to fight. Pointer capture also
    // keeps the drag alive when the cursor leaves the element (no more
    // mouseleave dropping the drag mid-pan).
    let isDown = false;
    let pid = null;
    let startX = 0;
    let startY = 0;
    let scrollX = 0;
    let scrollY = 0;
    wrap.addEventListener('pointerdown', (e) => {
      // Mouse: left button only. Touch/pen: always.
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // Don't start a pan from interactive elements, nor from the column
      // reorder headers / resize handles — those own their own drag gestures.
      if (
        e.target.closest(
          '.ship-delete-btn, .ship-attach-badge, .ship-source-link, button, a, input, textarea, select, [contenteditable="true"], th[draggable="true"], .shipment-column-resizer'
        )
      ) {
        return;
      }
      isDown = true;
      pid = e.pointerId;
      wrap.classList.add('is-dragging');
      startX = e.clientX;
      startY = e.clientY;
      scrollX = wrap.scrollLeft;
      scrollY = wrap.scrollTop;
      // Route every subsequent pointer event for this gesture to `wrap` and
      // suppress the default (focus snap, text selection, native scroll).
      try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    function endDrag() {
      if (!isDown) return;
      isDown = false;
      wrap.classList.remove('is-dragging');
      try { if (pid != null) wrap.releasePointerCapture(pid); } catch (_) {}
      pid = null;
    }
    wrap.addEventListener('pointerup', endDrag);
    wrap.addEventListener('pointercancel', endDrag);
    wrap.addEventListener('pointermove', (e) => {
      if (!isDown || e.pointerId !== pid) return;
      e.preventDefault();
      wrap.scrollLeft = scrollX - (e.clientX - startX);
      wrap.scrollTop = scrollY - (e.clientY - startY);
    });
  }

  // Window-level guard: if the user drops a file outside any handled
  // target, swallow the event so the browser doesn't navigate away.
  // This runs once per page load.
  if (!window.__shipmentsDropGuardInstalled) {
    window.addEventListener('dragover', (e) => {
      // Only swallow drags that contain files; allow normal text/element
      // drags (e.g. native browser link drags) to behave normally.
      const types = e.dataTransfer?.types;
      if (types && Array.from(types).includes('Files')) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      const types = e.dataTransfer?.types;
      if (types && Array.from(types).includes('Files')) {
        // If the drop target wasn't handled by a more specific listener,
        // still preventDefault so the browser doesn't open the file.
        e.preventDefault();
      }
    });
    window.__shipmentsDropGuardInstalled = true;
  }

  // Initial load + refresh whenever the user opens the tab.
  loadList();
  document
    .querySelector('[data-tab="shipments"]')
    ?.addEventListener('click', () => loadList());
})();

// ---- Clarification modal (used by Shipments AI parse) ----
// Build the FX-rates override map sent with every parse request.
// Reads the user's USD↔CAD rate from the floating calc panel
// (`localStorage.freight.calc.usdcad.rate`, "1 USD = X CAD") and
// inverts it to "1 CAD = N USD" for the server. Other currencies
// fall back to the server's built-in defaults.
function getFxRates() {
  const rates = {};
  const usdToCad = parseFloat(
    localStorage.getItem('freight.calc.usdcad.rate') || ''
  );
  if (Number.isFinite(usdToCad) && usdToCad > 0) {
    rates.CAD = 1 / usdToCad;
  }
  return rates;
}

// Convert a list of File objects into the {filename, contentBase64,
// mediaType} payload shape every parse endpoint expects. Kept at
// module scope so all callers (top dropzone, per-row drop, clarify
// modal extra files) share it.
async function filesToPayload(files) {
  const out = [];
  for (const f of files || []) {
    const buf = await f.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    out.push({
      filename: f.name,
      contentBase64: btoa(bin),
      mediaType:
        f.type && f.type !== 'application/octet-stream' ? f.type : undefined,
    });
  }
  return out;
}

function openClarificationModal(questions) {
  // Resolves with:
  //   null                                                = cancelled
  //   { answers: [{question, answer}], additionalFiles: File[] } = OK
  // Callers should pass additionalFiles into the next parse call so
  // the AI re-runs with the user's picks AND any extra context they
  // attached (paste, drop, file picker — all live inside the modal).
  return new Promise((resolve) => {
    const modal = document.getElementById('clarify-modal');
    const list = document.getElementById('clarify-questions');
    const submitBtn = document.getElementById('clarify-submit');
    const cancelBtn = document.getElementById('clarify-cancel');
    const cancelBtn2 = document.getElementById('clarify-cancel-btn');
    const uploader = document.getElementById('clarify-uploader');
    const fileInput = document.getElementById('clarify-files');
    const attachedList = document.getElementById('clarify-attached');
    if (!modal || !list || !submitBtn) {
      resolve(null);
      return;
    }
    // Each question has its own picked-answer state.
    const picks = questions.map(() => '');
    // Files the user attaches inside the modal (drag, paste, picker).
    const additionalFiles = [];

    function render() {
      list.innerHTML = questions
        .map((q, qi) => {
          const opts = (q.options || [])
            .map(
              (opt, oi) =>
                `<button type="button" class="clarify-option ${picks[qi] === opt ? 'is-picked' : ''}" data-q="${qi}" data-opt="${oi}">${esc(opt)}</button>`
            )
            .join('');
          return `<div class="clarify-q" data-q="${qi}">
            <div class="clarify-q-text">${esc(q.text)}</div>
            <div class="clarify-options">${opts}</div>
            <input type="text" class="clarify-other" placeholder="…or type your own answer" data-q-other="${qi}" value="${esc(picks[qi] && !(q.options || []).includes(picks[qi]) ? picks[qi] : '')}" />
          </div>`;
        })
        .join('');
      list.querySelectorAll('.clarify-option').forEach((btn) => {
        btn.addEventListener('click', () => {
          const qi = Number(btn.getAttribute('data-q'));
          const oi = Number(btn.getAttribute('data-opt'));
          picks[qi] = questions[qi].options[oi];
          render();
          updateSubmit();
        });
      });
      list.querySelectorAll('input.clarify-other').forEach((inp) => {
        inp.addEventListener('input', () => {
          const qi = Number(inp.getAttribute('data-q-other'));
          picks[qi] = inp.value.trim();
          list
            .querySelectorAll(`.clarify-option[data-q="${qi}"]`)
            .forEach((b) => b.classList.remove('is-picked'));
          updateSubmit();
        });
      });
    }

    function renderAttached() {
      if (!attachedList) return;
      if (additionalFiles.length === 0) {
        attachedList.innerHTML = '';
        return;
      }
      attachedList.innerHTML = additionalFiles
        .map((f, i) => {
          const lower = (f.name || '').toLowerCase();
          let icon = '📎';
          if (f.type === 'application/pdf' || lower.endsWith('.pdf')) icon = '📄';
          else if (/^image\//.test(f.type)) icon = '🖼️';
          else if (lower.endsWith('.msg') || lower.endsWith('.eml')) icon = '📧';
          else if (lower.endsWith('.txt')) icon = '📝';
          else if (lower.endsWith('.html') || lower.endsWith('.htm')) icon = '🌐';
          const kb =
            f.size < 1024
              ? `${f.size} B`
              : f.size < 1024 * 1024
                ? `${(f.size / 1024).toFixed(1)} KB`
                : `${(f.size / (1024 * 1024)).toFixed(2)} MB`;
          return `<div class="clarify-attached-row" data-i="${i}">
            <span>${icon}</span>
            <span class="clarify-attached-name" title="${esc(f.name)}">${esc(f.name)}</span>
            <span class="clarify-attached-meta">${esc(kb)}</span>
            <button type="button" class="clarify-attached-remove" data-i="${i}" title="Remove">✕</button>
          </div>`;
        })
        .join('');
      attachedList.querySelectorAll('.clarify-attached-remove').forEach((b) => {
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const i = Number(b.getAttribute('data-i'));
          if (Number.isFinite(i)) {
            additionalFiles.splice(i, 1);
            renderAttached();
          }
        });
      });
    }

    function ingest(filesIn) {
      const arr = Array.from(filesIn || []);
      for (const f of arr) {
        if (
          /^(application\/pdf|image\/(png|jpe?g|webp|gif)|message\/rfc822|text\/(html|plain))$/i.test(f.type)
        ) {
          additionalFiles.push(f);
          continue;
        }
        const lower = (f.name || '').toLowerCase();
        if (/\.(eml|msg|html?|txt)$/.test(lower)) additionalFiles.push(f);
      }
      renderAttached();
    }

    function updateSubmit() {
      const allAnswered = picks.every((p) => p && p.length > 0);
      submitBtn.disabled = !allAnswered;
    }

    // ---- Uploader wiring (paste / drop / click) ----
    function onUploaderClick(e) {
      if (e.target.closest('.clarify-attached-row, .clarify-attached-remove')) return;
      fileInput?.click();
    }
    function onFilePicked() {
      ingest(fileInput.files);
      fileInput.value = '';
    }
    function onUploaderDragOver(e) {
      e.preventDefault();
      e.stopPropagation();
      uploader.classList.add('is-drag');
    }
    function onUploaderDragLeave(e) {
      if (e.relatedTarget && uploader.contains(e.relatedTarget)) return;
      uploader.classList.remove('is-drag');
    }
    function onUploaderDrop(e) {
      e.preventDefault();
      e.stopPropagation();
      uploader.classList.remove('is-drag');
      ingest(e.dataTransfer?.files);
    }
    function onPaste(e) {
      const items = (e.clipboardData || {}).items || [];
      const pasted = [];
      for (const item of items) {
        if (!item.type || !item.type.startsWith('image/')) continue;
        const blob = item.getAsFile();
        if (!blob) continue;
        const ext = item.type.split('/')[1] || 'png';
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        pasted.push(new File([blob], `pasted-${ts}.${ext}`, { type: item.type }));
      }
      if (pasted.length > 0) {
        e.preventDefault();
        ingest(pasted);
      }
    }

    function cleanup() {
      modal.hidden = true;
      submitBtn.removeEventListener('click', onSubmit);
      cancelBtn?.removeEventListener('click', onCancel);
      cancelBtn2?.removeEventListener('click', onCancel);
      modal
        .querySelector('.image-modal-backdrop')
        ?.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      uploader?.removeEventListener('click', onUploaderClick);
      fileInput?.removeEventListener('change', onFilePicked);
      uploader?.removeEventListener('dragover', onUploaderDragOver);
      uploader?.removeEventListener('dragleave', onUploaderDragLeave);
      uploader?.removeEventListener('drop', onUploaderDrop);
      modal.removeEventListener('paste', onPaste);
    }
    function onSubmit() {
      const answers = questions.map((q, i) => ({
        question: q.text,
        answer: picks[i],
      }));
      const filesCopy = additionalFiles.slice();
      cleanup();
      resolve({ answers, additionalFiles: filesCopy });
    }
    function onCancel() {
      cleanup();
      resolve(null);
    }
    function onKey(e) {
      if (e.key === 'Escape') onCancel();
    }

    submitBtn.addEventListener('click', onSubmit);
    cancelBtn?.addEventListener('click', onCancel);
    cancelBtn2?.addEventListener('click', onCancel);
    modal
      .querySelector('.image-modal-backdrop')
      ?.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
    uploader?.addEventListener('click', onUploaderClick);
    fileInput?.addEventListener('change', onFilePicked);
    uploader?.addEventListener('dragover', onUploaderDragOver);
    uploader?.addEventListener('dragleave', onUploaderDragLeave);
    uploader?.addEventListener('drop', onUploaderDrop);
    // Paste captured at the modal scope so it works even when the user
    // hasn't focused a specific input (Ctrl+V in browser body).
    modal.addEventListener('paste', onPaste);
    // Make modal focusable so paste fires reliably; also move focus so
    // keyboard shortcuts go to the modal, not the underlying page.
    modal.tabIndex = -1;
    setTimeout(() => modal.focus(), 30);

    modal.hidden = false;
    additionalFiles.length = 0;
    renderAttached();
    render();
    updateSubmit();
  });
}

// ---- Floating calculators ----
const CALC_RATE_KEY = 'freight.calc.usdcad.rate';

(function wireCalculators() {
  const toggle = document.getElementById('calc-toggle');
  const panel = document.getElementById('calc-panel');
  const closeBtn = document.getElementById('calc-close');
  if (!toggle || !panel) return;

  function open() { panel.hidden = false; }
  function close() { panel.hidden = true; }
  toggle.addEventListener('click', () => {
    if (panel.hidden) open();
    else close();
  });
  closeBtn?.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (!panel.hidden && e.key === 'Escape') close();
  });

  // ── USD ↔ CAD ────────────────────────────────────────────────────────
  const rateInput = document.getElementById('calc-usd-cad-rate');
  const usdInput = document.getElementById('calc-usd');
  const cadInput = document.getElementById('calc-cad');
  const storedRate = parseFloat(localStorage.getItem(CALC_RATE_KEY) || '');
  if (Number.isFinite(storedRate) && storedRate > 0) {
    rateInput.value = storedRate;
  }
  function rate() {
    const r = parseFloat(rateInput.value);
    return Number.isFinite(r) && r > 0 ? r : 1;
  }
  rateInput.addEventListener('input', () => {
    localStorage.setItem(CALC_RATE_KEY, rateInput.value);
    // Recompute downstream
    if (document.activeElement !== usdInput && usdInput.value) {
      cadInput.value = (parseFloat(usdInput.value) * rate()).toFixed(2);
    } else if (document.activeElement !== cadInput && cadInput.value) {
      usdInput.value = (parseFloat(cadInput.value) / rate()).toFixed(2);
    }
  });
  usdInput.addEventListener('input', () => {
    const v = parseFloat(usdInput.value);
    cadInput.value = Number.isFinite(v) ? (v * rate()).toFixed(2) : '';
  });
  cadInput.addEventListener('input', () => {
    const v = parseFloat(cadInput.value);
    usdInput.value = Number.isFinite(v) ? (v / rate()).toFixed(2) : '';
  });

  // ── Weight ───────────────────────────────────────────────────────────
  const kgIn = document.getElementById('calc-kg');
  const lbsIn = document.getElementById('calc-lbs');
  const tIn = document.getElementById('calc-tons');
  function setFromKg(kg) {
    kgIn.value = kg.toFixed(2);
    lbsIn.value = (kg * 2.20462).toFixed(2);
    tIn.value = (kg / 1000).toFixed(3);
  }
  kgIn.addEventListener('input', () => {
    const v = parseFloat(kgIn.value);
    if (!Number.isFinite(v)) return;
    lbsIn.value = (v * 2.20462).toFixed(2);
    tIn.value = (v / 1000).toFixed(3);
  });
  lbsIn.addEventListener('input', () => {
    const v = parseFloat(lbsIn.value);
    if (!Number.isFinite(v)) return;
    kgIn.value = (v / 2.20462).toFixed(2);
    tIn.value = (v / 2.20462 / 1000).toFixed(3);
  });
  tIn.addEventListener('input', () => {
    const v = parseFloat(tIn.value);
    if (!Number.isFinite(v)) return;
    kgIn.value = (v * 1000).toFixed(2);
    lbsIn.value = (v * 1000 * 2.20462).toFixed(2);
  });

  // ── Length ───────────────────────────────────────────────────────────
  const cmIn = document.getElementById('calc-cm');
  const inIn = document.getElementById('calc-in');
  const ftIn = document.getElementById('calc-ft');
  const mIn = document.getElementById('calc-m');
  function setFromCm(cm) {
    cmIn.value = cm.toFixed(1);
    inIn.value = (cm / 2.54).toFixed(1);
    ftIn.value = (cm / 30.48).toFixed(2);
    mIn.value = (cm / 100).toFixed(3);
  }
  cmIn.addEventListener('input', () => {
    const v = parseFloat(cmIn.value);
    if (Number.isFinite(v)) setFromCm(v);
  });
  inIn.addEventListener('input', () => {
    const v = parseFloat(inIn.value);
    if (Number.isFinite(v)) setFromCm(v * 2.54);
  });
  ftIn.addEventListener('input', () => {
    const v = parseFloat(ftIn.value);
    if (Number.isFinite(v)) setFromCm(v * 30.48);
  });
  mIn.addEventListener('input', () => {
    const v = parseFloat(mIn.value);
    if (Number.isFinite(v)) setFromCm(v * 100);
  });

  // ── CBM ──────────────────────────────────────────────────────────────
  const cbmUnit = document.getElementById('calc-cbm-unit');
  const cbmL = document.getElementById('calc-cbm-l');
  const cbmW = document.getElementById('calc-cbm-w');
  const cbmH = document.getElementById('calc-cbm-h');
  const cbmQty = document.getElementById('calc-cbm-qty');
  const cbmResult = document.getElementById('calc-cbm-result');
  function recalcCbm() {
    const l = parseFloat(cbmL.value);
    const w = parseFloat(cbmW.value);
    const h = parseFloat(cbmH.value);
    const qty = parseInt(cbmQty.value, 10) || 1;
    if (!Number.isFinite(l) || !Number.isFinite(w) || !Number.isFinite(h)) {
      cbmResult.textContent = '—';
      return;
    }
    const factor =
      cbmUnit.value === 'cm' ? 1e-6 : cbmUnit.value === 'in' ? 1.6387e-5 : 1;
    const cbm = l * w * h * factor * qty;
    cbmResult.textContent = `${cbm.toFixed(3)} CBM (per qty: ${(cbm / qty).toFixed(3)})`;
  }
  [cbmUnit, cbmL, cbmW, cbmH, cbmQty].forEach((el) =>
    el.addEventListener('input', recalcCbm)
  );

  // ── Overweight check (US drayage) ───────────────────────────────────
  // Per oversize.io and industry references. Numbers are constants here
  // so they're easy to tune as regulations shift; verify against your
  // own carrier/agent quotes before quoting hard.
  const US_STATES = [
    'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN',
    'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH',
    'NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
    'VT','VA','WA','WV','WI','WY',
  ];
  const LEGAL_LIMITS_LBS = {
    default: { '20DV': 38000, '40DV': 44000, '20RF': 34000, '40RF': 41000 },
    perState: {
      CA: { '20DV': 36500, '20RF': 32000, '40RF': 39000 },
      IL: { '20DV': 34000, '40DV': 43000 },
      MO: { '40DV': 43000 },
      WI: { '40RF': 39000 },
    },
  };
  const MAX_OW_LIMITS_LBS = {
    '20DV': 44000,
    '40DV': 51000,
    '20RF': 40000,
    '40RF': 43000,
  };
  // States that command higher permit fees (CA + NY are the headline ones).
  const HEAVY_PERMIT_STATES = new Set(['CA', 'NY']);
  const TRIAXLE_THRESHOLD = { 20: 36000, 40: 44000 };
  const TRIAXLE_COST_USD = 200;
  const PERMIT_COST_STANDARD_USD = 100;
  const PERMIT_COST_HEAVY_USD = 300;
  const NEAR_LIMIT_BUFFER_LBS = 1000;

  function calcOverweight(state, container, lbs) {
    const baseLegal = LEGAL_LIMITS_LBS.default[container] ?? 0;
    const stateLegal =
      LEGAL_LIMITS_LBS.perState[state]?.[container] ?? null;
    const legal = stateLegal ?? baseLegal;
    const max = MAX_OW_LIMITS_LBS[container] ?? 0;
    const sizePrefix = container.startsWith('20') ? 20 : 40;

    if (!Number.isFinite(lbs) || lbs <= 0) {
      return { legal, max, status: null };
    }

    let status, recommendation, statusCls;
    let needsTriAxle = false;
    let needsPermit = false;
    let triAxleCost = 0;
    let permitCost = 0;

    if (lbs <= legal) {
      status = 'LEGAL';
      statusCls = 'legal';
      recommendation = 'OK to move on standard chassis. No permit needed.';
    } else if (lbs <= max) {
      status = 'OVERWEIGHT';
      statusCls = 'overweight';
      needsPermit = true;
      needsTriAxle = lbs > TRIAXLE_THRESHOLD[sizePrefix];
      permitCost = HEAVY_PERMIT_STATES.has(state)
        ? PERMIT_COST_HEAVY_USD
        : PERMIT_COST_STANDARD_USD;
      if (needsTriAxle) triAxleCost = TRIAXLE_COST_USD;
      const parts = [needsPermit && 'overweight permit'];
      if (needsTriAxle) parts.push('tri-axle chassis');
      recommendation =
        'Requires ' +
        parts.filter(Boolean).join(' + ') +
        '. Confirm permit availability with your drayage carrier — some lanes will not move overweight at all.';
    } else {
      status = 'NOT HAULABLE';
      statusCls = 'unhaulable';
      recommendation =
        'Cargo exceeds the maximum overweight limit for this container. Consider transloading at origin / destination to a flatbed or splitting across two containers.';
    }

    let warning = null;
    if (status === 'LEGAL' && legal - lbs <= NEAR_LIMIT_BUFFER_LBS) {
      warning = `Within ${(legal - lbs).toLocaleString()} lbs of the legal limit — leave headroom for actual gross variability.`;
    }

    return {
      legal,
      max,
      status,
      statusCls,
      needsTriAxle,
      needsPermit,
      triAxleCost,
      permitCost,
      extraCost: triAxleCost + permitCost,
      recommendation,
      warning,
      stateOverride: stateLegal != null,
    };
  }

  const owState = document.getElementById('ow-state');
  const owContainer = document.getElementById('ow-container');
  const owLbs = document.getElementById('ow-cargo-lbs');
  const owResult = document.getElementById('ow-result');
  if (owState && owContainer && owLbs && owResult) {
    owState.innerHTML = US_STATES.map(
      (s) => `<option value="${s}">${s}</option>`
    ).join('');
    // Default to a state with no override; the user changes it as needed.
    owState.value = 'NJ';

    function renderOw() {
      const state = owState.value;
      const container = owContainer.value;
      const lbs = parseFloat(owLbs.value);
      const r = calcOverweight(state, container, lbs);
      if (!r.status) {
        owResult.innerHTML = `<div class="muted">Legal limit (${esc(state)} ${esc(container)}): <strong>${r.legal.toLocaleString()} lbs</strong>${r.legal !== LEGAL_LIMITS_LBS.default[container] ? ' (state override)' : ''}. Max overweight: ${r.max.toLocaleString()} lbs. Enter weight to check.</div>`;
        return;
      }
      const eqRows = [];
      eqRows.push(
        `<div class="ow-row"><span class="muted">Legal limit</span><strong>${r.legal.toLocaleString()} lbs${r.stateOverride ? ' (state)' : ''}</strong></div>`
      );
      eqRows.push(
        `<div class="ow-row"><span class="muted">Max overweight</span><strong>${r.max.toLocaleString()} lbs</strong></div>`
      );
      if (r.needsTriAxle || r.needsPermit) {
        if (r.needsPermit)
          eqRows.push(
            `<div class="ow-row"><span class="muted">Permit</span><strong>$${r.permitCost.toLocaleString()}${HEAVY_PERMIT_STATES.has(state) ? ' (heavy state)' : ''}</strong></div>`
          );
        if (r.needsTriAxle)
          eqRows.push(
            `<div class="ow-row"><span class="muted">Tri-axle chassis</span><strong>~$${r.triAxleCost.toLocaleString()}</strong></div>`
          );
        eqRows.push(
          `<div class="ow-row"><span class="muted"><strong>Est. extra</strong></span><strong>$${r.extraCost.toLocaleString()}</strong></div>`
        );
      }
      owResult.innerHTML =
        `<div><span class="ow-status ${esc(r.statusCls)}">${esc(r.status)}</span></div>` +
        eqRows.join('') +
        `<div class="ow-recommendation" style="color: ${r.statusCls === 'unhaulable' ? '#d44a4a' : r.statusCls === 'overweight' ? '#d29922' : '#2ea043'}">${esc(r.recommendation)}</div>` +
        (r.warning ? `<div class="ow-warning">${esc(r.warning)}</div>` : '');
    }
    [owState, owContainer, owLbs].forEach((el) =>
      el.addEventListener('input', renderOw)
    );
    renderOw();
  }

  // ── Container fit ────────────────────────────────────────────────────
  const fitCbm = document.getElementById('calc-fit-cbm');
  const fitKg = document.getElementById('calc-fit-kg');
  const fitResult = document.getElementById('calc-fit-result');
  // Approx usable internal capacities. Conservative — actual fits depend
  // on packaging, stuffing, and stowage. Numbers commonly cited by
  // freight forwarders.
  const CONTAINERS = [
    { code: '20GP', cbm: 28, kgGross: 21800 },
    { code: '40GP', cbm: 58, kgGross: 26500 },
    { code: '40HC', cbm: 67, kgGross: 26500 },
    { code: '20RF', cbm: 26, kgGross: 21800 },
    { code: '40RH', cbm: 60, kgGross: 26500 },
  ];
  function recalcFit() {
    const cbm = parseFloat(fitCbm.value);
    const kg = parseFloat(fitKg.value);
    if (!Number.isFinite(cbm) && !Number.isFinite(kg)) {
      fitResult.textContent = 'Fits in: —';
      return;
    }
    const fits = CONTAINERS.filter((c) => {
      const cbmOk = !Number.isFinite(cbm) || cbm <= c.cbm;
      const kgOk = !Number.isFinite(kg) || kg <= c.kgGross;
      return cbmOk && kgOk;
    }).map((c) => c.code);
    fitResult.textContent = fits.length
      ? `Fits in: ${fits.join(', ')}`
      : 'Does not fit any standard size — needs OOG / break-bulk.';
  }
  [fitCbm, fitKg].forEach((el) => el.addEventListener('input', recalcFit));
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

// =====================================================================
// DelayPredict integration tab — iframe embed of the running
// DelayPredict server. URL configurable in the secrets page; env
// var DELAYPREDICT_URL acts as a fallback default.
// =====================================================================
(function wireDelayPredictTab() {
  const emptyCard = document.getElementById('dp-empty');
  const frameWrap = document.getElementById('dp-frame-wrap');
  const frame = document.getElementById('dp-frame');
  const reloadBtn = document.getElementById('dp-reload-btn');
  const newTabLink = document.getElementById('dp-open-new-tab');
  const goSecrets = document.getElementById('dp-go-secrets');
  if (!frame || !emptyCard) return;

  let lastUrl = '';
  // Track whether the iframe loaded successfully — onerror doesn't
  // fire reliably for cross-origin frames, but we can detect content
  // by checking iframe.contentWindow on load.
  function setUrl(url) {
    if (!url) {
      emptyCard.hidden = false;
      frameWrap.hidden = true;
      frame.removeAttribute('src');
      lastUrl = '';
      return;
    }
    if (url !== lastUrl) {
      frame.src = url;
      newTabLink.href = url;
      lastUrl = url;
    }
    emptyCard.hidden = true;
    frameWrap.hidden = false;
  }

  async function refreshUrl() {
    try {
      const r = await fetch('/api/settings');
      const data = await r.json();
      const url =
        (data.settings && data.settings.DELAYPREDICT_URL) ||
        (data.env && data.env.DELAYPREDICT_URL) ||
        '';
      setUrl(url);
    } catch {
      setUrl('');
    }
  }

  reloadBtn?.addEventListener('click', () => {
    if (lastUrl) {
      // Bust any cached state by reassigning the same URL with a
      // changing hash, then revert it on next tick.
      const u = lastUrl;
      frame.src = 'about:blank';
      setTimeout(() => { frame.src = u; }, 50);
    }
  });
  goSecrets?.addEventListener('click', (e) => {
    e.preventDefault();
    activateTabBy('secrets');
  });

  // Refresh URL whenever the user opens the tab (URL might have just
  // been set in the secrets page).
  document
    .querySelector('[data-tab="delaypredict"]')
    ?.addEventListener('click', refreshUrl);
  refreshUrl();
})();

// =====================================================================
// DelayPredict URL setting (Carrier secrets tab)
// =====================================================================
(function wireDelayPredictUrlSetting() {
  const input = document.getElementById('dp-url-input');
  const saveBtn = document.getElementById('dp-url-save-btn');
  const clearBtn = document.getElementById('dp-url-clear-btn');
  const status = document.getElementById('dp-url-status');
  if (!input || !saveBtn) return;

  function setStat(msg, kind) {
    status.textContent = msg || '';
    status.className = 'status-inline' + (kind ? ' status-' + kind : '');
  }

  async function loadCurrent() {
    try {
      const r = await fetch('/api/settings');
      const data = await r.json();
      const dbVal = data.settings?.DELAYPREDICT_URL;
      const envVal = data.env?.DELAYPREDICT_URL;
      input.value = dbVal || envVal || '';
      if (dbVal) setStat('DB-saved', 'info');
      else if (envVal) setStat('Using .env value', 'info');
      else setStat('', '');
    } catch (err) {
      setStat('Error: ' + err.message, 'error');
    }
  }

  saveBtn.addEventListener('click', async () => {
    const value = input.value.trim();
    if (!value) {
      setStat('URL is empty.', 'error');
      return;
    }
    if (!/^https?:\/\//i.test(value)) {
      setStat('URL must start with http:// or https://', 'error');
      return;
    }
    saveBtn.disabled = true;
    setStat('Saving…', 'info');
    try {
      const r = await fetch('/api/settings/DELAYPREDICT_URL', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'save failed');
      setStat('Saved.', 'success');
      toast('DelayPredict URL saved.', 'success');
    } catch (err) {
      setStat(err.message, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });
  clearBtn.addEventListener('click', async () => {
    if (!confirm('Clear the saved DelayPredict URL?')) return;
    try {
      await fetch('/api/settings/DELAYPREDICT_URL', { method: 'DELETE' });
      input.value = '';
      setStat('Cleared.', 'info');
      toast('DelayPredict URL cleared.', 'success');
    } catch (err) {
      setStat(err.message, 'error');
    }
  });

  document
    .querySelector('[data-tab="secrets"]')
    ?.addEventListener('click', loadCurrent);
  loadCurrent();
})();

// =====================================================================
// IntellCluster integration tab — iframe embed of the running
// IntellCluster server. Mirrors the DelayPredict pattern.
// =====================================================================
(function wireIntellClusterTab() {
  const emptyCard = document.getElementById('ic-empty');
  const frameWrap = document.getElementById('ic-frame-wrap');
  const frame = document.getElementById('ic-frame');
  const reloadBtn = document.getElementById('ic-reload-btn');
  const newTabLink = document.getElementById('ic-open-new-tab');
  const goSecrets = document.getElementById('ic-go-secrets');
  if (!frame || !emptyCard) return;

  let lastUrl = '';
  function setUrl(url) {
    if (!url) {
      emptyCard.hidden = false;
      frameWrap.hidden = true;
      frame.removeAttribute('src');
      lastUrl = '';
      return;
    }
    if (url !== lastUrl) {
      frame.src = url;
      newTabLink.href = url;
      lastUrl = url;
    }
    emptyCard.hidden = true;
    frameWrap.hidden = false;
  }

  async function refreshUrl() {
    try {
      const r = await fetch('/api/settings');
      const data = await r.json();
      const url =
        (data.settings && data.settings.INTELLCLUSTER_URL) ||
        (data.env && data.env.INTELLCLUSTER_URL) ||
        '';
      setUrl(url);
    } catch {
      setUrl('');
    }
  }

  reloadBtn?.addEventListener('click', () => {
    if (lastUrl) {
      const u = lastUrl;
      frame.src = 'about:blank';
      setTimeout(() => { frame.src = u; }, 50);
    }
  });
  goSecrets?.addEventListener('click', (e) => {
    e.preventDefault();
    activateTabBy('secrets');
  });

  document
    .querySelector('[data-tab="intellcluster"]')
    ?.addEventListener('click', refreshUrl);
  refreshUrl();
})();

// =====================================================================
// IntellCluster URL setting (Carrier secrets tab)
// =====================================================================
(function wireIntellClusterUrlSetting() {
  const input = document.getElementById('ic-url-input');
  const saveBtn = document.getElementById('ic-url-save-btn');
  const clearBtn = document.getElementById('ic-url-clear-btn');
  const status = document.getElementById('ic-url-status');
  if (!input || !saveBtn) return;

  function setStat(msg, kind) {
    status.textContent = msg || '';
    status.className = 'status-inline' + (kind ? ' status-' + kind : '');
  }

  async function loadCurrent() {
    try {
      const r = await fetch('/api/settings');
      const data = await r.json();
      const dbVal = data.settings?.INTELLCLUSTER_URL;
      const envVal = data.env?.INTELLCLUSTER_URL;
      input.value = dbVal || envVal || '';
      if (dbVal) setStat('DB-saved', 'info');
      else if (envVal) setStat('Using .env value', 'info');
      else setStat('', '');
    } catch (err) {
      setStat('Error: ' + err.message, 'error');
    }
  }

  saveBtn.addEventListener('click', async () => {
    const value = input.value.trim();
    if (!value) {
      setStat('URL is empty.', 'error');
      return;
    }
    if (!/^https?:\/\//i.test(value)) {
      setStat('URL must start with http:// or https://', 'error');
      return;
    }
    saveBtn.disabled = true;
    setStat('Saving…', 'info');
    try {
      const r = await fetch('/api/settings/INTELLCLUSTER_URL', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'save failed');
      setStat('Saved.', 'success');
      toast('IntellCluster URL saved.', 'success');
    } catch (err) {
      setStat(err.message, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });
  clearBtn.addEventListener('click', async () => {
    if (!confirm('Clear the saved IntellCluster URL?')) return;
    try {
      await fetch('/api/settings/INTELLCLUSTER_URL', { method: 'DELETE' });
      input.value = '';
      setStat('Cleared.', 'info');
      toast('IntellCluster URL cleared.', 'success');
    } catch (err) {
      setStat(err.message, 'error');
    }
  });

  document
    .querySelector('[data-tab="secrets"]')
    ?.addEventListener('click', loadCurrent);
  loadCurrent();
})();

// =====================================================================
// AI orchestration: mode toggle (default / power / custom) + the
// hand-pick selectors that appear when mode=custom. Stored in
// app_settings (DB), beats .env, no server restart.
// =====================================================================
(function wireAiConfig() {
  const providerSel = document.getElementById('ai-cfg-provider');
  const modelSel = document.getElementById('ai-cfg-model');
  const fallbackSel = document.getElementById('ai-cfg-fallback');
  const saveBtn = document.getElementById('ai-cfg-save-btn');
  const status = document.getElementById('ai-cfg-status');
  const currentEl = document.getElementById('ai-cfg-current');
  const customPanel = document.getElementById('ai-cfg-custom');
  const modeButtons = document.querySelectorAll('.ai-mode-btn');
  if (!providerSel || !modelSel || !modeButtons.length) return;

  let currentMode = 'default';

  const PRESETS = {
    default: {
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      fallback: 'gemini-1.5-pro',
      agent: 'claude-haiku-4-5-20251001',
      label: 'Gemini Flash · Pro fallback · Haiku agent',
    },
    power: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      fallback: 'claude-opus-4-7',
      agent: 'claude-sonnet-4-6',
      label: 'Claude Sonnet · Opus fallback · Sonnet agent',
    },
  };

  const MODEL_CATALOG = {
    anthropic: [
      { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5  ·  cheap, fast' },
      { value: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6  ·  balanced' },
      { value: 'claude-opus-4-7',           label: 'Claude Opus 4.7  ·  best quality' },
    ],
    gemini: [
      { value: 'gemini-2.0-flash',  label: 'Gemini 2.0 Flash  ·  cheapest, vision-strong' },
      { value: 'gemini-1.5-flash',  label: 'Gemini 1.5 Flash  ·  cheap, older' },
      { value: 'gemini-1.5-pro',    label: 'Gemini 1.5 Pro  ·  highest Gemini quality' },
    ],
  };

  function setStat(msg, kind) {
    status.textContent = msg || '';
    status.className = 'status-inline' + (kind ? ' status-' + kind : '');
  }

  function fillModelOptions(provider, primarySel, fallbackSel, primaryValue, fallbackValue) {
    const options = MODEL_CATALOG[provider] || [];
    const html = options.map(
      (o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`
    ).join('');
    primarySel.innerHTML = html;
    fallbackSel.innerHTML = html;
    if (primaryValue && options.find((o) => o.value === primaryValue)) {
      primarySel.value = primaryValue;
    }
    if (fallbackValue && options.find((o) => o.value === fallbackValue)) {
      fallbackSel.value = fallbackValue;
    }
  }

  function setActiveMode(mode) {
    currentMode = mode;
    modeButtons.forEach((b) => {
      b.classList.toggle('is-selected', b.getAttribute('data-mode') === mode);
    });
    customPanel.hidden = mode !== 'custom';
    updateCurrentLabel();
  }

  function updateCurrentLabel() {
    if (currentMode === 'custom') {
      const provider = providerSel.value;
      const model = modelSel.value;
      const fallback = fallbackSel.value;
      currentEl.textContent =
        `Active: 🛠 Custom · ${provider} · ${model} · fallback ${fallback}`;
      return;
    }
    const p = PRESETS[currentMode];
    currentEl.textContent = `Active: ${
      currentMode === 'default' ? '⚡ Default' : '💎 Power'
    } · ${p.label}`;
  }

  async function loadCurrent() {
    try {
      const r = await fetch('/api/settings');
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'load failed');
      const s = data.settings || {};
      const env = data.env || {};
      const mode = s.AI_MODE || 'default';
      const provider = s.AI_PROVIDER || env.AI_PROVIDER || 'anthropic';
      const model = s.AI_MODEL || env.AI_MODEL || '';
      const fallback = s.AI_MODEL_FALLBACK || env.AI_MODEL_FALLBACK || '';
      providerSel.value = provider;
      fillModelOptions(provider, modelSel, fallbackSel, model, fallback);
      setActiveMode(mode);
    } catch (err) {
      setStat('Error: ' + err.message, 'error');
    }
  }

  // Mode-button click → mark as the new mode (visual only; saved on Save).
  modeButtons.forEach((b) => {
    b.addEventListener('click', () => setActiveMode(b.getAttribute('data-mode')));
  });

  // When provider changes (custom mode), repopulate model options.
  providerSel.addEventListener('change', () => {
    fillModelOptions(providerSel.value, modelSel, fallbackSel);
    updateCurrentLabel();
  });
  modelSel.addEventListener('change', updateCurrentLabel);
  fallbackSel.addEventListener('change', updateCurrentLabel);

  saveBtn?.addEventListener('click', async () => {
    saveBtn.disabled = true;
    setStat('Saving…', 'info');
    try {
      const updates = [['AI_MODE', currentMode]];
      if (currentMode === 'custom') {
        updates.push(
          ['AI_PROVIDER', providerSel.value],
          ['AI_MODEL', modelSel.value],
          ['AI_MODEL_FALLBACK', fallbackSel.value],
        );
      }
      for (const [key, value] of updates) {
        const r = await fetch(`/api/settings/${encodeURIComponent(key)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `save ${key} failed`);
      }
      setStat('Saved. Next AI call uses the new mode.', 'success');
      toast(
        currentMode === 'default'
          ? '⚡ Default mode active.'
          : currentMode === 'power'
            ? '💎 Power mode active.'
            : '🛠 Custom mode active.',
        'success'
      );
      await loadCurrent();
    } catch (err) {
      setStat(err.message, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });

  document
    .querySelector('[data-tab="secrets"]')
    ?.addEventListener('click', loadCurrent);
  loadCurrent();
})();

// =====================================================================
// AI provider keys vault (Carrier secrets tab)
// =====================================================================
(function wireAiKeysVault() {
  const provSel = document.getElementById('ai-key-provider');
  const keyIn = document.getElementById('ai-key-value');
  const labelIn = document.getElementById('ai-key-label');
  const saveBtn = document.getElementById('ai-key-save-btn');
  const importBtn = document.getElementById('ai-key-import-btn');
  const status = document.getElementById('ai-key-status');
  const masterKeyBox = document.getElementById('ai-key-masterkey');
  const table = document.getElementById('ai-key-list-table');
  const refreshBtn = document.getElementById('ai-key-refresh-btn');
  if (!table) return;

  const PROV_LABEL = {
    anthropic: 'Anthropic (Claude)',
    gemini: 'Google Gemini',
    openai: 'OpenAI',
    deepseek: 'DeepSeek',
    xai: 'xAI / Grok',
  };
  // 5 explicit statuses (Objective 5). One provider failing never blanks the rest.
  const STATE_BADGE = {
    stored_usable: { label: 'Stored securely', cls: 'green' },
    env_fallback: { label: 'Environment fallback', cls: 'blue' },
    stored_locked: { label: 'Stored but locked', cls: 'red' },
    missing: { label: 'Missing', cls: 'gray' },
  };

  function setStat(msg, kind) {
    status.textContent = msg || '';
    status.className = 'status-inline' + (kind ? ' status-' + kind : '');
  }

  function renderMasterKey(mk) {
    if (!masterKeyBox) return;
    if (!mk) { masterKeyBox.textContent = ''; return; }
    if (!mk.productionSafe) {
      masterKeyBox.className = 'status-inline status-error';
      masterKeyBox.textContent = '⚠ SECRETS_MASTER_KEY is not set in production — set it in Secrets and republish before saving keys.';
    } else if (!mk.configured) {
      masterKeyBox.className = 'status-inline status-info';
      masterKeyBox.textContent = 'SECRETS_MASTER_KEY: using a development fallback. Set it in Secrets before deploying.';
    } else {
      masterKeyBox.className = 'status-inline status-success';
      masterKeyBox.textContent = `SECRETS_MASTER_KEY configured (source: ${mk.source}). SESSION_SECRET is separate.`;
    }
  }

  async function loadList() {
    try {
      const r = await fetch('/api/ai-keys');
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'load failed');
      renderMasterKey(data.masterKey);
      const providers = Array.isArray(data.providers) ? data.providers : [];
      const head = `<thead><tr><th>Provider</th><th>Status</th><th>Label</th><th>Key</th><th>Updated</th><th>Actions</th></tr></thead>`;
      const body = providers
        .map((p) => {
          const badge = STATE_BADGE[p.state] || { label: p.state, cls: 'gray' };
          const ready = p.usable ? '<span class="feature-state feature-state-ready" title="A key is available at runtime">Ready</span> ' : '';
          const updated = p.updatedAt ? new Date(p.updatedAt).toISOString().slice(0, 10) : '—';
          const masked = p.keyMasked ? `<code>${esc(p.keyMasked)}</code>` : '<span class="muted small">—</span>';
          const testBtn = `<button class="btn-sm ai-key-test" data-prov="${esc(p.provider)}" title="Cheap metadata call — no data sent">Test</button>`;
          const rmBtn = p.storedRow
            ? `<button class="ship-delete-btn ai-key-del" data-prov="${esc(p.provider)}" title="Remove from vault (env var unaffected)">✕</button>`
            : '';
          return `<tr data-prov="${esc(p.provider)}">
            <td>${esc(PROV_LABEL[p.provider] || p.provider)}</td>
            <td>${ready}<span class="feature-state feature-state-${badge.cls}" data-badge="${esc(p.state)}">${esc(badge.label)}</span></td>
            <td>${esc(p.label || '—')}</td>
            <td>${masked}</td>
            <td class="when-cell">${updated}</td>
            <td class="actions-cell"><span class="ai-key-test-result muted small"></span> ${testBtn}${rmBtn}</td>
          </tr>`;
        })
        .join('');
      table.innerHTML = head + `<tbody>${body}</tbody>`;
      table.querySelectorAll('.ai-key-del').forEach((b) => {
        b.addEventListener('click', async () => {
          const prov = b.getAttribute('data-prov');
          if (!confirm(`⚠ Remove the stored ${prov} key from the encrypted vault?\n\nThis is a destructive action. The matching environment variable (if any) is NOT affected.`)) return;
          try {
            const r = await fetch(`/api/ai-keys/${encodeURIComponent(prov)}`, { method: 'DELETE' });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || 'delete failed');
            await loadList();
            toast(`${prov} key removed.`, 'success');
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      });
      table.querySelectorAll('.ai-key-test').forEach((b) => {
        b.addEventListener('click', async () => {
          const prov = b.getAttribute('data-prov');
          const cell = b.closest('.actions-cell')?.querySelector('.ai-key-test-result');
          b.disabled = true;
          if (cell) { cell.textContent = 'Testing…'; cell.className = 'ai-key-test-result muted small'; }
          try {
            const r = await fetch(`/api/ai-keys/${encodeURIComponent(prov)}/test`, { method: 'POST' });
            const data = await r.json();
            if (cell) {
              if (data.success) { cell.textContent = `OK ${data.latencyMs}ms`; cell.className = 'ai-key-test-result status-success small'; }
              else { cell.textContent = data.error || 'failed'; cell.className = 'ai-key-test-result status-error small'; }
            }
          } catch (err) {
            if (cell) { cell.textContent = String(err.message || err); cell.className = 'ai-key-test-result status-error small'; }
          } finally {
            b.disabled = false;
          }
        });
      });
    } catch (err) {
      // A single failure must not blank the whole panel silently.
      table.innerHTML = `<tbody><tr><td class="empty">Status unavailable: ${esc(err.message)}. Stored keys were not affected.</td></tr></tbody>`;
    }
  }

  importBtn?.addEventListener('click', async () => {
    importBtn.disabled = true;
    setStat('Importing environment keys…', 'info');
    try {
      const r = await fetch('/api/ai-keys/migrate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'import failed');
      const imported = (data.results || []).filter((x) => x.action === 'imported').map((x) => x.provider);
      setStat(imported.length ? `Imported: ${imported.join(', ')}.` : 'No new keys to import.', 'success');
      await loadList();
    } catch (err) {
      setStat(err.message, 'error');
    } finally {
      importBtn.disabled = false;
    }
  });

  saveBtn?.addEventListener('click', async () => {
    const provider = provSel.value;
    const key = keyIn.value.trim();
    const label = labelIn.value.trim() || undefined;
    if (!key) { setStat('Enter the API key.', 'error'); return; }
    saveBtn.disabled = true;
    setStat('Saving…', 'info');
    try {
      const r = await fetch(`/api/ai-keys/${encodeURIComponent(provider)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, label }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'save failed');
      setStat(`${provider} key saved.`, 'success');
      keyIn.value = '';
      labelIn.value = '';
      await loadList();
    } catch (err) {
      setStat(err.message, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });

  refreshBtn?.addEventListener('click', loadList);
  // Refresh whenever the user opens the secrets tab.
  document
    .querySelector('[data-tab="secrets"]')
    ?.addEventListener('click', loadList);
  loadList();
})();

// =====================================================================
// Drayage Rate Library — drop / browse / paste rate sheets, AI extracts
// every lane into the local archive. List below with filter inputs.
// Append-only by design (price history is the point), so re-uploading
// the same sheet just adds new rows tagged with the upload date.
// =====================================================================
(function wireDrayageRateLibrary() {
  const dropzone = document.getElementById('dr-lib-dropzone');
  const fileInput = document.getElementById('dr-lib-files');
  const pasteZone = document.getElementById('dr-lib-paste-zone');
  const pendingList = document.getElementById('dr-lib-pending-files');
  const parseBtn = document.getElementById('dr-lib-parse-btn');
  const status = document.getElementById('dr-lib-status');
  const table = document.getElementById('dr-lib-table');
  const refreshBtn = document.getElementById('dr-lib-refresh-btn');
  const countEl = document.getElementById('dr-lib-count');
  if (!dropzone || !table) return;

  // Per-column filter state, keyed by column key.
  const colFilters = {};
  let allLibraryRates = []; // last server response, for client-side filtering

  let pending = [];

  function setStat(msg, kind) {
    if (!status) return;
    status.textContent = msg || '';
    status.className = 'status-inline' + (kind ? ' status-' + kind : '');
  }

  function fileLabel(f) {
    const lower = (f.name || '').toLowerCase();
    if (f.type === 'application/pdf' || lower.endsWith('.pdf'))
      return { icon: '📄', label: 'PDF' };
    if (/^image\//.test(f.type)) return { icon: '🖼️', label: 'Image' };
    if (lower.endsWith('.msg')) return { icon: '📧', label: 'Outlook .msg' };
    if (f.type === 'message/rfc822' || lower.endsWith('.eml'))
      return { icon: '📧', label: '.eml' };
    if (f.type === 'text/html' || /\.(html?)$/.test(lower))
      return { icon: '🌐', label: 'HTML' };
    if (f.type === 'text/plain' || lower.endsWith('.txt'))
      return { icon: '📝', label: 'Text' };
    return { icon: '📎', label: f.type || 'file' };
  }

  function refreshPending() {
    parseBtn.disabled = pending.length === 0;
    parseBtn.textContent = pending.length
      ? `Extract & save to library (${pending.length})`
      : 'Extract & save to library';
    if (!pendingList) return;
    if (pending.length === 0) {
      pendingList.hidden = true;
      pendingList.innerHTML = '';
      return;
    }
    pendingList.hidden = false;
    pendingList.innerHTML = pending
      .map((f, i) => {
        const t = fileLabel(f);
        const kb =
          f.size < 1024
            ? `${f.size} B`
            : f.size < 1024 * 1024
              ? `${(f.size / 1024).toFixed(1)} KB`
              : `${(f.size / (1024 * 1024)).toFixed(2)} MB`;
        return `<li class="pending-file">
          <span class="pending-file-icon">${t.icon}</span>
          <span class="pending-file-name" title="${esc(f.name)}">${esc(f.name)}</span>
          <span class="pending-file-meta">${esc(t.label)} · ${esc(kb)}</span>
          <button type="button" class="pending-file-remove" data-i="${i}" title="Remove">✕</button>
        </li>`;
      })
      .join('');
    pendingList.querySelectorAll('.pending-file-remove').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = Number(b.getAttribute('data-i'));
        if (Number.isFinite(i)) pending.splice(i, 1);
        refreshPending();
      });
    });
  }

  function ingest(filesIn) {
    const arr = Array.from(filesIn || []);
    for (const f of arr) {
      if (
        /^(application\/pdf|image\/(png|jpe?g|webp|gif)|message\/rfc822|text\/(html|plain))$/i.test(f.type)
      ) {
        pending.push(f);
        continue;
      }
      const lower = (f.name || '').toLowerCase();
      if (/\.(eml|msg|html?|txt)$/.test(lower)) pending.push(f);
    }
    refreshPending();
  }

  // Drop / browse wiring
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    ingest(fileInput.files);
    fileInput.value = '';
  });
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('is-drag');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-drag'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-drag');
    ingest(e.dataTransfer?.files);
  });

  // Paste zone
  pasteZone?.addEventListener('paste', (e) => {
    const items = (e.clipboardData || {}).items || [];
    const pasted = [];
    for (const item of items) {
      if (!item.type || !item.type.startsWith('image/')) continue;
      const blob = item.getAsFile();
      if (!blob) continue;
      const ext = item.type.split('/')[1] || 'png';
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      pasted.push(new File([blob], `pasted-${ts}.${ext}`, { type: item.type }));
    }
    e.preventDefault();
    if (pasted.length > 0) ingest(pasted);
    else setStat('Clipboard had no image — copy a screenshot first.', 'error');
  });
  pasteZone?.addEventListener('keydown', (e) => {
    const isPaste = (e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V');
    if (!isPaste) e.preventDefault();
  });
  pasteZone?.addEventListener('input', () => {
    pasteZone.innerHTML = `<span class="attachments-paste-prompt">📋 Click here, then press Ctrl+V to paste a screenshot</span>`;
  });

  // ---- Preview state ---------------------------------------------------
  // Holds the rates returned by a dry-run /parse call so the user can
  // review/edit them. The original files stay in `pending` so they
  // can be re-sent on Save (server persists them then).
  let previewRates = [];
  let previewFiles = []; // snapshot of `pending` at extract time

  parseBtn.addEventListener('click', async () => {
    if (pending.length === 0) return;
    parseBtn.disabled = true;
    setStat(
      `Reading ${pending.length} file${pending.length > 1 ? 's' : ''} for review…`,
      'info'
    );
    try {
      const payload = await filesToPayload(pending);
      const r = await fetch('/api/drayage-rate-library/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: payload,
          fxRates: getFxRates(),
          dryRun: true,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'parse failed');
      const rates = data.rates || [];
      if (rates.length === 0) {
        setStat('No rates found in the file(s).', 'error');
        return;
      }
      previewRates = rates;
      previewFiles = payload;
      renderPreview();
      setStat(
        `Found ${rates.length} rate${rates.length === 1 ? '' : 's'} — review below, then click Save.`,
        'info'
      );
    } catch (err) {
      setStat('Error: ' + err.message, 'error');
    } finally {
      parseBtn.disabled = pending.length === 0;
    }
  });

  // ---- Editable preview ------------------------------------------------
  const previewWrap = document.getElementById('dr-lib-preview');
  const previewTable = document.getElementById('dr-lib-preview-table');
  const previewTitle = document.getElementById('dr-lib-preview-title');
  const previewSaveBtn = document.getElementById('dr-lib-preview-save');
  const previewCancelBtn = document.getElementById('dr-lib-preview-cancel');

  function renderPreview() {
    if (!previewWrap || !previewTable) return;
    if (!previewRates.length) {
      previewWrap.hidden = true;
      previewTable.innerHTML = '';
      return;
    }
    previewWrap.hidden = false;
    if (previewTitle) {
      previewTitle.textContent = `Review ${previewRates.length} extracted rate${previewRates.length === 1 ? '' : 's'}`;
    }
    const head = `<thead><tr>
      <th>Rate date</th>
      <th>Provider</th>
      <th>Pickup</th>
      <th>Delivery</th>
      <th>Miles</th>
      <th>Cntr</th>
      <th>Max wt (kg)</th>
      <th>Total rate (USD)</th>
      <th></th>
    </tr></thead>`;
    const body = previewRates
      .map((r, i) => {
        return `<tr data-i="${i}">
          <td><input class="prev-input" data-i="${i}" data-field="rateDate" type="date" value="${esc(r.rateDate || '')}" /></td>
          <td><input class="prev-input" data-i="${i}" data-field="providerName" value="${esc(r.providerName || '')}" /></td>
          <td><input class="prev-input" data-i="${i}" data-field="pickupLabel" value="${esc(r.pickupLabel || '')}" /></td>
          <td><input class="prev-input" data-i="${i}" data-field="deliveryLabel" value="${esc(r.deliveryLabel || '')}" /></td>
          <td><input class="prev-input prev-num" data-i="${i}" data-field="totalMiles" type="number" step="0.1" value="${r.totalMiles ?? ''}" /></td>
          <td><input class="prev-input" data-i="${i}" data-field="containerType" value="${esc(r.containerType || '')}" /></td>
          <td><input class="prev-input prev-num" data-i="${i}" data-field="maxWeightKg" type="number" step="1" value="${r.maxWeightKg ?? ''}" /></td>
          <td><input class="prev-input prev-num" data-i="${i}" data-field="totalRate" type="number" step="0.01" value="${r.totalRate ?? ''}" /></td>
          <td class="actions-cell"><button type="button" class="ship-delete-btn" data-i="${i}" title="Drop this row">✕</button></td>
        </tr>`;
      })
      .join('');
    previewTable.innerHTML = head + `<tbody>${body}</tbody>`;
    // Wire input edits → mutate previewRates in place.
    previewTable.querySelectorAll('.prev-input').forEach((inp) => {
      inp.addEventListener('input', () => {
        const i = Number(inp.getAttribute('data-i'));
        const field = inp.getAttribute('data-field');
        if (!Number.isInteger(i) || !field || !previewRates[i]) return;
        const isNum = inp.classList.contains('prev-num');
        previewRates[i][field] = isNum
          ? inp.value === '' ? null : Number(inp.value)
          : inp.value.trim() || null;
      });
    });
    // Drop row.
    previewTable.querySelectorAll('.ship-delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.getAttribute('data-i'));
        if (!Number.isInteger(i)) return;
        previewRates.splice(i, 1);
        if (previewRates.length === 0) {
          previewWrap.hidden = true;
          previewRates = [];
          previewFiles = [];
        } else {
          renderPreview();
        }
      });
    });
  }

  previewCancelBtn?.addEventListener('click', () => {
    previewRates = [];
    previewFiles = [];
    renderPreview();
    setStat('Cancelled — no rates were saved.', 'info');
  });

  previewSaveBtn?.addEventListener('click', async () => {
    if (previewRates.length === 0) return;
    previewSaveBtn.disabled = true;
    setStat(`Saving ${previewRates.length} rate${previewRates.length === 1 ? '' : 's'}…`, 'info');
    try {
      const r = await fetch('/api/drayage-rate-library/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rates: previewRates,
          files: previewFiles,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'save failed');
      setStat(
        `Saved ${data.inserted} rate${data.inserted === 1 ? '' : 's'} to the library.`,
        'success'
      );
      previewRates = [];
      previewFiles = [];
      pending = [];
      renderPreview();
      refreshPending();
      await loadList();
      if (typeof window.runDrayageMatchSearch === 'function') {
        window.runDrayageMatchSearch();
      }
    } catch (err) {
      setStat('Error: ' + err.message, 'error');
    } finally {
      previewSaveBtn.disabled = false;
    }
  });

  // ---- List + per-column filters ----
  // Column definitions for the saved-rates database table. Each col
  // has a key, label, and a getter that returns the displayed value
  // (used for both rendering AND for filter substring matching).
  const LIB_COLS = [
    { key: 'rateDate',     label: 'Rate date',    get: (r) => r.rateDate || '' },
    { key: 'pickupLabel',  label: 'Pickup',       get: (r) => r.pickupLabel || '' },
    { key: 'deliveryLabel',label: 'Delivery',     get: (r) => r.deliveryLabel || '' },
    { key: 'totalMiles',   label: 'Miles',        get: (r) => r.totalMiles != null ? String(r.totalMiles) : '' },
    { key: 'containerType',label: 'Cntr',         get: (r) => r.containerType || '' },
    { key: 'maxWeightKg',  label: 'Max wt (kg)',  get: (r) => r.maxWeightKg != null ? String(Math.round(r.maxWeightKg)) : '' },
    { key: 'totalRate',    label: 'Total (USD)',  get: (r) => r.totalRate != null ? String(r.totalRate) : '' },
    { key: 'providerName', label: 'Provider',     get: (r) => r.providerName || '' },
    { key: 'createdAt',    label: 'Uploaded',     get: (r) => r.createdAt ? new Date(r.createdAt).toISOString().slice(0,10) : '' },
  ];

  function applyColFilters(rows) {
    const active = Object.entries(colFilters).filter(([, v]) => v !== '' && v != null);
    if (active.length === 0) return rows;
    return rows.filter((r) => {
      for (const [key, needle] of active) {
        const col = LIB_COLS.find((c) => c.key === key);
        if (!col) continue;
        const hay = (col.get(r) || '').toLowerCase();
        if (!hay.includes(String(needle).toLowerCase())) return false;
      }
      return true;
    });
  }

  function renderRows() {
    const filtered = applyColFilters(allLibraryRates);
    if (countEl) {
      const n = filtered.length;
      const total = allLibraryRates.length;
      countEl.textContent =
        n === total
          ? `— ${total} saved rate${total === 1 ? '' : 's'}`
          : `— ${n} of ${total} (filtered)`;
    }
    // Build header label row + filter row.
    const labelRow =
      LIB_COLS.map((c) => `<th>${esc(c.label)}</th>`).join('') + '<th></th>';
    const filterCells = LIB_COLS.map((c) => {
      const v = colFilters[c.key] || '';
      return `<th class="filter-th"><input type="search" class="filter-input lib-filter" data-key="${esc(c.key)}" placeholder="filter…" value="${esc(v)}" /></th>`;
    }).join('') + '<th class="filter-th"></th>';
    const head = `<thead>
      <tr class="ship-th-row">${labelRow}</tr>
      <tr class="ship-filter-row">${filterCells}</tr>
    </thead>`;
    const body = filtered.length === 0
      ? `<tbody><tr><td class="empty" colspan="${LIB_COLS.length + 1}">${
          allLibraryRates.length === 0
            ? 'No rates saved yet — drop a rate sheet above.'
            : 'No matches for the current filters.'
        }</td></tr></tbody>`
      : `<tbody>${filtered
          .map((r) => {
            const cells = LIB_COLS.map((c) => {
              const v = c.get(r);
              if (c.key === 'totalRate' && r.totalRate != null) {
                return `<td class="cell-money">${esc(formatMoney(r.totalRate, 'USD'))}</td>`;
              }
              if (c.key === 'createdAt') {
                return `<td class="when-cell">${esc(v || '—')}</td>`;
              }
              return `<td title="${esc(v || '')}">${esc(v || '—')}</td>`;
            }).join('');
            return `<tr data-id="${r.id}">${cells}<td class="actions-cell"><button class="ship-delete-btn" data-id="${r.id}" title="Delete">✕</button></td></tr>`;
          })
          .join('')}</tbody>`;
    table.innerHTML = head + body;
    // Wire delete + per-column filter inputs.
    table.querySelectorAll('.ship-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        if (!confirm(`Delete rate entry ${id}? This can't be undone.`)) return;
        try {
          const r = await fetch(`/api/drayage-rate-library/${id}`, {
            method: 'DELETE',
          });
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || 'delete failed');
          await loadList();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
    table.querySelectorAll('.lib-filter').forEach((inp) => {
      inp.addEventListener('input', () => {
        const key = inp.getAttribute('data-key');
        const v = inp.value;
        if (v === '' || v == null) delete colFilters[key];
        else colFilters[key] = v;
        // Re-render body only — keep focus on the active input.
        // Easiest: snapshot focus + cursor, re-render, restore.
        const focusedKey = key;
        const cursor = inp.selectionStart;
        renderRows();
        const restored = table.querySelector(
          `.lib-filter[data-key="${CSS.escape(focusedKey)}"]`
        );
        if (restored) {
          restored.focus();
          if (cursor != null) {
            try { restored.setSelectionRange(cursor, cursor); } catch (_) {}
          }
        }
      });
    });
  }

  async function loadList() {
    try {
      const r = await fetch('/api/drayage-rate-library');
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'load failed');
      allLibraryRates = data.rates || [];
      renderRows();
    } catch (err) {
      table.innerHTML = `<tbody><tr><td class="empty">Error: ${esc(err.message)}</td></tr></tbody>`;
    }
  }

  refreshBtn?.addEventListener('click', loadList);

  // Initial load + refresh whenever the user opens the Drayage tab.
  loadList();
  document
    .querySelector('[data-tab="drayage"]')
    ?.addEventListener('click', loadList);
})();
