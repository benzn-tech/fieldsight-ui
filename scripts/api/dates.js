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
             dots are per accessible-site, not per user folder. */
          var r = await window.FS.api.orgRequest('/dates', {
            params: { months: opts.months, site: opts.site },
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

  window.FS.api.dates = { getDates: getDates };

})();
