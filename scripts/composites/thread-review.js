/* ==========================================================================
   FieldSight ThreadReview — Layer 5 composite
   --------------------------------------------------------------------------
   The review queue for recurring-item threading (spec
   docs/superpowers/specs/2026-08-05-recurring-item-threading-design.md).

   A commitment made on site is restated on later days. The matcher proposes
   which earlier SUBJECT a new topic is a restatement of; confirming is what
   actually links them, and it is a person's call — a wrong link silently
   closes or escalates the wrong work and nobody finds out.

   So the card's job is not to report a score. It is to let someone answer
   ONE question — "is this the same job?" — which means both titles and both
   dates have to be readable side by side without opening anything. The score
   is shown, quietly, because it is the reason the question is being asked;
   it is not the thing being decided.

   Controlled list, like SuggestionReview: the CALLER owns fetching and holds
   the rows, so a page badge and this queue read one source of truth. This
   component owns per-card mutation state and calls confirm/reject directly,
   then tells the caller to drop the row.

   Props:
     suggestions  rows from org.getThreadSuggestions() — required
     onResolved   (id) => void, after a successful confirm/reject
     emptyText    optional override for the empty state

   Exported to window.FieldSight.ThreadReview
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  /* Splitting on '-' and checking only the PART COUNT is not enough:
     'not-a-date' has three parts and renders as "NaN undefined NaN". Anything
     that is not a real date falls through unchanged, so a reader sees the raw
     value rather than a plausible-looking wrong one. */
  function fmtDate(iso) {
    if (!iso) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
    if (!m) return iso;
    var mon = Number(m[2]);
    if (mon < 1 || mon > 12) return iso;
    var names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return Number(m[3]) + ' ' + names[mon - 1] + ' ' + m[1];
  }

  /* How long the subject went unmentioned. The gap is the strongest signal a
     reader has for "same job?" that the score cannot give them: four days is
     an ordinary follow-up, five weeks is worth a second look. */
  function fmtGap(days) {
    var n = Number(days);
    if (!isFinite(n) || n <= 0) return '';
    if (n === 1) return '1 day later';
    if (n < 14) return n + ' days later';
    var w = Math.round(n / 7);
    return w + ' weeks later';
  }

  function errorMessage(errOrRes, fallback) {
    if (!errOrRes) return fallback;
    if (errOrRes.body && errOrRes.body.error) return errOrRes.body.error;
    if (errOrRes.error) return errOrRes.error;
    if (errOrRes.message) return errOrRes.message;
    return fallback;
  }

  function ThreadCard(props) {
    var fs = window.FieldSight;
    var Button = fs.Button;
    var Badge = fs.Badge;
    var ErrorBanner = fs.ErrorBanner;
    var h = React.createElement;

    var row = props.row;
    var onResolved = props.onResolved || function () {};

    var s_busy = React.useState(null);          /* null | 'confirm' | 'reject' */
    var busy = s_busy[0], setBusy = s_busy[1];
    var s_err = React.useState(null);
    var err = s_err[0], setErr = s_err[1];

    function act(kind) {
      var org = ((window.FS || {}).api || {}).org || {};
      var call = kind === 'confirm' ? org.confirmThreadSuggestion
                                    : org.rejectThreadSuggestion;
      if (!call) { setErr('This build cannot decide suggestions.'); return; }
      setBusy(kind); setErr(null);
      Promise.resolve(call(row.id)).then(function (res) {
        /* 403/404 resolve rather than reject (_fetch.js), and the offline
           mock resolves {_notAvailable}. None of those are a decision, so
           none of them may drop the row — a card that vanishes without the
           link being made is the worst outcome here: the reviewer believes
           they answered. */
        if (!res || res._accessDenied || res._notFound || res._notAvailable) {
          setBusy(null);
          setErr(errorMessage(res, 'That could not be saved. Nothing was changed.'));
          return;
        }
        onResolved(row.id);
      }).catch(function (e) {
        setBusy(null);
        setErr(errorMessage(e, e && e.status === 409
          ? 'Someone else already answered this one.'
          : 'That could not be saved. Nothing was changed.'));
      });
    }

    /* The earlier side: an existing thread if the parent already has one,
       otherwise the parent topic itself. Both read the same to the reviewer —
       "the thing this might belong to" — so they render identically. */
    var earlierTitle = row.threadTitle || row.parentTitle || '—';
    var earlierDate = row.parentDate;

    return h('li', { className: 'fs-thread-review__item' },
      h('div', { className: 'fs-thread-review__pair' },
        h('div', { className: 'fs-thread-review__side' },
          h('div', { className: 'fs-thread-review__when' },
            fmtDate(earlierDate),
            row.threadId
              ? h(Badge, { tone: 'info', variant: 'subtle', size: 'sm' }, 'existing thread')
              : null),
          h('div', { className: 'fs-thread-review__title' }, earlierTitle)),
        h('div', { className: 'fs-thread-review__arrow', 'aria-hidden': 'true' }, '↓'),
        h('div', { className: 'fs-thread-review__side' },
          h('div', { className: 'fs-thread-review__when' },
            fmtDate(row.topicDate),
            h('span', { className: 'fs-thread-review__gap' }, fmtGap(row.gapDays))),
          h('div', { className: 'fs-thread-review__title' }, row.topicTitle))),

      err ? h(ErrorBanner, { message: err, onDismiss: function () { setErr(null); } }) : null,

      h('div', { className: 'fs-thread-review__actions' },
        h('span', { className: 'fs-thread-review__score', title: 'How closely the wording matches' },
          'match ' + Math.round((Number(row.score) || 0) * 100) + '%'),
        h(Button, {
          variant: 'secondary', size: 'sm', disabled: !!busy,
          onClick: function () { act('reject'); },
        }, busy === 'reject' ? 'Saving…' : 'Not the same'),
        h(Button, {
          variant: 'primary', size: 'sm', disabled: !!busy,
          onClick: function () { act('confirm'); },
        }, busy === 'confirm' ? 'Saving…' : 'Same job')));
  }

  function ThreadReview(props) {
    var h = React.createElement;
    var rows = props.suggestions || [];
    if (!rows.length) {
      return h('p', { className: 'fs-thread-review__empty' },
        props.emptyText || 'Nothing to review — no repeated subjects found.');
    }
    return h('ul', { className: 'fs-thread-review' },
      rows.map(function (r) {
        return h(ThreadCard, { key: r.id, row: r, onResolved: props.onResolved });
      }));
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.ThreadReview = ThreadReview;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { fmtGap: fmtGap, fmtDate: fmtDate, errorMessage: errorMessage };
  }
})();
