(function installShipmentGridEnhancements() {
  'use strict';

  const PREF_KEY = 'loadmode.shipmentGrid.preferences.v1';
  const DEFAULT_PREFS = { order: [], hidden: [], widths: {} };
  const editableBlocked = new Set(['operationalStatus', 'refId', 'createdAt', 'cargo', 'soldRate', 'ourCost', 'profit']);

  function readPrefs() {
    try {
      return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  function savePrefs(prefs) {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  }

  function getTable() { return document.getElementById('ship-table'); }
  function fieldOf(cell) { return cell?.getAttribute('data-field') || ''; }

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
        <span class="muted small">Edit cells, resize or drag columns, and paste rows from Excel.</span>
      </div>
      <div class="shipment-grid-toolbar-actions">
        <button type="button" id="shipment-columns-btn">Columns</button>
        <button type="button" id="shipment-reset-layout-btn">Reset layout</button>
      </div>
      <div id="shipment-columns-menu" class="shipment-columns-menu" hidden></div>`;
    wrap.parentElement?.insertBefore(bar, wrap);

    bar.querySelector('#shipment-columns-btn').addEventListener('click', (event) => {
      event.stopPropagation();
      const menu = bar.querySelector('#shipment-columns-menu');
      menu.hidden = !menu.hidden;
      if (!menu.hidden) renderColumnsMenu(menu);
    });
    bar.querySelector('#shipment-reset-layout-btn').addEventListener('click', () => {
      localStorage.removeItem(PREF_KEY);
      location.reload();
    });
    document.addEventListener('click', (event) => {
      const menu = bar.querySelector('#shipment-columns-menu');
      if (!bar.contains(event.target)) menu.hidden = true;
    });
  }

  function columnMeta() {
    const table = getTable();
    if (!table) return [];
    return Array.from(table.querySelectorAll('thead tr:first-child th')).map((th, index) => ({
      key: th.dataset.gridKey || th.getAttribute('data-field') || `column-${index}`,
      label: (th.textContent || '').trim() || `Column ${index + 1}`,
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

  function renderColumnsMenu(menu) {
    assignHeaderKeys();
    const prefs = readPrefs();
    const cols = columnMeta().filter((c) => c.key !== '__actions');
    menu.innerHTML = `<strong>Visible columns</strong>${cols.map((col) => `
      <label><input type="checkbox" data-column="${col.key}" ${prefs.hidden.includes(col.key) ? '' : 'checked'}> ${col.label}</label>`).join('')}`;
    menu.querySelectorAll('[data-column]').forEach((input) => {
      input.addEventListener('change', () => {
        const key = input.dataset.column;
        const next = new Set(readPrefs().hidden);
        input.checked ? next.delete(key) : next.add(key);
        const current = readPrefs();
        current.hidden = Array.from(next);
        savePrefs(current);
        applyPreferences();
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

  function applyPreferences() {
    const table = getTable();
    if (!table) return;
    assignHeaderKeys();
    const prefs = readPrefs();
    const currentKeys = columnMeta().map((c) => c.key);
    const desired = [...prefs.order.filter((key) => currentKeys.includes(key)), ...currentKeys.filter((key) => !prefs.order.includes(key))];
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
      const width = prefs.widths[key];
      if (width) table.querySelectorAll('tr').forEach((row) => {
        const cell = row.children[index];
        if (cell) { cell.style.width = `${width}px`; cell.style.minWidth = `${width}px`; }
      });
    });
    wireHeaders();
    wireCells();
  }

  function wireHeaders() {
    const table = getTable();
    if (!table) return;
    Array.from(table.querySelectorAll('thead tr:first-child th')).forEach((th) => {
      if (th.dataset.gridEnhanced === '1') return;
      th.dataset.gridEnhanced = '1';
      th.draggable = th.dataset.gridKey !== '__actions';
      th.addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', th.dataset.gridKey));
      th.addEventListener('dragover', (event) => event.preventDefault());
      th.addEventListener('drop', (event) => {
        event.preventDefault();
        const source = event.dataTransfer.getData('text/plain');
        const target = th.dataset.gridKey;
        if (!source || !target || source === target) return;
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
      th.appendChild(handle);
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault(); event.stopPropagation();
        const startX = event.clientX, startWidth = th.getBoundingClientRect().width;
        const key = th.dataset.gridKey;
        const move = (e) => {
          const width = Math.max(70, Math.round(startWidth + e.clientX - startX));
          const index = Array.from(th.parentElement.children).indexOf(th);
          table.querySelectorAll('tr').forEach((row) => {
            const cell = row.children[index];
            if (cell) { cell.style.width = `${width}px`; cell.style.minWidth = `${width}px`; }
          });
        };
        const up = () => {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', up);
          const prefs = readPrefs();
          prefs.widths[key] = Math.round(th.getBoundingClientRect().width);
          savePrefs(prefs);
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up, { once: true });
      });
    });
  }

  function visibleDataCells(row) {
    return Array.from(row.querySelectorAll('td[data-field]:not(.shipment-column-hidden)'));
  }

  function focusCell(cell) {
    if (!cell) return;
    cell.click();
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
      td.addEventListener('keydown', (event) => {
        if (td.isContentEditable || event.target !== td) return;
        const row = td.closest('tr[data-ref]');
        if (!row) return;
        const rows = Array.from(table.querySelectorAll('tbody tr[data-ref]'));
        const cells = visibleDataCells(row);
        const col = cells.indexOf(td), rowIndex = rows.indexOf(row);
        let target = null;
        if (event.key === 'ArrowRight' || event.key === 'Tab' && !event.shiftKey) target = cells[col + 1] || visibleDataCells(rows[rowIndex + 1] || row)[0];
        else if (event.key === 'ArrowLeft' || event.key === 'Tab' && event.shiftKey) target = cells[col - 1] || visibleDataCells(rows[rowIndex - 1] || row).at(-1);
        else if (event.key === 'ArrowDown') target = visibleDataCells(rows[rowIndex + 1] || row)[col];
        else if (event.key === 'ArrowUp') target = visibleDataCells(rows[rowIndex - 1] || row)[col];
        else if (event.key === 'Enter') {
          event.preventDefault();
          td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          return;
        }
        if (target) { event.preventDefault(); focusCell(target); }
      });
    });
  }

  async function patchCell(td, value) {
    const row = td.closest('tr[data-ref]');
    const field = fieldOf(td);
    if (!row || !field || editableBlocked.has(field)) return false;
    const response = await fetch(`/api/shipments/${encodeURIComponent(row.dataset.ref)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value === '' ? null : value }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'save failed');
    td.textContent = value;
    td.classList.toggle('cell-empty', value === '');
    td.classList.add('is-saved');
    setTimeout(() => td.classList.remove('is-saved'), 900);
    return true;
  }

  function installPasteHandler() {
    if (window.__shipmentGridPasteInstalled) return;
    window.__shipmentGridPasteInstalled = true;
    document.addEventListener('paste', async (event) => {
      const table = getTable();
      const active = table?.querySelector('td.is-active-cell, td:focus');
      if (!table || !active || active.isContentEditable) return;
      const text = event.clipboardData?.getData('text/plain') || '';
      if (!text.includes('\t') && !text.includes('\n')) return;
      event.preventDefault();
      const rows = Array.from(table.querySelectorAll('tbody tr[data-ref]'));
      const startRow = rows.indexOf(active.closest('tr[data-ref]'));
      const startCells = visibleDataCells(rows[startRow]);
      const startCol = startCells.indexOf(active);
      const matrix = text.replace(/\r/g, '').split('\n').filter((line, i, arr) => line || i < arr.length - 1).map((line) => line.split('\t'));
      let saved = 0, skipped = 0;
      for (let r = 0; r < matrix.length; r++) {
        const row = rows[startRow + r];
        if (!row) break;
        const cells = visibleDataCells(row);
        for (let c = 0; c < matrix[r].length; c++) {
          const cell = cells[startCol + c];
          if (!cell) continue;
          try { (await patchCell(cell, matrix[r][c])) ? saved++ : skipped++; }
          catch { skipped++; }
        }
      }
      window.toast?.(`Pasted ${saved} shipment cell${saved === 1 ? '' : 's'}${skipped ? `; ${skipped} skipped` : ''}.`, skipped ? 'info' : 'success');
    });
  }

  function enhance() {
    ensureToolbar();
    applyPreferences();
    installPasteHandler();
  }

  const observer = new MutationObserver(() => requestAnimationFrame(enhance));
  function start() {
    const table = getTable();
    if (!table) return setTimeout(start, 150);
    observer.observe(table, { childList: true, subtree: true });
    enhance();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
