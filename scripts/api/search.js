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
      /* Mock mode keeps the palette's existing client-cache topic search. */
      return { results: [], count: 0, _mock: true };
    }

    var body = { question: q };
    if (opts.from) body.date_from = opts.from;
    if (opts.to)   body.date_to   = opts.to;

    return window.FS.api.request('/search', {
      method:  'POST',
      baseUrl: window.FS.api.orgBaseUrl || undefined,
      body:    body,
    });
  }

  window.FS.api.search = { topics: topics };
})();
