(function installShipmentGridEnhancements() {
  'use strict';

  const PREF_KEY = 'loadmode.shipmentGrid.preferences.v1';
  const DEFAULT_PREFS = { order: [], hidden: [], widths: {}, freezeCol: null, density: 'comfortable' };
  const editableBlocked = new Set(['operationalStatus', 'refId', 'createdAt', 'cargo', 'soldRate', 'ourCost', 'profit']);
  const numericFields = new Set(['containerQuantity']);

  function readPrefs() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      return {
        order: Array.isArray(parsed.order) ? parsed.order : [],
        hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
        widths: parsed.widths && typeof parsed.widths === 'object' ? parsed.widths : {},
        freezeCol: typeof parsed.freezeCol === 'string' ? parsed.freezeCol : null,
        density: parsed.density === 'compact' ? 'compact' : 'comfortable',
      };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  function savePrefs(prefs) {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {}
  }

  function getTable() { return document.getElementById('ship-table'); }
  function fieldOf(cell) { return cell?.getAttribute('data-field') || ''; }
  function isShipmentTabActive() { return document.getElementById('tab-shipments')?.classList.contains('active') === true; }

  function ensureToolbar() {
    const table = getTable();
    if (!table || document.getElementById('shipment-grid-toolbar')) return;
    const wrap = table.closest('.table-wrap') || table.parentElement;
    const bar = document.createElement('div');
    bar.id = 'shipment-grid-toolbar';
    bar.className = 'shipment-grid-toolbar';
    bar.innerHTML = `
      <div class="shipment-grid-toolbar-main">
        <strong>Shipment spreadsheet</strong>
        <span class="muted small">Grab and drag to pan · double-click a cell to edit · drag a column edge to resize · paste rows from Excel.</span>
      </div>
      <div class="shipment-grid-toolbar-actions">
        <button type="button" id="shipment-density-btn" aria-pressed="false" title="Toggle compact row height">Compact rows</button>
        <button type="button" id="shipment-columns-btn" aria-expanded="false" aria-controls="shipment-columns-menu">Columns</button>
        <button type="button" id="shipment-reset-layout-btn">Reset layout</button>
      </div>
      <div id="shipment-columns-menu" class="shipment-columns-menu" role="group" aria-label="Visible shipment columns" hidden></div>`;
    wrap.parentElement?.insertBefore(bar, wrap);

    const columnsButton = bar.querySelector('#shipment-columns-btn');
    columnsButton.addEventListener('click', (event) => {
      event.stopPropagation();
      const menu = bar.querySelector('#shipment-columns-menu');
      menu.hidden = !menu.hidden;
      columnsButton.setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) renderColumnsMenu(menu);
    });
    bar.querySelector('#shipment-reset-layout-btn').addEventListener('click', () => {
      localStorage.removeItem(PREF_KEY);
      location.reload();
    });

    const densityButton = bar.querySelector('#shipment-density-btn');
    const syncDensityButton = () => {
      densityButton.setAttribute('aria-pressed', String(readPrefs().density === 'compact'));
    };
    syncDensityButton();
    densityButton.addEventListener('click', () => {
      const prefs = readPrefs();
      prefs.density = prefs.density === 'compact' ? 'comfortable' : 'compact';
      savePrefs(prefs);
      applyDensity();
      syncDensityButton();
    });
    document.addEventListener('click', (event) => {
      const menu = bar.querySelector('#shipment-columns-menu');
      if (!bar.contains(event.target)) {
        menu.hidden = true;
        columnsButton.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const menu = bar.querySelector('#shipment-columns-menu');
      if (!menu.hidden) {
        menu.hidden = true;
        columnsButton.setAttribute('aria-expanded', 'false');
        columnsButton.focus();
      }
    });
  }

  function columnMeta() {
    const table = getTable();
    if (!table) return [];
    return Array.from(table.querySelectorAll('thead tr:first-child th')).map((th, index) => ({
      key: th.dataset.gridKey || th.getAttribute('data-field') || `column-${index}`,
      label: (th.textContent || '').replace(/\s+/g, ' ').trim() || `Column ${index + 1}`,
      index,
      th,
    })).filter((item) => item.label && item.label !== '');
  }

  function assignHeaderKeys() {
    const table = getTable();
    if (!table) return;
    const bodyRow = table.querySelector('tbody tr[data-ref]');
    const bodyCells = bodyRow ? Array.from(bodyRow.children) : [];
    Array.from(table.querySelectorAll('thead tr:first-child th')).forEach((th, index) => {
      const bodyCell = bodyCells[index];
      const key = fieldOf(bodyCell) || (th.classList.contains('actions-cell') ? '__actions' : `column-${index}`);
      th.dataset.gridKey = key;
    });
  }

  // Reorder a column within prefs.order by stepping it one slot (dir -1 up / +1
  // down). The order list follows the same shape applyPreferences consumes: the
  // full ordered key list minus the trailing __actions column. Persist + re-apply
  // through the existing order path, then re-render the menu keeping focus.
  function moveColumnOrder(key, dir) {
    const keys = columnMeta().map((c) => c.key).filter((k) => k !== '__actions');
    const from = keys.indexOf(key);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= keys.length) return;
    keys.splice(to, 0, keys.splice(from, 1)[0]);
    const prefs = readPrefs();
    prefs.order = keys;
    savePrefs(prefs);
    applyPreferences();
    const menu = document.getElementById('shipment-columns-menu');
    if (menu && !menu.hidden) {
      renderColumnsMenu(menu);
      const move = dir < 0 ? 'up' : 'down';
      const same = menu.querySelector(`.shipment-column-move-btn[data-column="${key}"][data-move="${move}"]`);
      if (same && !same.disabled) same.focus();
      else menu.querySelector(`.shipment-column-move-btn[data-column="${key}"]:not([disabled])`)?.focus();
    }
  }

  function renderColumnsMenu(menu) {
    assignHeaderKeys();
    const prefs = readPrefs();
    const cols = columnMeta().filter((c) => c.key !== '__actions');
    menu.innerHTML = `<strong>Visible columns</strong>${cols.map((col, i) => `
      <div class="shipment-column-row">
        <label><input type="checkbox" data-column="${col.key}" ${prefs.hidden.includes(col.key) ? '' : 'checked'}> ${col.label}</label>
        <span class="shipment-column-move">
          <button type="button" class="shipment-column-move-btn" data-move="up" data-column="${col.key}" aria-label="Move ${col.label} earlier" title="Move earlier"${i === 0 ? ' disabled' : ''}>&#9650;</button>
          <button type="button" class="shipment-column-move-btn" data-move="down" data-column="${col.key}" aria-label="Move ${col.label} later" title="Move later"${i === cols.length - 1 ? ' disabled' : ''}>&#9660;</button>
        </span>
      </div>`).join('')}`;
    menu.querySelectorAll('input[data-column]').forEach((input) => {
      input.addEventListener('change', () => {
        const key = input.dataset.column;
        const current = readPrefs();
        const next = new Set(current.hidden);
        input.checked ? next.delete(key) : next.add(key);
        current.hidden = Array.from(next);
        savePrefs(current);
        applyPreferences();
      });
    });
    menu.querySelectorAll('.shipment-column-move-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        moveColumnOrder(btn.dataset.column, btn.dataset.move === 'up' ? -1 : 1);
      });
    });
  }

  function moveColumn(table, from, to) {
    table.querySelectorAll('tr').forEach((row) => {
      const cells = Array.from(row.children);
      const cell = cells[from];
      if (!cell) return;
      const reference = row.children[to + (from < to ? 1 : 0)] || null;
      row.insertBefore(cell, reference);
    });
    const colgroup = table.querySelector('colgroup');
    if (colgroup) {
      const cols = Array.from(colgroup.children);
      const col = cols[from];
      if (col) colgroup.insertBefore(col, colgroup.children[to + (from < to ? 1 : 0)] || null);
    }
  }

  // ── Freeze / pin columns ─────────────────────────────────────────────────
  // A single freeze boundary: pinning column N keeps columns 1..N fixed while
  // the rest scroll horizontally. Offsets are MEASURED (not hard-coded) so
  // resizing a frozen column keeps the boundary exact. position:sticky is
  // forced with !important because the table's own rules otherwise win.
  const PIN_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';

  function applyFreeze() {
    const table = getTable();
    if (!table) return;
    const headers = Array.from(table.querySelectorAll('thead tr:first-child th'));
    // Clear any existing freeze.
    table.querySelectorAll('.is-frozen-col').forEach((el) => {
      el.classList.remove('is-frozen-col', 'is-freeze-edge');
      el.style.removeProperty('left');
    });
    const key = readPrefs().freezeCol;
    const boundary = key ? headers.findIndex((th) => th.dataset.gridKey === key) : -1;
    if (boundary >= 0) {
      let cum = 0;
      for (let i = 0; i <= boundary; i++) {
        const w = headers[i].getBoundingClientRect().width;
        table.querySelectorAll('tr').forEach((row) => {
          const cell = row.children[i];
          if (!cell) return;
          cell.classList.add('is-frozen-col');
          cell.style.setProperty('left', `${Math.round(cum)}px`, 'important');
          if (i === boundary) cell.classList.add('is-freeze-edge');
        });
        cum += w;
      }
    }
    headers.forEach((th) => {
      const pin = th.querySelector('.ship-col-pin');
      if (pin) pin.classList.toggle('is-active', th.dataset.gridKey === key && key != null);
    });
  }

  function toggleFreeze(key) {
    const prefs = readPrefs();
    prefs.freezeCol = prefs.freezeCol === key ? null : key;
    savePrefs(prefs);
    applyFreeze();
  }

  // ── Row density ──────────────────────────────────────────────────────────
  // Compact mode tightens vertical rhythm via a class toggle; 'comfortable' is
  // the default look. Re-applied on every enhance so it survives table redraws.
  function applyDensity() {
    const table = getTable();
    if (!table) return;
    const compact = readPrefs().density === 'compact';
    table.classList.toggle('is-compact', compact);
    const wrap = table.closest('.table-wrap');
    if (wrap) wrap.classList.toggle('is-compact', compact);
  }

  function applyPreferences() {
    const table = getTable();
    if (!table) return;
    assignHeaderKeys();
    const prefs = readPrefs();
    const currentKeys = columnMeta().map((c) => c.key);
    const desired = [
      ...prefs.order.filter((key) => currentKeys.includes(key)),
      ...currentKeys.filter((key) => !prefs.order.includes(key)),
    ];
    desired.forEach((key, target) => {
      const headers = Array.from(table.querySelectorAll('thead tr:first-child th'));
      const from = headers.findIndex((th) => th.dataset.gridKey === key);
      if (from >= 0 && from !== target) moveColumn(table, from, target);
    });

    const headers = Array.from(table.querySelectorAll('thead tr:first-child th'));
    headers.forEach((th, index) => {
      const key = th.dataset.gridKey;
      const hidden = prefs.hidden.includes(key);
      table.querySelectorAll('tr').forEach((row) => row.children[index]?.classList.toggle('shipment-column-hidden', hidden));
      const width = Number(prefs.widths[key]);
      if (Number.isFinite(width) && width >= 70) {
        table.querySelectorAll('tr').forEach((row) => {
          const cell = row.children[index];
          if (cell) { cell.style.width = `${width}px`; cell.style.minWidth = `${width}px`; }
        });
      }
    });
    wireHeaders();
    wireCells();
    applyFreeze();
    applyDensity();
  }

  function wireHeaders() {
    const table = getTable();
    if (!table) return;
    Array.from(table.querySelectorAll('thead tr:first-child th')).forEach((th) => {
      if (th.dataset.gridEnhanced === '1') return;
      th.dataset.gridEnhanced = '1';
      // Headers are NOT draggable: grabbing a header should PAN the table (the
      // natural instinct on a wide grid), not reorder the column. Native
      // header-drag reorder was also what fed the colgroup twitch loop. Column
      // resizing still works via the resize handle; show/hide via the Columns
      // menu. (Drag-reorder can return later as a menu control if wanted.)
      th.draggable = false;
      th.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData('text/plain', th.dataset.gridKey || '');
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });
      th.addEventListener('dragover', (event) => event.preventDefault());
      th.addEventListener('drop', (event) => {
        event.preventDefault();
        const source = event.dataTransfer?.getData('text/plain') || '';
        const target = th.dataset.gridKey;
        if (!source || !target || source === target || target === '__actions') return;
        const prefs = readPrefs();
        const keys = columnMeta().map((c) => c.key).filter((key) => key !== '__actions');
        const from = keys.indexOf(source), to = keys.indexOf(target);
        if (from < 0 || to < 0) return;
        keys.splice(to, 0, keys.splice(from, 1)[0]);
        prefs.order = keys;
        savePrefs(prefs);
        applyPreferences();
      });

      const handle = document.createElement('span');
      handle.className = 'shipment-column-resizer';
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', 'vertical');
      handle.setAttribute('aria-label', `Resize ${th.textContent?.trim() || 'column'}`);
      th.appendChild(handle);

      // Freeze pin — click to keep this column + everything left of it fixed
      // while the rest scrolls sideways. (Not on the trailing actions column.)
      if (th.dataset.gridKey !== '__actions') {
        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = 'ship-col-pin';
        pin.title = 'Freeze columns up to here';
        pin.setAttribute('aria-label', `Freeze columns up to ${th.textContent?.trim() || 'this column'}`);
        pin.innerHTML = PIN_SVG;
        pin.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleFreeze(th.dataset.gridKey);
        });
        th.appendChild(pin);
      }
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        handle.setPointerCapture?.(event.pointerId);
        const startX = event.clientX;
        const startWidth = th.getBoundingClientRect().width;
        const key = th.dataset.gridKey;
        const move = (e) => {
          const width = Math.max(70, Math.round(startWidth + e.clientX - startX));
          const index = Array.from(th.parentElement.children).indexOf(th);
          table.querySelectorAll('tr').forEach((row) => {
            const cell = row.children[index];
            if (cell) { cell.style.width = `${width}px`; cell.style.minWidth = `${width}px`; }
          });
          // Resizing a frozen column shifts the freeze boundary — re-measure.
          applyFreeze();
        };
        const finish = () => {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', finish);
          document.removeEventListener('pointercancel', finish);
          const prefs = readPrefs();
          prefs.widths[key] = Math.round(th.getBoundingClientRect().width);
          savePrefs(prefs);
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', finish, { once: true });
        document.addEventListener('pointercancel', finish, { once: true });
      });
    });
  }

  function visibleDataCells(row) {
    return Array.from(row?.querySelectorAll('td[data-field]:not(.shipment-column-hidden)') || []);
  }

  function focusCell(cell) {
    if (!cell) return;
    const table = getTable();
    table?.querySelectorAll('td.is-active-cell').forEach((item) => item.classList.remove('is-active-cell'));
    cell.classList.add('is-active-cell');
    cell.focus({ preventScroll: true });
    cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function wireCells() {
    const table = getTable();
    if (!table) return;
    table.querySelectorAll('tbody td[data-field]').forEach((td) => {
      td.tabIndex = 0;
      if (td.dataset.gridKeyboard === '1') return;
      td.dataset.gridKeyboard = '1';
      td.addEventListener('focus', () => focusCell(td));
      td.addEventListener('keydown', (event) => {
        if (td.isContentEditable || event.target !== td) return;
        const row = td.closest('tr[data-ref]');
        if (!row) return;
        const rows = Array.from(table.querySelectorAll('tbody tr[data-ref]'));
        const cells = visibleDataCells(row);
        const col = cells.indexOf(td), rowIndex = rows.indexOf(row);
        let target = null;
        if (event.key === 'ArrowRight' || (event.key === 'Tab' && !event.shiftKey)) {
          target = cells[col + 1] || visibleDataCells(rows[rowIndex + 1])[0];
        } else if (event.key === 'ArrowLeft' || (event.key === 'Tab' && event.shiftKey)) {
          target = cells[col - 1] || visibleDataCells(rows[rowIndex - 1]).at(-1);
        } else if (event.key === 'ArrowDown') {
          target = visibleDataCells(rows[rowIndex + 1])[col];
        } else if (event.key === 'ArrowUp') {
          target = visibleDataCells(rows[rowIndex - 1])[col];
        } else if (event.key === 'Enter') {
          event.preventDefault();
          td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          return;
        }
        if (target) {
          event.preventDefault();
          focusCell(target);
        }
      });
    });
  }

  function normalizeValue(field, raw) {
    if (raw === '') return null;
    if (!numericFields.has(field)) return raw;
    const parsed = Number(String(raw).replace(/,/g, '').trim());
    if (!Number.isFinite(parsed)) throw new Error(`${field} must be numeric`);
    return parsed;
  }

  async function patchCell(td, rawValue) {
    const row = td.closest('tr[data-ref]');
    const field = fieldOf(td);
    if (!row || !field || editableBlocked.has(field)) return false;
    const value = normalizeValue(field, rawValue);
    const response = await fetch(`/api/shipments/${encodeURIComponent(row.dataset.ref)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'save failed');
    td.textContent = rawValue;
    td.classList.toggle('cell-empty', rawValue === '');
    td.classList.add('is-saved');
    setTimeout(() => td.classList.remove('is-saved'), 900);
    return true;
  }

  function installPasteHandler() {
    if (window.__shipmentGridPasteInstalled) return;
    window.__shipmentGridPasteInstalled = true;
    document.addEventListener('paste', async (event) => {
      if (!isShipmentTabActive()) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) return;

      const table = getTable();
      const active = table?.querySelector('td.is-active-cell, td:focus');
      if (!table || !active || !table.contains(active) || active.isContentEditable) return;
      const text = event.clipboardData?.getData('text/plain') || '';
      if (!text.includes('\t') && !text.includes('\n')) return;
      event.preventDefault();

      const rows = Array.from(table.querySelectorAll('tbody tr[data-ref]'));
      const startRow = rows.indexOf(active.closest('tr[data-ref]'));
      if (startRow < 0) return;
      const startCells = visibleDataCells(rows[startRow]);
      const startCol = startCells.indexOf(active);
      if (startCol < 0) return;

      const lines = text.replace(/\r/g, '').split('\n');
      if (lines.at(-1) === '') lines.pop();
      const matrix = lines.map((line) => line.split('\t'));
      let saved = 0, skipped = 0;
      const errors = [];
      for (let r = 0; r < matrix.length; r++) {
        const row = rows[startRow + r];
        if (!row) break;
        const cells = visibleDataCells(row);
        for (let c = 0; c < matrix[r].length; c++) {
          const cell = cells[startCol + c];
          if (!cell) continue;
          try {
            (await patchCell(cell, matrix[r][c])) ? saved++ : skipped++;
          } catch (error) {
            skipped++;
            errors.push(error instanceof Error ? error.message : 'save failed');
          }
        }
      }
      const detail = errors.length ? ` First error: ${errors[0]}.` : '';
      window.toast?.(`Pasted ${saved} shipment cell${saved === 1 ? '' : 's'}${skipped ? `; ${skipped} skipped.` : '.'}${detail}`, skipped ? 'info' : 'success');
    });
  }

  let enhanceScheduled = false;
  function enhance() {
    enhanceScheduled = false;
    ensureToolbar();
    applyPreferences();
    installPasteHandler();
  }
  function scheduleEnhance() {
    if (enhanceScheduled) return;
    enhanceScheduled = true;
    requestAnimationFrame(enhance);
  }

  const observer = new MutationObserver(scheduleEnhance);
  function start() {
    const table = getTable();
    if (!table) return setTimeout(start, 150);
    observer.observe(table, { childList: true, subtree: true });
    scheduleEnhance();
    window.addEventListener('resize', applyFreeze);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
