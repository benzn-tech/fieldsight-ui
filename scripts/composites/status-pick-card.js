/* ==========================================================================
   FieldSight StatusPickCard — Layer 5 composite
   --------------------------------------------------------------------------
   A status heard in a recording that could belong to more than one open task
   (spec 2026-11-12 §4.3). The person picks which task it was:

     Which task was this?                                   Done · Hobson St
     “that one is done”
     ( ) #12  Send the RFI · Sarah
     ( ) Book the crane · Tom              not yours to change   (disabled)
     [Mark Done]  [None of these]

   Props:
     card    { id, site_name, status, quote, can_dismiss,
               candidates: [{ stable_id, action_item_id, text, responsible,
                              task_no, can_choose }] }
     onDone  (card, result) => void — called once the card is finished:
               result.ok           chose / answered none; the host patches the
                                   row (result.action_item_id, result.status)
               reason 'conflict' | 'not_found'
                                   someone else answered it, or it is gone;
                                   "Already handled" shows for a moment first

   Any other failure (a refusal, a network error) stays inline and keeps the
   card, so the person can see why and try again.

   The quote is a person's speech: it is only ever a React text child.

   Exported to:
     window.FieldSight.StatusPickCard
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var HANDLED_MS = 1500;

  /* The chip's own label map (action-item-row.js), never a copy. An unknown
     status still shows its raw value: the card still needs an answer. */
  function statusLabel(status) {
    var fn = window.FieldSight && window.FieldSight.suggestionLabel;
    return (fn && fn({ status: status })) || status || '';
  }

  function StatusPickCard(props) {
    var card = props.card || {};
    var candidates = card.candidates || [];

    var selRef = React.useState(null);
    var selected = selRef[0], setSelected = selRef[1];
    var busyRef = React.useState(false);
    var busy = busyRef[0], setBusy = busyRef[1];
    var errRef = React.useState(null);
    var error = errRef[0], setError = errRef[1];
    var handledRef = React.useState(false);
    var handled = handledRef[0], setHandled = handledRef[1];

    var h = React.createElement;
    var label = statusLabel(card.status);

    if (handled) {
      return h('div', { className: 'fs-pick-card fs-pick-card--handled', role: 'status' },
        'Already handled');
    }

    var chosen = candidates.filter(function (c) {
      return c.stable_id === selected && c.can_choose;
    })[0];

    function decide(body, e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      if (busy) return;
      setBusy(true);
      setError(null);
      window.FS.api.actions.decidePickCard(card.id, body).then(function (env) {
        if (env && env.ok) {
          if (props.onDone) props.onDone(card, env);
          return;
        }
        if (env && (env.reason === 'conflict' || env.reason === 'not_found')) {
          setHandled(true);
          var later = window.setTimeout || setTimeout;
          later(function () { if (props.onDone) props.onDone(card, env); }, HANDLED_MS);
          return;
        }
        setBusy(false);
        setError((env && env.message) || 'Could not save this.');
      });
    }

    var groupName = 'fs-pick-card-' + card.id;

    return h('section', { className: 'fs-pick-card', 'aria-label': 'Which task was this?' },
      h('div', { className: 'fs-pick-card__head' },
        h('h3', { className: 'fs-pick-card__title' }, 'Which task was this?'),
        h('span', { className: 'fs-pick-card__meta' },
          label + (card.site_name ? ' · ' + card.site_name : ''))),
      card.quote ? h('q', { className: 'fs-pick-card__quote' }, card.quote) : null,
      h('div', { className: 'fs-pick-card__options', role: 'radiogroup',
                 'aria-label': 'Tasks this could be' },
        candidates.map(function (c) {
          var off = !c.can_choose;
          return h('label', {
            key: c.stable_id,
            className: 'fs-pick-card__option' + (off ? ' fs-pick-card__option--disabled' : ''),
          },
            h('input', {
              type: 'radio', name: groupName, value: c.stable_id,
              checked: selected === c.stable_id,
              disabled: off || busy,
              onChange: function () { setSelected(c.stable_id); },
            }),
            c.task_no !== null && c.task_no !== undefined
              ? h('span', { className: 'fs-pick-card__no' }, '#' + c.task_no) : null,
            h('span', { className: 'fs-pick-card__text' }, c.text || ''),
            c.responsible ? h('span', { className: 'fs-pick-card__who' }, c.responsible) : null,
            off ? h('span', { className: 'fs-pick-card__note' }, 'not yours to change') : null);
        })),
      error ? h('div', { className: 'fs-pick-card__error', role: 'alert' }, error) : null,
      h('div', { className: 'fs-pick-card__actions' },
        h('button', {
          type: 'button', className: 'fs-pick-card__btn fs-pick-card__btn--primary',
          disabled: busy || !chosen,
          onClick: function (e) { decide({ decision: 'choose', stable_id: chosen && chosen.stable_id }, e); },
        }, 'Mark ' + label),
        card.can_dismiss
          ? h('button', {
              type: 'button', className: 'fs-pick-card__btn',
              disabled: busy,
              onClick: function (e) { decide({ decision: 'none' }, e); },
            }, 'None of these')
          : null));
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.StatusPickCard = StatusPickCard;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { StatusPickCard: StatusPickCard, statusLabel: statusLabel };
  }
})();
