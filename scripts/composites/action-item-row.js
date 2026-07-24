/* ==========================================================================
   FieldSight ActionItemRow — Layer 5 composite
   --------------------------------------------------------------------------
   One row in a topic's action_items list. Renders:
     [checkbox] action text · responsible · deadline · priority pill

   The checkbox state is keyed by `${userFolder}|${topic_id}_${action_index}`
   (bare `${topic_id}_${action_index}` when userFolder is falsy — legacy
   fallback; BACKEND-CONTEXT §4.10 / §8.8, user-dimension audit key plan
   §1.3). On change we do an OPTIMISTIC update: flip local state
   immediately, fire FS.api.actions.resolveActionItem, and revert (with a
   toast carrying the server's own reason) if it comes back not-ok.

   feat/checkoff-org-api — resolveActionItem routes the write to the
   AUTHORISED PATCH /api/org/action-items/{id} (ACL: admin/gm, THIS site's
   pm/site_manager, or the assignee) whenever the item carries a durable
   action_items.id and the aurora gate is on, and only falls back to the
   legacy UNAUTHENTICATED POST /api/actions/toggle otherwise. The composite
   key above therefore describes the FALLBACK/read overlay, not the primary
   write path any more.

   Note BUG §8.8: topic_ids may shift if the report is regenerated, which
   can "move" a checkmark. Accepted risk for now; hard audit goes through
   the actions history endpoint.

   Props:
     date          'YYYY-MM-DD'
     topicId       number
     actionIndex   number
     userFolder    string (optional) — report OWNER's folder (never the
                   caller/current user). Threads into the bus identity key
                   and toggleAction's user_folder so same-day, same-index
                   actions from different report owners don't collide.
                   Missing/falsy → legacy bare-key behaviour (tolerated;
                   see docs/superpowers/plans/2026-07-13-user-dimension-audit-key.md).
     action        { action, responsible, deadline, priority }
     initialChecked  boolean
     checkedBy     string (optional, shown as caption when checked)
     checkedAt     ISO   (optional)
     onToggled     ({ checked }) => void  — optional listener

   Exported to:
     window.FieldSight.ActionItemRow
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var PRIORITY_TONE = { high: 'danger', medium: 'warning', low: 'info' };

  /* feat/editable-tasks-ui follow-up (F3) — true when the authoritative
     action_items.status column (stamped onto props.action as `.status`
     by the Aurora /timeline read shim, render_report_shape) says this
     item is done. Used to widen the checkbox's checked state beyond the
     legacy DynamoDB overlay (props.initialChecked) so a task completed
     on Today (column write, overlay never touched) still shows checked
     here. */
  function isColumnDone(props) {
    return !!(props.action && props.action.status === 'done');
  }

  /* Format ISO timestamp → "3 May, 2:14 pm" in NZ time. Returns '' on
     missing or unparseable input. Used to show when an action was
     ticked, as a small audit trail next to "Checked by …". */
  function fmtCheckedAt(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleString('en-NZ', {
        day: 'numeric', month: 'short',
        hour: 'numeric', minute: '2-digit',
        hour12: true,
        timeZone: 'Pacific/Auckland',
      });
    } catch (_) {
      return '';
    }
  }

  function ActionItemRow(props) {
    var Badge   = window.FieldSight.Badge;
    var date          = props.date;
    var topicId       = props.topicId;
    var actionIndex   = props.actionIndex;
    var userFolder    = props.userFolder;  /* report OWNER's folder — never the caller */
    var action        = props.action || {};
    var checkedBy     = props.checkedBy;
    var checkedAt     = props.checkedAt;

    var ref = React.useState(!!props.initialChecked || isColumnDone(props));
    var checked    = ref[0];
    var setChecked = ref[1];

    var pendingRef  = React.useRef(false);

    /* Sprint 6.7.1 — sync local checked state when initialChecked
       prop changes (e.g., parent state was updated by a sibling
       ActionItemRow's toggle). Skip while a request is in flight to
       avoid clobbering an optimistic update.
       feat/editable-tasks-ui follow-up (F3) — also re-sync when the
       authoritative column status flips (isColumnDone), so a re-render
       carrying a freshly-'done' action.status keeps the box checked
       even when the legacy overlay was never written. */
    React.useEffect(function () {
      if (pendingRef.current) return;
      setChecked(!!props.initialChecked || isColumnDone(props));
    }, [props.initialChecked, props.action && props.action.status]);

    /* Sprint 6.7.1 — listen for cross-component toggles via the bus.
       When ANOTHER ActionItemRow with the same key successfully
       toggles, sync our state to match. The bus emits server-truth
       (post-API success) so this also corrects any drift. */
    React.useEffect(function () {
      var bus = window.FS && window.FS.actionsBus;
      if (!bus) return undefined;
      var myKey = date + '|' + (userFolder || '') + '|' + topicId + '_' + actionIndex;
      return bus.subscribe(function (payload) {
        if (!payload) return;
        var theirKey = payload.date + '|' + (payload.user_folder || '') + '|' + payload.topic_id + '_' + payload.action_index;
        if (theirKey !== myKey) return;
        if (pendingRef.current) return;
        setChecked(!!payload.checked);
      });
    }, [date, topicId, actionIndex, userFolder]);

    function onChange(e) {
      if (pendingRef.current) return;
      var next = !!e.target.checked;
      var prev = checked;
      setChecked(next);                          /* optimistic */
      pendingRef.current = true;

      var api = window.FS && window.FS.api && window.FS.api.actions;
      /* feat/checkoff-org-api — one routed, ALWAYS-RESOLVING call
         (FS.api.actions.resolveActionItem): the AUTHORISED Aurora write
         (PATCH /api/org/action-items/{id}) when the item carries a durable
         action_items.id and the aurora gate is on, else the legacy
         unauthenticated DynamoDB overlay toggle. Unlike the Today card
         (check-only) this row IS uncheck-capable, so `checked` is the real
         next value — and resolveActionItem's org leg additionally clears
         the legacy overlay on an uncheck, without which an item whose
         done-ness came from DynamoDB simply re-checked itself on the next
         load (both readers union the two stores — see isColumnDone above).
         It also emits the actionsBus event on every successful path, so
         this handler no longer broadcasts itself. */
      var p = (api && api.resolveActionItem)
        ? api.resolveActionItem({
            actionItemId: action.id,
            date:         date,
            topic_id:     topicId,
            action_index: actionIndex,
            checked:      next,
            action_text:  action.action,
            user_folder:  userFolder,
          })
        : Promise.resolve({ ok: true });

      p.then(function (env) {
        pendingRef.current = false;
        /* Refused (403 — admin/gm, this site's pm/site_manager, or the
           assignee only) or failed. Revert the optimistic check and TELL
           the user why: resolveActionItem RESOLVES these rather than
           rejecting, precisely so a `.catch()` can't swallow a denial into
           a silent revert (the recurring bug in this codebase). */
        if (!env || !env.ok) {
          console.error('[ActionItemRow] toggle refused, reverting', env);
          setChecked(prev);
          var toast = window.FS && window.FS.toast;
          if (toast) {
            toast.show({
              message:  (env && env.message) || 'Could not update this action item.',
              tone:     'error',
              duration: 5000,
            });
          }
          return;
        }
        /* Sprint 8.5.4 — announce to screen readers via the global
           polite live region. Skip when the toggle came from a sibling
           bus event (no UI interaction → no announce needed). */
        var region = document.getElementById('fs-live-region');
        if (region) {
          region.textContent = next ? 'Marked complete' : 'Marked incomplete';
        }
        if (props.onToggled) props.onToggled({ checked: next });
      });
    }

    var priority = (action.priority || '').toLowerCase();
    var priorityTone = PRIORITY_TONE[priority] || 'neutral';

    /* fix/timeline-buttons-and-deadline — resolve the free-text deadline
       to an absolute date relative to THIS topic's own report date (the
       `date` prop, same value TopicCard/OverviewTab pass to
       FS.api.actions.resolveActionItem above). Falls back to the raw text
       when resolveDeadline can't confidently parse it, or when the
       resolver isn't loaded yet — never shows a wrong date. */
    var deadlineDisplay = action.deadline
      ? (window.FS && window.FS.api && window.FS.api.resolveDeadline
          ? window.FS.api.resolveDeadline(action.deadline, date).display
          : action.deadline)
      : null;

    var className = 'fs-action-item-row' + (checked ? ' fs-action-item-row--checked' : '');

    return React.createElement('label', { className: className },
      React.createElement('input', {
        type:      'checkbox',
        className: 'fs-action-item-row__checkbox',
        checked:   checked,
        onChange:  onChange,
        'aria-label': action.action,
      }),
      React.createElement('div', { className: 'fs-action-item-row__main' },
        React.createElement('div', { className: 'fs-action-item-row__text' },
          action.action),
        React.createElement('div', { className: 'fs-action-item-row__meta' },
          action.responsible
            ? React.createElement('span', { className: 'fs-action-item-row__meta-item' },
                action.responsible)
            : null,
          deadlineDisplay
            ? React.createElement('span', { className: 'fs-action-item-row__meta-item' },
                'Due ' + deadlineDisplay)
            : null,
          checked && checkedBy
            ? React.createElement('span', {
                className: 'fs-action-item-row__meta-item fs-action-item-row__meta-item--audit',
                title:     checkedAt ? new Date(checkedAt).toString() : undefined,
              },
                'Checked by ' + checkedBy
                  + (fmtCheckedAt(checkedAt) ? ' · ' + fmtCheckedAt(checkedAt) : ''))
            : null,
        ),
      ),
      action.priority
        ? React.createElement(Badge, {
            tone:    priorityTone,
            size:    'sm',
            variant: 'outline',
            className: 'fs-action-item-row__priority',
          }, action.priority.charAt(0).toUpperCase() + action.priority.slice(1))
        : null,
    );
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.ActionItemRow = ActionItemRow;
})();
