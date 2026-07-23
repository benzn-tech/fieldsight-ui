/* ==========================================================================
   FieldSight API · Reports archive — BACKEND-CONTEXT §4.11
   --------------------------------------------------------------------------
   GET  /api/reports/history?limit=20      → { reports: [{ key, type, date, generated_at, size }] }
   POST /api/reports/generate body { report_type, date?, force? }
                                           → 202 { message, status:'pending' }
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
      return window.FS.api.request('/reports/generate', {
        method: 'POST',
        body: {
          report_type: opts.report_type,
          date:        opts.date,
          force:       !!opts.force,
        },
      });
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
