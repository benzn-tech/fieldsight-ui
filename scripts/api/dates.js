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

  async function fetchDates(opts) {
    if (!window.FS.api.useMocks) {
      return window.FS.api.request('/dates', {
        /* `user` narrows the dots to one user's report days so the
           timeline date-picker matches its per-user fetch (admin dots
           were a union across all users — dotted dates with no content
           for the selected user). Empty/undefined → old behavior. */
        params: { months: opts.months, site: opts.site, user: opts.user },
      });
    }
    await window.FS.api.delay();
    var f = fixtures().dates || { dates: {} };
    /* Sprint 2.1: site filter is a no-op against the fixture. Real backend
       filters by accessible users on the requested site. */
    return { dates: f.dates, months: opts.months || 3, site: opts.site || null };
  }

  /* Session-stable read: the date index is generated server-side and not
     edited in-app, so a few minutes of staleness is safe — see
     api/_cache.js. Cache key is (months, user) only — NOT `site` (see
     PR description / delivery report for why that's safe today). */
  function getDates(opts) {
    opts = opts || {};
    var key = 'dt:' + (opts.months || '') + ':' + (opts.user || '');
    return window.FS.api.cache.cached(key, undefined, function () {
      return fetchDates(opts);
    });
  }

  window.FS.api.dates = { getDates: getDates };

})();
