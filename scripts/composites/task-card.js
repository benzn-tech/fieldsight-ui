/* ==========================================================================
   FieldSight TaskCard — Layer 5 composite
   --------------------------------------------------------------------------
   Renders a task as a clickable Card row: avatar (or check button) +
   2-line title + status badge + due time. The `isMine` modifier
   strengthens the left edge with an accent border so a user's own
   tasks stand out when mixed with the team's.

   Sprint 2.4 (PLAN Phase D) adds optional check-off:
     • when `checkable` is true and the task carries topic_id +
       actionIndex, the avatar slot becomes a circular checkbox
     • clicking it fires FS.api.actions.toggleAction (optimistic) and
       transitions the row through:
            border pulse → line-through → fade-out
       The animation respects prefers-reduced-motion via the global
       media query in tokens.css (which neutralises animation duration).
     • onAnimationEnd → onCheckedOff(task) so the parent can drop the
       row from its rendered list.

   Props:
     task           { id, title, assignee, status, statusTone, dueTime,
                      topic_id, actionIndex, folder, ... } — `folder` is
                      the report OWNER's folder (feat/user-dim-audit-key,
                      Task 6; stamped by today-adapter.js), sent as
                      `user_folder` on the toggleAction call below so the
                      audit check-off is keyed per-user, never the
                      caller/currentUser.
     isMine         boolean — apply --mine accent border
     onSelect       (task) => void — click handler on the row body
     checkable      boolean — show check button instead of avatar
     date           'YYYY-MM-DD' — passed to FS.api.actions.toggleAction
     onCheckedOff   (task) => void — called once the fade-out finishes
     site           string, optional (feat/today-by-project) — project
                    display name. Renders as a small chip in the meta
                    row so a single-project caller can still tell which
                    project a task belongs to. Omitted/falsy → the meta
                    row is byte-identical to before this prop existed.
     ageLabel       string, optional (feat/today-rolling-open-items) —
                    e.g. 'Today' / '3d ago'. How long this item has been
                    open, for the Today rolling list where cards mix
                    origin dates. Omitted/falsy → no age text rendered.
     noDeadline     boolean, optional (feat/today-rolling-open-items) —
                    renders a subtle "No deadline" chip (warning tone,
                    never safety-red/blocked-magenta per CLAUDE.md).
     batchMode      boolean, optional (feat/leftover-batch-select, T1) —
                    when true AND `checkable` is true, the SAME round
                    check-off button doubles as a multi-select toggle
                    instead of resolving immediately: its onClick calls
                    `onBatchToggle(task, evt)` rather than the single-
                    resolve `startCheckOff`. Omitted/falsy → the round
                    button keeps its original single-resolve behavior,
                    byte-identical to before this prop existed (Recent
                    cards + timeline usages never pass it).
     batchSelected  boolean, optional — paints the round button with a
                    `--selected` modifier when true. Only meaningful
                    when `batchMode` is true. NOT the same prop as
                    `selected` above (that one drives the right-panel
                    "currently open" highlight) — deliberately a
                    different name to avoid colliding with it.
     onBatchToggle  (task, evt) => void, optional — fired on round-button
                    click when `batchMode` is true, INSTEAD of
                    `startCheckOff`. `evt` is passed through so the
                    caller can branch on evt.shiftKey (range-select) /
                    evt.ctrlKey / evt.metaKey (toggle-only). Click on the
                    button stops propagation so it never also triggers
                    the row's onSelect (open detail).

   Exported to:
     window.FieldSight.TaskCard
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  function TaskCard(props) {
    var Card    = window.FieldSight.Card;
    var Avatar  = window.FieldSight.Avatar;
    var Badge   = window.FieldSight.Badge;
    var NavIcon = window.FieldSight.NavIcon;

    var task     = props.task;
    var isMine   = !!props.isMine;
    var onSelect = props.onSelect;
    var checkable = !!props.checkable && task && task.topic_id != null && task.actionIndex != null;
    /* feat/leftover-batch-select (T1) — additive, no-op when `batchMode`
       is omitted/falsy (see prop-trio doc in the file header above). */
    var batchMode = !!props.batchMode;

    /* checkingOff: true → row enters animation. Stays true until
       onAnimationEnd; the parent's onCheckedOff then unmounts us. */
    var refCO = React.useState(false);
    var checkingOff    = refCO[0];
    var setCheckingOff = refCO[1];

    function startCheckOff(e) {
      if (e) { e.stopPropagation(); e.preventDefault(); }
      if (checkingOff) return;
      setCheckingOff(true);

      /* Sprint 8.5.4 — announce to the global polite live region. */
      var region = document.getElementById('fs-live-region');
      if (region) region.textContent = 'Marked complete';

      var api = window.FS && window.FS.api && window.FS.api.actions;
      if (!api) return;

      api.toggleAction({
        date:         props.date,
        topic_id:     task.topic_id,
        action_index: task.actionIndex,
        checked:      true,
        action_text:  task.title,
        /* feat/user-dim-audit-key (Task 6) — report OWNER's folder
           (task.folder, stamped by today-adapter.js), never the
           caller/currentUser. */
        user_folder:  task.folder,
      }).catch(function (err) {
        /* If the persist call fails, abort the animation and let the
           user retry. */
        console.error('[TaskCard] toggleAction failed', err);
        setCheckingOff(false);
      });
    }

    function onAnimationEnd() {
      if (checkingOff && props.onCheckedOff) props.onCheckedOff(task);
    }

    /* feat/leftover-batch-select (T1) — the round button's single onClick
       dispatcher. batchMode off (default): unchanged single-resolve path
       (startCheckOff). batchMode on: hands the raw click event up to
       the caller's onBatchToggle so it can branch on shiftKey (range-
       select) / ctrlKey / metaKey (toggle-only) / plain (toggle + new
       anchor) — see today.js onBatchToggle. Selecting never resolves,
       so stopPropagation/preventDefault still apply (keeps the row's
       onSelect from also firing) but toggleAction is never called here. */
    function handleCheckClick(e) {
      if (batchMode) {
        if (e) { e.stopPropagation(); e.preventDefault(); }
        if (props.onBatchToggle) props.onBatchToggle(task, e);
        return;
      }
      startCheckOff(e);
    }

    var className = 'fs-task-card'
      + (isMine ? ' fs-task-card--mine' : '')
      + (props.selected ? ' fs-card--selected' : '')
      + (checkingOff ? ' fs-task-card--checking-off' : '');

    /* Leading slot: avatar by default, circular check button when
       checkable. The button sits on top of the row click handler
       — internal stopPropagation prevents the row's onSelect from
       firing on check. feat/leftover-batch-select (T1) — when
       `batchMode` is on, the SAME button doubles as a multi-select
       toggle (handleCheckClick branches instead of a second element);
       `--selected` paints a filled ring when `batchSelected` is true. */
    var checkSelected = batchMode && !!props.batchSelected;
    var leading = checkable
      ? React.createElement('button', {
          type:        'button',
          className:   'fs-task-card__check'
            + (checkSelected ? ' fs-task-card__check--selected' : ''),
          onClick:     handleCheckClick,
          'aria-label': batchMode
            ? ((checkSelected ? 'Deselect "' : 'Select "') + (task.title || 'task') + '" for batch resolve')
            : 'Mark task complete',
          'aria-pressed': batchMode ? checkSelected : checkingOff,
          disabled:    !batchMode && checkingOff,
        },
          NavIcon ? React.createElement(NavIcon, {
            name: 'check', size: 14,
          }) : '✓',
        )
      : React.createElement(Avatar, { name: task.assignee, size: 'sm' });

    return React.createElement(Card, {
      padding:   'sm',
      onClick:   onSelect && !checkingOff ? function () { onSelect(task); } : undefined,
      className: className,
    },
      React.createElement(Card.Body, {
        onAnimationEnd: onAnimationEnd,
      },
        React.createElement('div', { className: 'fs-task-card__row' },
          leading,
          React.createElement('div', { className: 'fs-task-card__main' },
            React.createElement('div', { className: 'fs-task-card__title' },
              task.title),
          ),
          React.createElement('div', { className: 'fs-task-card__meta' },
            props.site ? React.createElement('span', {
              className: 'fs-task-card__site',
              title:     props.site,
            }, props.site) : null,
            /* feat/today-rolling-open-items — age + no-deadline signals.
               Both optional; omitted/falsy on any caller that doesn't
               pass them → meta row is byte-identical to before. */
            props.ageLabel ? React.createElement('span', {
              className: 'fs-task-card__age',
            }, props.ageLabel) : null,
            props.noDeadline ? React.createElement(Badge, {
              tone: 'warning', variant: 'outline', size: 'sm',
            }, 'No deadline') : null,
            React.createElement(Badge, { tone: task.statusTone, size: 'sm' },
              task.status),
            React.createElement('span', { className: 'fs-task-card__due' },
              task.dueTime),
          ),
        ),
      ),
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.TaskCard = TaskCard;
})();
