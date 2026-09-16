/* ==========================================================================
   FieldSight API · Reports archive — BACKEND-CONTEXT §4.11
   --------------------------------------------------------------------------
   GET  /api/reports/history?limit=20      → { reports: [{ key, type, date, generated_at, size }] }
   POST /api/org/reports/regenerate body { report_type, date }
                                           → 202 { status:'queued', requestId }
        Regenerates the CALLER'S OWN report only; the folder comes from the
        caller's identity on the server. The legacy /api/reports/generate
        answers 410 (2026-09-15).
   ========================================================================== */

(function () {
  'use strict';

  function fixtures() {
    return (window.FieldSight && window.FieldSight.fixtures) || {};
  }

  async function getReportsHistory(limit) {
    if (!window.FS.api.useMocks) {
      var params = { limit: limit || 20 };
      /* authority flip (pipeline plan 2026-07-14): the legacy /reports/history
         gateway resolves the caller from the OLD DynamoDB identity store,
         a different store than Aurora `users` — an Aurora-only account
         (e.g. a site_manager with no DynamoDB row) resolves to role='viewer'
         there, which is now deny-all and returns an empty archive even
         though the report S3 objects exist. Mirrors transcripts.js's aurora
         gate (getTranscripts, api/transcripts.js) verbatim; 'aurora' only
         takes effect when orgBaseUrl is non-empty (kill switch). */
      if (window.FS.api.timelineSource === 'aurora' && window.FS.api.orgBaseUrl) {
        return window.FS.api.orgRequest('/reports/history', { params: params });
      }
      return window.FS.api.request('/reports/history', { params: params });
    }
    await window.FS.api.delay();
    var rows = (fixtures().reportHistory || []).slice(0, limit || 20);
    return { reports: rows };
  }

  async function regenerate(opts) {
    opts = opts || {};
    if (!window.FS.api.useMocks) {
      /* Only the type and the date travel. No folder: the server takes it from
         the caller, so there is nothing a client could send to reach someone
         else's report. retry:false because a lost 202 retried is a second
         generation of the same report. The legacy gateway route this used to
         call is closed; off the org API there is nothing to call. */
      if (window.FS.api.timelineSource === 'aurora' && window.FS.api.orgBaseUrl) {
        return window.FS.api.orgRequest('/reports/regenerate', {
          method: 'POST',
          body:   { report_type: opts.report_type, date: opts.date },
          retry:  false,
        });
      }
      return { status: 'unavailable', error: 'Regenerate needs the org API.' };
    }
    await window.FS.api.delay(150);
    return {
      message: 'Regeneration of ' + (opts.report_type || 'daily') + ' for ' + (opts.date || 'latest') + ' queued.',
      status:  'pending',
    };
  }

  window.FS.api.reports = {
    getReportsHistory: getReportsHistory,
    regenerate:        regenerate,
  };

})();
