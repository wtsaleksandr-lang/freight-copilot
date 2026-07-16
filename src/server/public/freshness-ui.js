// Rate freshness UI layer.
// Loaded before app.js so it can observe quote API responses without changing the
// large legacy dashboard script. Adds a colored badge and subtle row tint.
(function installRateFreshnessUi() {
  const originalFetch = window.fetch.bind(window);
  const state = {
    liveRates: [],
    historyFreshness: [],
  };

  const DAY_MS = 24 * 60 * 60 * 1000;

  function parseDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function classify(validUntil, parsedAt) {
    const now = new Date();
    const validity = parseDate(validUntil);
    const source = parseDate(parsedAt);

    if (validity) {
      const end = new Date(validity);
      end.setHours(23, 59, 59, 999);
      const days = Math.ceil((end.getTime() - now.getTime()) / DAY_MS);
      if (end.getTime() < now.getTime()) {
        return {
          color: 'red',
          label: 'Expired',
          message: `Validity ended ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago. Refresh before quoting.`,
        };
      }
      if (days <= 7) {
        return {
          color: 'yellow',
          label: 'Expiring soon',
          message: `Validity ends in ${days} day${days === 1 ? '' : 's'}.`,
        };
      }
      return {
        color: 'green',
        label: 'Current',
        message: `Valid through ${validity.toISOString().slice(0, 10)}.`,
      };
    }

    if (!source) {
      return {
        color: 'gray',
        label: 'Unknown age',
        message: 'No validity date or reliable source date is available.',
      };
    }

    const age = Math.max(0, Math.floor((now.getTime() - source.getTime()) / DAY_MS));
    if (age <= 14) {
      return {
        color: 'green',
        label: 'Recently captured',
        message: `No validity date; source was captured ${age} day${age === 1 ? '' : 's'} ago.`,
      };
    }
    if (age <= 30) {
      return {
        color: 'yellow',
        label: 'Aging',
        message: `No validity date; source is ${age} days old. Consider refreshing.`,
      };
    }
    return {
      color: 'red',
      label: 'Likely outdated',
      message: `No validity date; source is ${age} days old. Refresh before quoting.`,
    };
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function badge(freshness) {
    if (!freshness) return '';
    return `<span class="rate-freshness-badge freshness-${freshness.color}" title="${escapeHtml(freshness.message)}"><span class="freshness-dot"></span>${escapeHtml(freshness.label)}</span>`;
  }

  function flagsColumnIndex(table) {
    const headers = Array.from(table.querySelectorAll('thead th'));
    return headers.findIndex((th) => th.textContent.trim().toLowerCase() === 'flags');
  }

  function decorateLiveTable() {
    const table = document.getElementById('results-table');
    if (!table || state.liveRates.length === 0) return;
    const flagIndex = flagsColumnIndex(table);
    if (flagIndex < 0) return;

    const rows = Array.from(table.querySelectorAll('tbody > tr:not(.breakdown-row)'));
    rows.forEach((row, index) => {
      const rate = state.liveRates[index];
      if (!rate) return;
      const freshness = rate.freshness || classify(
        rate.valid_until ?? rate.validUntil,
        rate.parsed_at ?? rate.parsedAt ?? new Date()
      );
      const cell = row.children[flagIndex];
      if (!cell) return;
      row.classList.remove('freshness-row-green', 'freshness-row-yellow', 'freshness-row-red', 'freshness-row-gray');
      row.classList.add(`freshness-row-${freshness.color}`);
      cell.querySelector('.rate-freshness-badge')?.remove();
      cell.insertAdjacentHTML('afterbegin', badge(freshness));
    });
  }

  function decorateHistoryTable() {
    const table = document.getElementById('quote-detail-table');
    if (!table || state.historyFreshness.length === 0) return;
    const headerRow = table.querySelector('thead tr');
    if (!headerRow) return;

    let freshnessIndex = Array.from(headerRow.children).findIndex(
      (th) => th.textContent.trim().toLowerCase() === 'freshness'
    );
    if (freshnessIndex < 0) {
      const th = document.createElement('th');
      th.textContent = 'Freshness';
      headerRow.appendChild(th);
      freshnessIndex = headerRow.children.length - 1;
    }

    const rows = Array.from(table.querySelectorAll('tbody > tr'));
    rows.forEach((row, index) => {
      const option = state.historyFreshness[index];
      const freshness = option?.freshness || option?.validation || null;
      if (!freshness) return;
      while (row.children.length <= freshnessIndex) row.appendChild(document.createElement('td'));
      const cell = row.children[freshnessIndex];
      row.classList.remove('freshness-row-green', 'freshness-row-yellow', 'freshness-row-red', 'freshness-row-gray');
      row.classList.add(`freshness-row-${freshness.color}`);
      cell.innerHTML = badge(freshness);
    });
  }

  function scheduleDecorate() {
    setTimeout(() => {
      decorateLiveTable();
      decorateHistoryTable();
    }, 0);
  }

  window.fetch = async function freshnessAwareFetch(input, init) {
    const response = await originalFetch(input, init);
    const url = typeof input === 'string' ? input : input?.url || '';

    if (response.ok && url.includes('/api/bundle/run')) {
      response.clone().json().then((data) => {
        const all = [];
        for (const carrier of data.carriers || []) {
          if (carrier.status !== 'ok') continue;
          for (const rate of carrier.ranked || []) all.push(rate);
        }
        all.sort((a, b) => (a.freight_total ?? 0) - (b.freight_total ?? 0));
        state.liveRates = all;
        scheduleDecorate();
      }).catch(() => {});
    } else if (response.ok && /\/api\/quote(?:\?|$)/.test(url)) {
      response.clone().json().then((data) => {
        state.liveRates = data.ranked || [];
        scheduleDecorate();
      }).catch(() => {});
    } else if (response.ok && /\/api\/quotes\/\d+(?:\?|$)/.test(url) && !url.includes('/validation')) {
      const match = url.match(/\/api\/quotes\/(\d+)/);
      if (match) {
        originalFetch(`/api/quotes/${match[1]}/validation`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            state.historyFreshness = data?.options || [];
            scheduleDecorate();
          })
          .catch(() => {});
      }
    }

    return response;
  };

  const observer = new MutationObserver(scheduleDecorate);
  window.addEventListener('DOMContentLoaded', () => {
    const results = document.getElementById('results-table');
    const history = document.getElementById('quote-detail-table');
    if (results) observer.observe(results, { childList: true, subtree: true });
    if (history) observer.observe(history, { childList: true, subtree: true });
  });
})();
