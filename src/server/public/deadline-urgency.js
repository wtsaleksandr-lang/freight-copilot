/*
 * Deadline proximity coloring — pure, deterministic, date-only.
 *
 * Freight rows carry hard deadlines (cut-off, SI, draft, loading, ETD, ETA).
 * This module maps a date string to an urgency CSS class using TODAY's real
 * date (`new Date()`) — computed in CODE, never by the AI, because LLMs don't
 * know what "today" is. Both the deadline date and today are collapsed to a
 * local calendar day (time stripped) so the day count is stable regardless of
 * clock time.
 *
 * It publishes a single global (`LoadModeDeadlineUrgency`) and contains NO
 * import/export/module.exports, so the exact same source loads two ways:
 *   • the browser loads it as a classic <script> before app.js;
 *   • the node test suite `import()`s it (a side-effect ES module that just
 *     sets the global) and asserts the mapping.
 */
(function (root) {
  'use strict';

  // Day windows — small named constants so the thresholds are easy to tune.
  // daysUntil < 0                     → overdue   (red,   strongest)
  // 0 .. URGENT_DAYS                  → urgent    (amber, incl. today)
  // (URGENT_DAYS+1) .. SOON_DAYS      → soon      (soft yellow)
  // beyond SOON_DAYS / no date        → no class
  var DATE_URGENT_DAYS = 2;
  var DATE_SOON_DAYS = 7;
  var MS_PER_DAY = 86400000;

  // Parse a stored date value to a local midnight Date, or null if unparseable.
  // Accepts ISO 'YYYY-MM-DD' (the stored form) and anything Date can read.
  function parseDateOnly(v) {
    if (!v) return null;
    var s = String(v).trim();
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    var d;
    if (m) {
      d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    } else {
      var t = new Date(s);
      if (isNaN(t.getTime())) return null;
      d = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    }
    return isNaN(d.getTime()) ? null : d;
  }

  // Whole calendar days from today to the deadline (negative = in the past).
  function daysUntil(v, today) {
    var d = parseDateOnly(v);
    if (!d) return null;
    var now = today ? new Date(today) : new Date();
    var t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.ceil((d.getTime() - t0.getTime()) / MS_PER_DAY);
  }

  // Deadline value → urgency CSS class ('' when far off or no date).
  function deadlineUrgencyClass(v, today) {
    var n = daysUntil(v, today);
    if (n === null) return '';
    if (n < 0) return 'is-date-overdue';
    if (n <= DATE_URGENT_DAYS) return 'is-date-urgent';
    if (n <= DATE_SOON_DAYS) return 'is-date-soon';
    return '';
  }

  root.LoadModeDeadlineUrgency = {
    DATE_URGENT_DAYS: DATE_URGENT_DAYS,
    DATE_SOON_DAYS: DATE_SOON_DAYS,
    parseDateOnly: parseDateOnly,
    daysUntil: daysUntil,
    deadlineUrgencyClass: deadlineUrgencyClass,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
