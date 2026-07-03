/* ==========================================================================
   FieldSight API · Data window / span — date-range batch (Task A)
   --------------------------------------------------------------------------
   Wide-discovery layer sitting on top of FS.api.dates. Real report data
   currently only exists 2026-02-09..2026-03-20 while "today" runs months
   ahead of it, so every aggregate surface (Safety/Quality/Evidence/
   Insights/Today/Search) needs to look far enough back to find it.
   MONTHS_LOOKBACK is the one place that constant lives — every widened
   call site (DatePicker, compliance-aggregator, RangeToolbar, ...) reads
   it from here instead of hardcoding its own magic number.

   window.FS.api.window.MONTHS_LOOKBACK
       24 — trailing months passed to GET /api/dates for wide discovery.

   window.FS.api.window.getSpan()
       Promise<{dates, earliest, latest}>. `dates` is the raw
       getDates({months:24}) date map; `earliest`/`latest` are the
       min/max keys with hasReport truthy (null/null if none). Cached
       in-memory so concurrent callers share a single in-flight fetch.

   window.FS.api.window.resolve(preset, custom, span)
       Pure — no I/O. 'today'|'7d'|'30d'|'all'|'custom' => {from, to}.
         'today'  → {from: today, to: today}            (todayNZDT())
         '7d'     → trailing 7 days ending today (inclusive)
         '30d'    → trailing 30 days ending today (inclusive)
         'all'    → {from: span.earliest, to: span.latest}
         'custom' → {from: custom.from, to: custom.to}
       Unrecognised presets fall back to 'today' behaviour.
   ========================================================================== */

/* global window */

(function () {
  'use strict';

  var MONTHS_LOOKBACK = 24;

  /* Cached in-flight/resolved span promise — shared across all callers so
     a page that mounts five components each calling getSpan() still only
     triggers one GET /api/dates. */
  var spanPromise = null;

  function computeSpan(datesMap) {
    var reportKeys = Object.keys(datesMap).filter(function (k) {
      return datesMap[k] && datesMap[k].hasReport;
    }).sort();

    return {
      dates: datesMap,
      earliest: reportKeys.length ? reportKeys[0] : null,
      latest:   reportKeys.length ? reportKeys[reportKeys.length - 1] : null,
    };
  }

  function getSpan() {
    if (!spanPromise) {
      spanPromise = window.FS.api.dates.getDates({ months: MONTHS_LOOKBACK })
        .then(function (res) {
          return computeSpan((res && res.dates) || {});
        })
        .catch(function (err) {
          /* Don't cache a rejected promise — let the next caller retry
             instead of every future getSpan() call failing forever. */
          spanPromise = null;
          throw err;
        });
    }
    return spanPromise;
  }

  function resolve(preset, custom, span) {
    var today = window.FS.api.todayNZDT();
    span = span || {};
    custom = custom || {};

    switch (preset) {
      case '7d':
        return { from: window.FS.api.addDaysISO(today, -6), to: today };
      case '30d':
        return { from: window.FS.api.addDaysISO(today, -29), to: today };
      case 'all':
        return { from: span.earliest || null, to: span.latest || null };
      case 'custom':
        return { from: custom.from || null, to: custom.to || null };
      case 'today':
      default:
        return { from: today, to: today };
    }
  }

  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};

  window.FS.api.window = {
    MONTHS_LOOKBACK: MONTHS_LOOKBACK,
    getSpan: getSpan,
    resolve: resolve,
  };

})();
