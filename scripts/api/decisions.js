/* ==========================================================================
   FieldSight API · decisions -- the site decision loop's shadow review (P0).
   --------------------------------------------------------------------------
   Two org-api routes (backend plan 2026-11-08 site-decision-loop-p0, Task 6),
   platform_admin only on the server, 404 while SITE_DECISION_LOOP is off:

     GET  /api/org/decision-shadow?label=&limit=&offset=
          -> { cards: [...], summary: { labelled, needed, not_needed,
               wrong_evidence, precision|null, cards_per_recipient_day_p95|null } }
     POST /api/org/decision-shadow/{card_id}/label
          body EXACTLY { label: needed|not_needed|wrong_evidence, note }
          -> the card

   Both ride FS.api.orgRequest, which RESOLVES (does not throw) a 403 as
   { _accessDenied: true, status: 403 } and a 404 as { _notFound: true,
   status: 404 }; the page reads those envelopes.

   Gate: org LIVE (!useMocks && orgBaseUrl) for reads AND for the label write.
   Deliberately not orgWrite(): with orgWrites=false a label click would land
   in the mock and the reviewer would believe it saved. In mock mode (or with
   no org base URL) a small in-memory set of cards answers instead, so the
   page renders with no backend.

   window.FS.api.decisions.listShadow({ label, limit, offset })
   window.FS.api.decisions.label(cardId, label, note)
   ========================================================================== */
(function () {
  'use strict';
  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};

  var api = window.FS.api;
  var LABELS = ['needed', 'not_needed', 'wrong_evidence'];

  function orgLive() { return !api.useMocks && !!api.orgBaseUrl; }

  /* The POST body, built from exactly `label` and `note` and nothing else
     (the ui api layer is the whitelist: memory "api layer whitelists the
     request body"). A caller may pass an object for `label`; only its
     `label` and `note` survive. */
  function labelBody(label, note) {
    if (label && typeof label === 'object') {
      note = label.note;
      label = label.label;
    }
    return { label: String(label || ''), note: (note === null || note === undefined) ? '' : String(note) };
  }

  function listParams(opts) {
    opts = opts || {};
    var p = {};
    if (opts.label) p.label = opts.label;
    if (opts.limit !== undefined && opts.limit !== null) p.limit = opts.limit;
    if (opts.offset !== undefined && opts.offset !== null) p.offset = opts.offset;
    return p;
  }

  /* ---- mock (useMocks / no org base URL) ---------------------------------- */

  var MOCK_CARDS = [
    {
      card_id: 'mock-card-1', company_name: 'Demo Builders', site_name: '12 Harbour St',
      rule_id: 'todo.overdue', kind: 'choose', purpose: 'overdue',
      question: "'Order rebar for level 2' was due 6 Nov 2026, still open",
      consequence: 'The level 2 pour may slip.',
      options: [
        { id: 'remind', label: 'Remind the owner', recommended: true },
        { id: 'done', label: 'Mark done', recommended: false },
        { id: 'new_date', label: 'Set a new date', recommended: false },
        { id: 'not_needed', label: 'No longer needed', recommended: false },
      ],
      evidence: [{ quote: "Tom, can you get the rebar ordered by Thursday?", at: '2026-11-04T21:12:00Z' }],
      recipients: [{ user_id: 'u-pm-1', role: 'pm' }, { user_id: 'u-sm-1', role: 'site_manager' }],
      urgency: 'normal', status: 'open', shadow_label: null, label_note: null,
      created_at: '2026-11-07T19:05:00Z',
    },
    {
      card_id: 'mock-card-2', company_name: 'Demo Builders', site_name: 'Block B, Riverside',
      rule_id: 'checklist.gap', kind: 'choose', purpose: 'gap',
      question: "Pre-pour: 'Edge protection hazard' not covered",
      consequence: 'A safety item on the checklist was not checked.',
      options: [
        { id: 'remind', label: 'Remind Tom to recheck', recommended: true },
        { id: 'accept', label: 'Accept with reason', recommended: false, reason_required: true },
        { id: 'reassign', label: 'Reassign', recommended: false },
      ],
      evidence: [],
      recipients: [{ user_id: 'u-pm-2', role: 'pm' }, { user_id: 'u-admin-1', role: 'company_admin' }],
      urgency: 'injury', status: 'open', shadow_label: 'needed', label_note: 'Real gap',
      created_at: '2026-11-06T22:40:00Z',
    },
  ];

  function mockSummary() {
    var s = { labelled: 0, needed: 0, not_needed: 0, wrong_evidence: 0, precision: null,
              cards_per_recipient_day_p95: null };
    MOCK_CARDS.forEach(function (c) {
      if (LABELS.indexOf(c.shadow_label) === -1) return;
      s.labelled++;
      s[c.shadow_label]++;
    });
    var d = s.needed + s.not_needed;
    s.precision = d ? s.needed / d : null;
    return s;
  }

  /* ---- routes -------------------------------------------------------------- */

  async function listShadow(opts) {
    var params = listParams(opts);
    if (orgLive()) {
      return api.orgRequest('/decision-shadow', { params: params });
    }
    if (api.delay) await api.delay();
    var cards = MOCK_CARDS.filter(function (c) { return !params.label || c.shadow_label === params.label; });
    var off = params.offset || 0;
    var lim = params.limit || cards.length;
    return { cards: cards.slice(off, off + lim).map(function (c) { return Object.assign({}, c); }),
             summary: mockSummary() };
  }

  async function label(cardId, labelValue, note) {
    var body = labelBody(labelValue, note);
    if (LABELS.indexOf(body.label) === -1) {
      throw new Error('Unknown label: ' + body.label);
    }
    if (orgLive()) {
      return api.orgRequest('/decision-shadow/' + encodeURIComponent(cardId) + '/label',
        { method: 'POST', body: body });
    }
    if (api.delay) await api.delay();
    var card = MOCK_CARDS.filter(function (c) { return c.card_id === cardId; })[0];
    if (!card) return { _notFound: true, status: 404 };
    card.shadow_label = body.label;
    card.label_note = body.note;
    card.labelled_at = new Date().toISOString();
    return Object.assign({}, card);
  }

  window.FS.api.decisions = {
    LABELS: LABELS,
    listShadow: listShadow,
    label: label,
    _labelBody: labelBody,
  };
})();
