/* ==========================================================================
   FieldSight API · Topic Search (mechanism 1)
   --------------------------------------------------------------------------
   POST /api/search { question, date_from?, date_to? }
     → { results:[{report_date, site_name, topic_id, title, snippet,
                   chunk_type, route, score}], count }

   Semantic retrieve-only (no LLM). Routed to the org gateway's report base
   (orgBaseUrl → /api/{proxy+} → fieldsight-test-api), same as /ask. When the
   query is shorter than 2 chars we short-circuit locally (no round-trip).
   ========================================================================== */
(function () {
  'use strict';

  async function topics(opts) {
    opts = opts || {};
    var q = (opts.q || '').trim();
    if (q.length < 2) return { results: [], count: 0 };

    if (window.FS.api.useMocks) {
      /* Mock mode: no server topic search — return empty so the palette's
         client-side task/safety/site/people matches still drive the results. */
      return { results: [], count: 0, _mock: true };
    }

    var body = { question: q };
    /* Project documents (backend spec 2026-10-16, R7): their own group in the palette.
       The backend answers without a `documents` key when the feature is off. */
    body.include_documents = true;
    if (opts.from) body.date_from = opts.from;
    if (opts.to)   body.date_to   = opts.to;
    /* Project-scoped search: when a project is selected in the top bar, scope
       to it; "All projects" (null) searches everything. Ask stays cross-project
       (ask.js never sends site). Callers can override via opts.site. */
    var siteId = opts.site !== undefined
      ? opts.site
      : (window.FS.siteContext && window.FS.siteContext.get && window.FS.siteContext.get());
    if (siteId) body.site = siteId;
    /* The browser's IANA zone, so the backend can turn "yesterday" or "last
       week" in the question into a date range (pipeline #1100). Explicit
       from/to above always win over it. A runtime that cannot name its zone
       sends nothing and the search stays unfiltered, as before. */
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) body.tz = tz;
    } catch (e) { /* no zone: unfiltered search */ }

    return window.FS.api.request('/search', {
      method:  'POST',
      baseUrl: window.FS.api.orgBaseUrl || undefined,
      body:    body,
    });
  }

  window.FS.api.search = { topics: topics };
})();
