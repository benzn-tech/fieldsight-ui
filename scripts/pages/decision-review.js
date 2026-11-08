/* ==========================================================================
   FieldSight /decision-review -- shadow review of the site decision loop (P0)
   --------------------------------------------------------------------------
   In P0 the loop sends nothing: it raises cards (a question, options with one
   recommended, the evidence, who would get it) and stores them. A platform
   admin reads each card here and labels it needed / not needed / wrong
   evidence; the backend turns the labels into precision and the
   cards-per-recipient-per-day p95 (the spec's <= 3 gate). The page computes
   neither -- it shows the backend's summary.

   platform_admin only: the nav item (fs-globals.js NAV_ITEMS.decisionReview,
   platformAdminOnly) and both org-api routes check the role. A 404 means the
   SITE_DECISION_LOOP flag is off on this environment.

   Every piece of model or user text is rendered as a React text child, never
   as HTML.

   Registers as window.FieldSight.PAGES['/decision-review']
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  function h() { return React.createElement.apply(React, arguments); }

  var PAGE_SIZE = 50;

  var LABEL_TEXT = {
    needed: 'Needed',
    not_needed: 'Not needed',
    wrong_evidence: 'Wrong evidence',
  };

  var FILTERS = [
    { value: '', text: 'All' },
    { value: 'needed', text: 'Needed' },
    { value: 'not_needed', text: 'Not needed' },
    { value: 'wrong_evidence', text: 'Wrong evidence' },
  ];

  /* v1 recipient roles (spec §6.4) in words. */
  var ROLE_TEXT = {
    pm: 'Project manager',
    project_manager: 'Project manager',
    site_manager: 'Site manager',
    company_admin: 'Company admin',
    admin: 'Company admin',
    gm: 'GM',
    regional_manager: 'Regional manager',
    platform_admin: 'FieldSight ops',
  };

  function str(v) {
    return (v === null || v === undefined) ? '' : String(v);
  }

  function num(n) {
    return (n === null || n === undefined || n === '' || isNaN(Number(n))) ? '—' : String(Number(n));
  }

  /* precision is a 0..1 fraction or null (no needed + not_needed labels yet). */
  function precisionText(p) {
    if (p === null || p === undefined || p === '' || isNaN(Number(p))) return '—';
    return Math.round(Number(p) * 100) + '%';
  }

  function p95Text(v) {
    if (v === null || v === undefined || v === '' || isNaN(Number(v))) return '—';
    var n = Number(v);
    return String(Math.round(n * 10) / 10);
  }

  function summaryParts(summary) {
    var s = summary || {};
    return [
      ['Labelled', num(s.labelled)],
      ['Needed', num(s.needed)],
      ['Not needed', num(s.not_needed)],
      ['Wrong evidence', num(s.wrong_evidence)],
      ['Precision', precisionText(s.precision)],
      ['Cards per recipient per day (p95)', p95Text(s.cards_per_recipient_day_p95)],
    ];
  }

  /* After a label lands, move the counts from the old label to the new one so
     the line stays true without a reload. Precision is needed / (needed +
     not_needed), so it follows; the p95 does not depend on labels. */
  function applyLabelToSummary(summary, oldLabel, newLabel) {
    if (!summary) return summary;
    var s = Object.assign({}, summary);
    function bump(k, d) { if (typeof s[k] === 'number') s[k] = s[k] + d; }
    if (oldLabel === newLabel) return s;
    if (LABEL_TEXT[oldLabel]) bump(oldLabel, -1); else bump('labelled', 1);
    if (LABEL_TEXT[newLabel]) bump(newLabel, 1);
    if (typeof s.needed === 'number' && typeof s.not_needed === 'number') {
      var d = s.needed + s.not_needed;
      s.precision = d ? s.needed / d : null;
    }
    return s;
  }

  function nzWhen(at) {
    if (!at) return '';
    var f = window.FS && window.FS.api && window.FS.api.nzDateTime;
    return f ? f(at) : str(at);
  }

  function asList(v) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') return [v];
    if (typeof v === 'string' && v) return [v];
    return [];
  }

  /* A card from the backend, read defensively: any missing field is blank. */
  function cardView(c) {
    c = c || {};
    var options = asList(c.options).map(function (o, i) {
      if (typeof o === 'string') return { id: o, text: o, recommended: false };
      o = o || {};
      return { id: str(o.id || i), text: str(o.label || o.text || o.id),
               recommended: !!o.recommended, reasonRequired: !!o.reason_required };
    });
    var evidence = asList(c.evidence).map(function (e) {
      if (typeof e === 'string') return { quote: e, at: '' };
      e = e || {};
      return { quote: str(e.quote || e.text), at: str(e.at) };
    }).filter(function (e) { return e.quote; });
    var recipients = asList(c.recipients).map(function (r) {
      if (typeof r === 'string') return r;
      r = r || {};
      var who = str(r.name || r.display_name || r.email || r.user_id);
      var role = ROLE_TEXT[r.role] || str(r.role);
      return role && who ? who + ' (' + role + ')' : (who || role);
    }).filter(Boolean);
    return {
      id: str(c.card_id || c.id),
      company: str(c.company_name),
      site: str(c.site_name),
      rule: str(c.rule_id),
      kind: str(c.kind),
      purpose: str(c.purpose),
      urgency: str(c.urgency),
      question: str(c.question),
      consequence: str(c.consequence),
      options: options,
      evidence: evidence,
      recipients: recipients,
      created: nzWhen(c.created_at),
      label: LABEL_TEXT[c.shadow_label] ? c.shadow_label : '',
      note: str(c.label_note),
    };
  }

  /* orgRequest resolves 403/404 as envelopes; turn one into the page's words. */
  function envelopeMessage(res) {
    if (!res || typeof res !== 'object') return null;
    if (res._notFound && (res.status === 404 || res.status === undefined)) {
      return 'The decision loop is off on this environment.';
    }
    if (res._accessDenied && res.status === 403) return 'Platform admins only.';
    if (res._accessDenied) return str(res.error) || 'Please sign in again.';
    /* _fetch.js also returns _notFound for a non-JSON answer of any status (a
       gateway HTML error page): that is an outage, not the flag. */
    if (res._notFound) return 'Could not load (HTTP ' + str(res.status) + ').';
    return null;
  }

  function api() { return window.FS.api.decisions; }

  function SummaryLine(props) {
    return h('dl', { className: 'fs-decision__summary' },
      summaryParts(props.summary).map(function (p) {
        return h('div', { key: p[0], className: 'fs-decision__stat' },
          h('dt', null, p[0]), h('dd', null, p[1]));
      }));
  }

  function CardRow(props) {
    var v = cardView(props.card);
    var noteRef = React.useState(v.note);
    var note = noteRef[0]; var setNote = noteRef[1];
    var busyRef = React.useState(false);
    var busy = busyRef[0]; var setBusy = busyRef[1];
    var errRef = React.useState('');
    var err = errRef[0]; var setErr = errRef[1];

    function send(label) {
      setBusy(true); setErr('');
      Promise.resolve().then(function () {
        return api().label(v.id, label, note);
      }).then(function (res) {
        /* On the label route a 404 is also "no such card". */
        var msg = (res && res._notFound && res.status === 404)
          ? 'Card not found, or the decision loop is off.' : envelopeMessage(res);
        if (msg) { setErr(msg); return; }
        props.onLabelled(props.card, res && typeof res === 'object' ? res : {}, label, note);
      }).catch(function (e) {
        setErr((e && e.message) || 'Could not save the label.');
      }).then(function () { setBusy(false); });
    }

    var meta = [v.company, v.site].filter(Boolean).join(' · ');
    var tags = [v.rule, v.kind, v.purpose].filter(Boolean).join(' · ');

    return h('li', { className: 'fs-decision__card' + (v.label ? ' fs-decision__card--labelled' : '') },
      h('div', { className: 'fs-decision__card-head' },
        h('span', { className: 'fs-decision__where' }, meta || '—'),
        h('span', { className: 'fs-decision__rule' }, tags),
        v.urgency === 'injury' ? h('span', { className: 'fs-decision__urgent' }, 'Possible injury') : null,
        h('span', { className: 'fs-decision__when' }, v.created)),
      h('p', { className: 'fs-decision__question' }, v.question || '—'),
      v.consequence ? h('p', { className: 'fs-decision__consequence' }, v.consequence) : null,
      v.options.length ? h('ul', { className: 'fs-decision__options' },
        v.options.map(function (o) {
          return h('li', { key: o.id,
            className: 'fs-decision__option' + (o.recommended ? ' fs-decision__option--recommended' : '') },
            o.text,
            o.recommended ? h('span', { className: 'fs-decision__badge' }, 'Recommended') : null,
            o.reasonRequired ? h('span', { className: 'fs-decision__hint' }, 'reason required') : null);
        })) : null,
      v.evidence.length
        ? v.evidence.map(function (e, i) {
            return h('blockquote', { key: i, className: 'fs-decision__evidence' }, e.quote);
          })
        : h('p', { className: 'fs-decision__muted' }, 'No evidence quote.'),
      h('p', { className: 'fs-decision__recipients' },
        h('span', { className: 'fs-decision__muted' }, 'Would go to: '),
        v.recipients.length ? v.recipients.join(', ') : '—'),
      h('div', { className: 'fs-decision__label-row' },
        h('span', { className: 'fs-decision__current' },
          v.label ? 'Labelled: ' + LABEL_TEXT[v.label] : 'Not labelled'),
        ['needed', 'not_needed', 'wrong_evidence'].map(function (k) {
          return h('button', { key: k, type: 'button', disabled: busy,
            'aria-pressed': v.label === k,
            className: 'fs-decision__btn' + (v.label === k ? ' fs-decision__btn--on' : ''),
            onClick: function () { send(k); } }, LABEL_TEXT[k]);
        }),
        h('input', { type: 'text', className: 'fs-decision__note', placeholder: 'Note (optional)',
          'aria-label': 'Note', value: note, disabled: busy,
          onChange: function (e) { setNote(e.target.value); } })),
      err ? h('p', { className: 'fs-decision__error' }, err) : null);
  }

  function DecisionReviewMiddle() {
    var filterRef = React.useState('');
    var filter = filterRef[0]; var setFilter = filterRef[1];
    var offsetRef = React.useState(0);
    var offset = offsetRef[0]; var setOffset = offsetRef[1];
    var stRef = React.useState({ status: 'loading' });
    var st = stRef[0]; var setSt = stRef[1];

    React.useEffect(function () {
      var alive = true;
      setSt({ status: 'loading' });
      Promise.resolve().then(function () {
        return api().listShadow({ label: filter || undefined, limit: PAGE_SIZE, offset: offset });
      }).then(function (res) {
        if (!alive) return;
        var msg = envelopeMessage(res);
        if (msg) { setSt({ status: 'blocked', message: msg }); return; }
        setSt({ status: 'ok', cards: (res && Array.isArray(res.cards)) ? res.cards : [],
                summary: (res && res.summary) || {} });
      }).catch(function (e) {
        if (alive) setSt({ status: 'error', message: (e && e.message) || 'Could not load the cards.' });
      });
      return function () { alive = false; };
    }, [filter, offset]);

    function onLabelled(oldCard, newCard, label, note) {
      setSt(function (cur) {
        if (cur.status !== 'ok') return cur;
        var id = oldCard.card_id || oldCard.id;
        /* The route returns the card; if a field is missing, keep what we sent. */
        var merged = Object.assign({}, oldCard, newCard);
        if (!LABEL_TEXT[merged.shadow_label]) merged.shadow_label = label;
        if (merged.label_note === undefined || merged.label_note === null) merged.label_note = note;
        return Object.assign({}, cur, {
          cards: cur.cards.map(function (c) { return (c.card_id || c.id) === id ? merged : c; }),
          summary: applyLabelToSummary(cur.summary, oldCard.shadow_label, merged.shadow_label),
        });
      });
    }

    var body;
    if (st.status === 'loading') {
      body = h('p', { className: 'fs-decision__muted' }, 'Loading…');
    } else if (st.status === 'blocked' || st.status === 'error') {
      body = h('p', { className: st.status === 'blocked' ? 'fs-decision__muted' : 'fs-decision__error' },
        st.message);
    } else {
      body = h('div', null,
        h(SummaryLine, { summary: st.summary }),
        st.cards.length
          ? h('ul', { className: 'fs-decision__cards' }, st.cards.map(function (c, i) {
              return h(CardRow, { key: (c.card_id || c.id || i), card: c, onLabelled: onLabelled });
            }))
          : h('p', { className: 'fs-decision__muted' }, 'No cards.'),
        h('div', { className: 'fs-decision__pager' },
          h('button', { type: 'button', className: 'fs-decision__btn', disabled: offset === 0,
            onClick: function () { setOffset(Math.max(0, offset - PAGE_SIZE)); } }, 'Previous'),
          h('span', { className: 'fs-decision__muted' },
            st.cards.length ? (offset + 1) + '–' + (offset + st.cards.length) : ''),
          h('button', { type: 'button', className: 'fs-decision__btn',
            disabled: st.cards.length < PAGE_SIZE,
            onClick: function () { setOffset(offset + PAGE_SIZE); } }, 'Next')));
    }

    return h('div', { className: 'fs-page fs-decision' },
      h('div', { className: 'fs-decision__header' },
        h('h1', { className: 'fs-decision__title' }, 'Decision cards (shadow)'),
        h('label', { className: 'fs-decision__filter' }, 'Show ',
          h('select', { value: filter,
            onChange: function (e) { setOffset(0); setFilter(e.target.value); } },
            FILTERS.map(function (f) { return h('option', { key: f.value, value: f.value }, f.text); })))),
      h('p', { className: 'fs-decision__muted' },
        'Nothing is sent in this phase. Label each card so we can measure whether it was worth asking.'),
      body);
  }

  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.PAGES) window.FieldSight.PAGES = {};
  window.FieldSight.PAGES['/decision-review'] = {
    Middle: DecisionReviewMiddle,
    layout: 'full-width',
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      precisionText: precisionText, p95Text: p95Text, summaryParts: summaryParts,
      applyLabelToSummary: applyLabelToSummary, cardView: cardView,
      envelopeMessage: envelopeMessage, DecisionReviewMiddle: DecisionReviewMiddle,
      CardRow: CardRow, PAGE_SIZE: PAGE_SIZE,
    };
  }
})();
