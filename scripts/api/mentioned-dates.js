/* ==========================================================================
   api/mentioned-dates.js — the dates a day's report says somebody named.

   `critical_dates_and_deadlines` has been on the wire since the report
   generator shipped and nothing in scripts/ has ever read it. 239 entries
   across 62 of the 99 prod reports that carry topics.

   Ordering reuses FS.api.resolveDeadline. It resolves 184 of those 239 (77 %)
   — weekday names, today/tomorrow, "next week", "within N days" — against the
   report's own date. The spec's first draft ordered only on ISO literals and
   put 121 orderable entries into the unordered tail; today-ordering.js:84-92
   had already rejected that exact split in writing.

   Registers as FS.api.mentionedDates.
   ========================================================================== */
(function () {
  'use strict';

  function resolved(entry, reportDate) {
    var api = window.FS && window.FS.api;
    if (!entry || !entry.date_mentioned || !api || !api.resolveDeadline) return null;
    var r = api.resolveDeadline(entry.date_mentioned, reportDate);
    return (r && r.absolute) ? r : null;
  }

  /* The resolved day when there is one, else the phrase verbatim.

     `display` rather than `absolute` because the resolver puts a time of day
     into display when the text had one, and that is information. For a purely
     relative phrase display IS the resolved date — which is the point: a row
     reading "Tomorrow" under a day header read three weeks later is a trap,
     and the words said survive in `context`. */
  function dateLabel(entry, reportDate) {
    if (!entry || !entry.date_mentioned) return '';
    var r = resolved(entry, reportDate);
    return r ? (r.display || r.absolute) : String(entry.date_mentioned);
  }

  /* Resolved first, ascending; the rest in payload order, after.

     The index tiebreak is what makes the comparator total — without it the
     list reshuffles between renders, which on a list people plan from reads
     as data changing. */
  function orderEntries(entries, reportDate) {
    return (entries || []).map(function (x, i) { return { x: x, i: i }; })
      .sort(function (a, b) {
        var ra = resolved(a.x, reportDate), rb = resolved(b.x, reportDate);
        if (ra && rb) {
          if (ra.absolute !== rb.absolute) return ra.absolute < rb.absolute ? -1 : 1;
          return a.i - b.i;
        }
        if (ra) return -1;
        if (rb) return 1;
        return a.i - b.i;
      })
      .map(function (o) { return o.x; });
  }

  /* 115 of 239 are high, 93 medium, 31 low. A chip on medium marks two rows in
     five, which marks nothing; a chip on low says "do not look here", which a
     chip cannot say quietly. */
  function showsUrgency(entry) {
    return String((entry && entry.urgency) || '').toLowerCase() === 'high';
  }

  /* Same name on every row of a single-author day is noise. */
  function showsAuthor(entry, reportAuthor) {
    var who = entry && entry.who_mentioned;
    return !!(who && String(who).trim() && who !== reportAuthor);
  }

  var mod = { orderEntries: orderEntries, dateLabel: dateLabel,
              showsUrgency: showsUrgency, showsAuthor: showsAuthor };
  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.mentionedDates = mod;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})();
