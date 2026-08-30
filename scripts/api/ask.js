/* ==========================================================================
   FieldSight API · Ask Agent — BACKEND-CONTEXT §4.12
   --------------------------------------------------------------------------
   POST /api/ask  body { date, user, question, scope?, topic_id?, tz? }
     → { answer, citations, model, basis?, ... }

   `tz` is an IANA zone id and is what makes "yesterday" / "last week" mean
   anything: the server anchors the range on the caller's calendar day and
   returns `basis {from, to, widened}` when it resolved one. Omit it and the
   search runs unfiltered, silently.

   Stateless on the server (BACKEND-CONTEXT §10) — multi-turn must be
   reconstructed client-side and resent each call.
   ========================================================================== */

(function () {
  'use strict';

  /* Undefined rather than a guess when the browser will not say. The server
     treats a missing zone and an unusable one identically -- no anchor, no
     range -- so a hardcoded fallback would only make a wrong day look like a
     real one. */
  function timeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch (e) {
      return undefined;
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
      return window.FS.api.request('/ask', {
        method: 'POST',
        baseUrl: askBaseUrl,
        body: {
          date:     opts.date,
          user:     opts.user,
          question: opts.question,
          scope:    opts.scope,
          topic_id: opts.topic_id,
          /* The browser's IANA zone, and a zone id rather than a date or an
             offset: the backend anchors "yesterday" / "last week" on the
             CALLER'S calendar day, and NZ and AU do not start daylight saving
             on the same date, so a date computed anywhere else is wrong for
             one market several weeks a year.

             Only this field makes the anchor reachable. Without it the server
             resolves no day, produces no range, and searches unfiltered --
             which is exactly the pre-existing behaviour, so the feature is
             not broken, it is silently absent. Verified against prod on
             2026-08-30: with tz the response carries
             basis {from, to, widened}; the gateway forwards the field only
             when the client sends it, and no client did. */
          tz:       timeZone(),
        },
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
