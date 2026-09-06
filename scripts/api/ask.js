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

  /* POST /api/ask/corroborate  body { question, answer }
       → { corroborations, dropped, truncated, timed_out }

     The SECOND pass. `/ask` is capped by API Gateway's 29s integration timeout
     (the backend template says so in the comment explaining why that path runs
     haiku), so an external lookup plus a reconcile call cannot ride along on
     the request that already spends its budget on embed + rag-search +
     synthesis. The grounded answer lands first; this fills in underneath.

     `caller_sub` is deliberately NOT sent. The proxy injects it from the
     Cognito authorizer -- that is what stops a caller asking as someone else --
     and `/ask` never returns it, so there would be nothing to echo.

     Rejects like any other request. The caller is expected to render the
     failure rather than swallow it: with the flag on and the route broken,
     rendering nothing is indistinguishable from working-and-empty, which is a
     shape this repo has shipped three times. */
  async function corroborate(opts) {
    opts = opts || {};
    if (!window.FS.api.useMocks) {
      var askBaseUrl = (window.FS.api.orgBaseUrl) || undefined;
      return window.FS.api.request('/ask/corroborate', {
        method:  'POST',
        baseUrl: askBaseUrl,
        body:    { question: opts.question, answer: opts.answer },
      });
    }
    await window.FS.api.delay(900);
    /* A read stub serves the shape it would really return, and this one is
       shaped to exercise every branch the renderer has -- including the two
       that are easy to leave untested because they look like nothing:
       `not_found` and `no_checkable_claim`. An empty mock would claim the
       feature is finished and the data absent. */
    return {
      corroborations: [
        { entity: 'Naylor Love', kind: 'company', state: 'corroborated',
          claim: 'CEO is Rick Herd',
          summary: 'Company leadership pages list Rick Herd as Chief Executive.',
          sources: [{ title: 'Naylor Love — Leadership', url: 'https://www.naylorlove.co.nz/about/', published: '2026-03-11' }],
          retrieved_at: '2026-08-31T09:12:04Z' },
        { entity: 'NZS 3604', kind: 'standard', state: 'conflicts',
          claim: 'covers buildings up to 12m in height',
          summary: 'The standard states a 10m maximum for the light timber framing scope.',
          sources: [{ title: 'NZS 3604:2011 scope', url: 'https://www.standards.govt.nz/', published: null }],
          retrieved_at: '2026-08-31T09:12:04Z' },
        { entity: 'Tenpeak', kind: 'company', state: 'not_found',
          claim: 'is the main contractor on Pod 3',
          summary: null, sources: [],
          retrieved_at: '2026-08-31T09:12:04Z' },
        { entity: 'WorkSafe', kind: 'authority', state: 'no_checkable_claim',
          claim: null,
          summary: 'Mentioned in the answer, but the answer asserts nothing about it that an external source could confirm.',
          sources: [], retrieved_at: '2026-08-31T09:12:04Z' },
      ],
      /* The reasons the real gate emits, verbatim (src/corroboration_gate.py).
         They are prose written for a log line, not codes -- a mock that
         invented tidier ones would hide that from whoever styles this next. */
      dropped: [
        { entity: 'the Downtown claim', reason: "kind 'project' is not in the allowlist" },
        { entity: 'Rick Herd', reason: "shaped like a person's name" },
      ],
      truncated: false,
      timed_out: false,
      _query:    opts,
    };
  }

  window.FS.api.ask = { ask: ask, corroborate: corroborate };

})();
