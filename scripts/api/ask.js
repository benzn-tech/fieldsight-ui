/* ==========================================================================
   FieldSight API · Ask Agent — BACKEND-CONTEXT §4.12
   --------------------------------------------------------------------------
   POST /api/ask  body { date, user, question, scope?, topic_id? }
     → { answer, citations, model, ... }

   Stateless on the server (BACKEND-CONTEXT §10) — multi-turn must be
   reconstructed client-side and resent each call.
   ========================================================================== */

(function () {
  'use strict';

  /* The browser's IANA zone, or '' when the runtime cannot say. Never throws:
     losing the zone costs a narrowed search, and must not cost the answer. */
  function _browserZone() {
    try {
      return (Intl.DateTimeFormat().resolvedOptions().timeZone) || '';
    } catch (e) {
      return '';
    }
  }

  async function ask(opts) {
    opts = opts || {};
    if (!window.FS.api.useMocks) {
      /* Route /ask to the org gateway's report base (the TEST fieldsight-api),
         not the prod report baseUrl. The Phase 5 RAG ask — date-optional
         global Ask + caller_sub forwarding + rag-search over report_chunks —
         is deployed on the TEST report API; the prod report API that baseUrl
         points to is pre-Phase-5 and 400s "Missing date" on the date-less
         global Ask fired from the search palette. Falls back to the default
         baseUrl when orgBaseUrl is unset (pure-prod deploy). */
      var askBaseUrl = (window.FS.api.orgBaseUrl) || undefined;
      var body = {
        date:     opts.date,
        user:     opts.user,
        question: opts.question,
        scope:    opts.scope,
        topic_id: opts.topic_id,
      };
      /* The zone the question is being asked FROM. The backend reads relative
         time out of the question ("yesterday", "this week") and can only
         resolve it against the asker's own calendar day — and the browser is
         the only party that knows which that is.

         A zone id, never a date computed here: New Zealand and Australia are
         both on daylight saving for part of the year and do NOT switch on the
         same date, so a date is wrong for one market for several weeks a year.
         `resolvedOptions().timeZone` is the id, e.g. 'Pacific/Auckland'.

         Explicit null suppresses it (tests, and any caller that means "do not
         narrow"); omitted means "use this browser's". A missing zone is not an
         error at either end — the backend simply does not filter, which is what
         Ask did before this existed. */
      var tz = ('tz' in opts) ? opts.tz : _browserZone();
      if (tz) body.tz = tz;
      return window.FS.api.request('/ask', {
        method: 'POST',
        baseUrl: askBaseUrl,
        body: body,
      });
    }
    await window.FS.api.delay(400);
    return {
      answer:    'Mock answer for: "' + (opts.question || '') + '" (Sprint G wires the real Claude grounding).',
      citations: [],
      model:     'claude-haiku-4-5-20251001',
      scope:     opts.scope || 'both',
      _query:    opts,
    };
  }

  window.FS.api.ask = { ask: ask };

})();
