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
     • clicking it persists optimistically and transitions the row
       through:
            border pulse → line-through → fade-out
       The animation respects prefers-reduced-motion via the global
       media query in tokens.css (which neutralises animation duration).
     • onAnimationEnd → onCheckedOff(task) so the parent can drop the
       row from its rendered list.
     • feat/checkoff-org-api — the persistence call is now the single
       shared FS.api.actions.resolveActionItem(), which routes to the
       AUTHORISED Aurora write (PATCH /api/org/action-items/{id}) when
       the item carries a durable actionItemId and the aurora gate is
       on, and falls back to the legacy unauthenticated DynamoDB toggle
       otherwise. It ALWAYS RESOLVES {ok:true|false, reason, message} —
       previously this card only had a `.catch()`, so a 403 (which
       updateAction RESOLVES as {_accessDenied}) played the fade-out
       animation and dropped the row as if the write had succeeded.
       A refusal now aborts the animation and toasts the server's own
       reason.

   Props:
     task           { id, title, assignee, status, statusTone, dueTime,
                      topic_id, actionIndex, folder, work_class, ... } —
                      `folder` is the report OWNER's folder (feat/user-dim-
                      audit-key, Task 6; stamped by today-adapter.js), sent
                      as `user_folder` on the toggleAction call below so
                      the audit check-off is keyed per-user, never the
                      caller/currentUser. `work_class` — Q1 (tier-aware
                      Today/Tasks) — the parent topic's work_class,
                      verbatim off today-adapter.js/tasks-aggregator.js;
                      `=== 'non_work'` renders a "Possibly personal" badge
                      (missing/other value == treat as work, never a
                      `!== 'work'` check — same convention those adapters
                      follow). No review controls here (see timeline.js
                      for those) — purely informational.
     isMine         boolean — apply --mine accent border
     onSelect       (task) => void — click handler on the row body
     checkable      boolean — show check button instead of avatar
     date           'YYYY-MM-DD' — passed to FS.api.actions.resolveActionItem
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
     timeRange      string, optional (§E-time) — the parent topic's
                    time_range, e.g. '14:09 – 14:09'. feat/editable-tasks-ui
                    (concise-cards) — no longer rendered on the card itself;
                    moved to the right detail panel's "Time" row (today.js
                    TodayRightDetail reads item.timeRange directly, since
                    the selected item IS the same task object this prop is
                    sourced from). Prop is still accepted/passed by callers
                    — left as a no-op here rather than stripped from every
                    call site.
     noDeadline     boolean, optional (feat/today-rolling-open-items) —
                    renders a subtle "No due date" chip (warning tone,
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

      /* feat/checkoff-org-api — one routed, always-resolving call. This
         card only ever CHECKS (the row fades out and onAnimationEnd drops
         it from the parent's list; there is no uncheck affordance here),
         so checked is hard-coded true. user_folder is the report OWNER's
         folder (feat/user-dim-audit-key, Task 6 — task.folder, stamped by
         today-adapter.js), never the caller/currentUser; it is only used
         by the legacy fallback leg. */
      api.resolveActionItem({
        actionItemId: task.actionItemId,
        date:         props.date,
        topic_id:     task.topic_id,
        action_index: task.actionIndex,
        checked:      true,
        action_text:  task.title,
        user_folder:  task.folder,
      }).then(function (res) {
        if (res && res.ok) return;   /* animation continues → onCheckedOff */
        /* Refused (403 assignee/site-authority gate, 404 gone) or failed —
           abort the animation, keep the row, and TELL the user why. Never
           a silent revert: this is the check that decides whether someone
           else's task may be resolved. */
        console.error('[TaskCard] check-off refused', res);
        setCheckingOff(false);
        var toast = window.FS && window.FS.toast;
        if (toast) {
          toast.show({
            message:  (res && res.message) || 'Could not check off this task.',
            tone:     'error',
            duration: 5000,
          });
        }
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
            }, 'No due date') : null,
            /* Q1 — tier-aware Today/Tasks: informational only, no review
               controls (those stay on Timeline). `=== 'non_work'` (never
               `!== 'work'`) so a missing/other value still counts as
               work. */
            task.work_class === 'non_work' ? React.createElement(Badge, {
              tone: 'neutral', variant: 'outline', size: 'sm',
            }, 'Possibly personal') : null,
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
