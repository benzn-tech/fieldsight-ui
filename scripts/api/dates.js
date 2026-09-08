/* ==========================================================================
   FieldSight API · Calendar dates — BACKEND-CONTEXT §4.3
   --------------------------------------------------------------------------
   GET /api/dates?months=3&site=<site_id>  →  { dates: { 'YYYY-MM-DD': { hasReport, topics, safety } } }
   ========================================================================== */

(function () {
  'use strict';

  function fixtures() {
    return (window.FieldSight && window.FieldSight.fixtures) || {};
  }

  /* Aurora dots only when the item store is the timeline source AND the org
     gateway is live (same kill switch as timeline.js's timelineSource()). */
  function datesSource() {
    var api = window.FS.api;
    return (api.timelineSource === 'aurora' && api.orgBaseUrl) ? 'aurora' : 'report';
  }

  async function fetchDates(opts) {
    if (!window.FS.api.useMocks) {
      /* `user` narrows the dots to one user's report days so the
         timeline date-picker matches its per-user fetch (admin dots
         were a union across all users — dotted dates with no content
         for the selected user). Empty/undefined → old behavior. Only
         used on the legacy report path — see the aurora branch below. */
      var params = { months: opts.months, site: opts.site, user: opts.user };
      if (datesSource() === 'aurora') {
        try {
          /* org /api/org/dates is membership-scoped and rejects an
             out-of-scope ?site (kills the legacy dots leak). No ?user: the
             dots are per accessible-site, not per user folder.

             `uploads: 1` is OPT-IN on the backend and this is the opt-in.
             Without it a day is in this index only when extraction produced
             topics, so the calendar stops whenever extraction does: measured
             2026-09-08, 18 of 42 prod capture days (166 photos, 83 sessions)
             had no topics row at all, including the two most recent. See
             hasContent() below for what reads the extra field, and
             lambda_org_api.py:4528 for why the default response stays
             byte-identical without it.

             AURORA ONLY. The legacy get_dates (lambda_fieldsight_api.py:558)
             ignores unknown params, so sending it there would be a silent
             no-op that reads like a feature. */
          var r = await window.FS.api.orgRequest('/dates', {
            params: { months: opts.months, site: opts.site, uploads: 1 },
          });
          if (r && !r._accessDenied) return r;
        } catch (e) { /* org transport failure → flag-gated report fallback */ }
        if (!window.FS.api.legacyReadFallback) return { dates: {} };  // D5: legacy retired
      }
      return window.FS.api.request('/dates', { params: params });      // legacy read path
    }
    await window.FS.api.delay();
    var f = fixtures().dates || { dates: {} };
    /* Sprint 2.1: site filter is a no-op against the fixture. Real backend
       filters by accessible users on the requested site. */
    return { dates: f.dates, months: opts.months || 3, site: opts.site || null };
  }

  /* Session-stable read: the date index is generated server-side and not
     edited in-app, so a few minutes of staleness is safe — see
     api/_cache.js. Cache key includes `site` because in live mode it's
     forwarded to the backend query (date-picker / timeline pass it); a
     project switch within the TTL must not serve the previous site's
     date-map. Harmless in mock mode (site is a fixture no-op → undefined).
     Also includes datesSource() so aurora↔report don't collide when the
     timelineSource/orgBaseUrl flags change within a session. */
  function getDates(opts) {
    opts = opts || {};
    var key = 'dt:' + datesSource() + ':' + (opts.months || '') + ':' + (opts.user || '') + ':' + (opts.site || '');
    return window.FS.api.cache.cached(key, undefined, function () {
      return fetchDates(opts);
    });
  }

  /* "Is there anything here?" — the question the calendar, the date span and
     Evidence's day list are actually asking, as against "did extraction
     produce topics", which is what hasReport answers and what all of them
     used to read.

     THE ABSENCE OF hasUploads IS THE FALLBACK, not a missing case. Three
     producers never set it: the legacy report path, mock mode, and any
     backend older than pipeline #775. All three fall through to hasReport
     and behave exactly as they did before this function existed, which is
     why there is no flag and nothing to migrate.

     Callers that fan out REPORT requests must keep reading hasReport
     directly — an uploads-only day has no report to fetch, and widening
     them spends requests on days that 404. The five are listed in
     docs/specs/2026-09-08-days-with-content-not-days-with-reports.md §4b
     and each carries a comment saying so. */
  function hasContent(meta) {
    return !!(meta && (meta.hasReport || meta.hasUploads));
  }

  window.FS.api.dates = { getDates: getDates, hasContent: hasContent };

  /* Node test runner only; no-op in the browser. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { hasContent: hasContent, fetchDates: fetchDates };
  }

})();
