/* ==========================================================================
   FieldSight Tasks Page — Sprint 4.2 (PLAN.md Q-1 = yes)
   --------------------------------------------------------------------------
   /tasks — cross-day action-item dashboard.

   PLAN.md Q-1 commitment: frontend fan-out via the new
   `FS.api.tasks.getActionsResolvedRange` aggregator (Sprint 4.2).
   Backend endpoint `/api/actions/all?from=&to=&user=` is a
   nice-to-have; the aggregator is designed so a future drop-in
   replacement preserves the same row contract.

   Middle column:
     • Header: "Tasks" + perf caveat ("Aggregating last 14 days —
       slow at scale until backend aggregator ships")
     • TasksFilterChips: All / Mine / Open / Overdue / Done with counts
     • Filtered list (TaskCard rows). Worker role: "Mine" pre-selected.

   Right detail:
     • Action detail (text, owner, deadline, priority, source topic)
     • Audit history (checked_by, checked_at)
     • Mark complete CTA — wires through FS.api.actions.resolveActionItem
       (feat/checkoff-org-api: the AUTHORISED PATCH /api/org/action-items/
       {id} when the row carries a durable actionItemId, else the legacy
       toggle; reuses Sprint 2.4 P-04 optimistic flow; on success removes
       the row from the page snapshot via TasksContext.removeRow, on a
       refusal keeps the panel open and toasts the server's reason)

   Architecture:
     • TasksProvider owns state via TasksContext (Sprint 3 P-07
       page-Provider pattern, mirrors Today/Sites/Activity).
     • Default range: last 14 days (matches PLAN.md Sprint 4.2 plan).

   Registers as window.FieldSight.PAGES['/tasks']
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var PAGE_SIZE    = 25;

  /* ---------- Helpers --------------------------------------------------- */

  function readRouteParams() {
    var r = window.FS && window.FS.Router && window.FS.Router.getCurrentRoute();
    return (r && r.params) || {};
  }

  function fmtDate(yyyymmdd) {
    if (!yyyymmdd) return '';
    var p = String(yyyymmdd).split('-').map(Number);
    if (p.length !== 3) return yyyymmdd;
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return p[2] + ' ' + months[p[1] - 1] + ' ' + p[0];
  }

  function fmtTimestamp(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }

  /* Overdue check resolves the free-text deadline against the report's own
     date via the shared resolveDeadline helper (today-adapter.js) — the
     same helper Today + Timeline use for absolute due dates. Unparseable
     deadlines (absolute: null) never count as overdue. */
  /* feat/checkoff-org-api — done-ness is the UNION of the two stores a row
     carries: the authoritative Aurora column (`row.status`, threaded raw by
     tasks-aggregator.js) and the legacy DynamoDB overlay boolean
     (`row.audit.checked`). This page previously read ONLY the overlay for
     bucketing, badges and the check-off affordance while its own Status
     editor wrote ONLY the column — so a task set to Done in the editor
     stayed in the Open bucket with an "Open" badge and a live check-off
     circle, and the two could contradict each other on screen. The union is
     the same rule already shipped in today.js's keep() and
     action-item-row.js's isColumnDone, and it is what makes the move to the
     authorised PATCH non-regressive: ~119 action-item check-offs still live
     only in DynamoDB (their Aurora rows are status='open', the NOT NULL
     DEFAULT), and they keep reading as Done. */
  function isRowDone(row) {
    if (!row) return false;
    return window.FS.api.actions.isActionResolved(row.status, row.audit && row.audit.checked);
  }

  function isOverdue(row, today) {
    if (!row || isRowDone(row)) return false;
    var iso = window.FS.api.resolveDeadline(row.deadline, row.date).absolute;
    if (!iso) return false;
    return iso < today;
  }

  /* Q1 — tier-aware Today/Tasks. Filter-chip buckets, extracted to a pure
     function so both TasksMiddleColumn (below) and its unit tests can
     share one implementation. A `work_class === 'non_work'` row stays in
     `all`/`mine`/`done` (still rendered, still countable there) but is
     excluded from `open`/`overdue` — those two counts (and filter views)
     drive the "N unresolved" impression the chip badges give, and a
     personal item shouldn't inflate that. Redacted rows never reach here
     at all — tasks-aggregator.js omits them before this function ever
     sees the row. Only the literal 'non_work' is excluded — missing/other
     values (undefined, 'work') count as work, matching the `!== 'work'`-
     avoiding convention the aggregator itself follows.

     fix/mine-team-attribution — the `mine` bucket now goes through the
     SHARED FS.api.isMineTask predicate (scripts/api/mine-team.js) instead
     of a strict `r.responsible === myName` check, so an unassigned row
     (responsible null/''/'—') owned by the viewer's own folder counts as
     Mine, "Ben_Lin" vs "Ben Lin" matches, and case/whitespace differences
     match — the exact same rule today-adapter.js's myTasks/teamTasks
     split applies, so the two pages can never disagree on the same row.
     `viewer` is { name, folderName } — folderName is the viewer's real
     folder_name when known, else derived from name (see isMineTask doc).
     row.folder is set on Today-shaped rows; Tasks rows (tasks-aggregator.js)
     carry it as `user_folder` — `r.folder || r.user_folder` covers both. */
  function computeBuckets(rows, viewer, today) {
    return {
      all:     rows,
      mine:    rows.filter(function (r) { return window.FS.api.isMineTask(r.responsible, r.folder || r.user_folder, viewer); }),
      open:    rows.filter(function (r) { return !isRowDone(r) && r.work_class !== 'non_work'; }),
      overdue: rows.filter(function (r) { return isOverdue(r, today) && r.work_class !== 'non_work'; }),
      done:    rows.filter(function (r) { return  isRowDone(r); }),
    };
  }

  /* ---------- TasksContext --------------------------------------------- */

  var TasksContext = React.createContext(null);

  function TasksProvider(props) {
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};

    var refParams = React.useState(function () { return readRouteParams(); });
    var routeParams = refParams[0];
    var setRouteParams = refParams[1];

    React.useEffect(function () {
      return window.FS.Router.subscribe(function () {
        setRouteParams(readRouteParams());
      });
    }, []);

    var targetUser = routeParams.user || null;
    var depKey = (caller.name || '') + '|' + (caller.role || '') + '|' + (caller.isAdmin ? 'admin' : '')
      + '|' + (targetUser || '');

    var refState = React.useState({ status: 'loading' });
    var state    = refState[0];
    var setState = refState[1];

    var retryRef   = React.useState(0);
    var retryCount = retryRef[0];
    var setRetry   = retryRef[1];

    /* fs.settings.tasksView holds { preset, from, to } — persisted/restored by
       the shared RangeToolbar. Default 'all' so the range reaches the real
       report span (Feb–Jun 2026) rather than a trailing-days window that comes
       up empty when "today" runs ahead of the data (same reason as Evidence). */
    var refView = React.useState({ preset: 'all', from: null, to: null });
    var view    = refView[0];
    var setView = refView[1];

    /* batch A2 Task 4 — read the global active-site selection; passed
       EXPLICITLY into the aggregator call below (never read inside the
       aggregator itself — see tasks-aggregator.js _AUDIT note). */
    var refActiveSite = React.useState(function () { return (window.FS && window.FS.siteContext) ? window.FS.siteContext.get() : null; });
    var activeSite    = refActiveSite[0];
    var setActiveSite = refActiveSite[1];
    React.useEffect(function () {
      if (!(window.FS && window.FS.siteContext)) return undefined;
      return window.FS.siteContext.onChange(setActiveSite);
    }, []);

    React.useEffect(function () {
      /* RangeToolbar resolves the range asynchronously ('all' needs
         getSpan()) — wait for both ends before fetching. The toolbar is
         rendered in every non-terminal branch below so it can resolve the
         initial preset even while this is still loading. */
      if (!view.from || !view.to) return undefined;
      var cancelled = false;
      setState({ status: 'loading' });

      var today = window.FS.api.todayNZDT();
      var fetchOpts = { from: view.from, to: view.to };
      if (targetUser) fetchOpts.user = targetUser;
      if (activeSite) fetchOpts.site = activeSite;

      window.FS.api.tasks.getActionsResolvedRange(fetchOpts).then(function (res) {
        if (cancelled) return;
        if (res && res._accessDenied) {
          setState({ status: 'access_denied', message: res.error });
          return;
        }
        var rows = (res && res.rows) || [];
        setState({
          status:     'ok',
          rows:       rows,
          from:       view.from,
          to:         view.to,
          today:      today,
          user:       res.user || null,
          filterUser: targetUser || null,
        });
      }).catch(function (err) {
        if (cancelled) return;
        setState({ status: 'error', error: { code: (err && err.status) || 0, message: (err && err.message) || 'Could not load tasks', retryable: true }, retry: function () { setRetry(function (n) { return n + 1; }); } });
      });

      return function () { cancelled = true; };
    }, [depKey, retryCount, view.from, view.to, activeSite]);

    function removeRow(rowId) {
      setState(function (s) {
        if (s.status !== 'ok') return s;
        var next = (s.rows || []).filter(function (r) { return r.id !== rowId; });
        return Object.assign({}, s, { rows: next });
      });
    }

    /* feat/editable-tasks-ui — optimistic in-place field patch after a
       successful PATCH /api/org/action-items/{id} (TasksRightDetail's
       editors below). Mirrors today.js's patchTask, simplified: /tasks has
       no myTasks/teamTasks split to re-bucket across (filter chips —
       All/Mine/Open/Overdue/Done — are computed at RENDER time from this
       one flat `rows` list, see TasksMiddleColumn's bucketsEarly), so a
       plain merge-in-place is enough — the filter buckets and the TaskCard
       list both re-derive from the patched row automatically. */
    function patchRow(rowId, patch) {
      setState(function (s) {
        if (s.status !== 'ok') return s;
        var next = (s.rows || []).map(function (r) {
          return r.id === rowId ? Object.assign({}, r, patch) : r;
        });
        return Object.assign({}, s, { rows: next });
      });
    }

    /* feat/editable-tasks-ui — cross-surface sync: a check-off made
       elsewhere (Today's rolling list, Timeline's ActionItemRow) fires
       window.FS.actionsBus with {date, topic_id, action_index,
       user_folder, checked, ...} (actions-bus.js + actions.js — only
       emitted in LIVE mode, useMocks:false; a no-op subscription in
       mock mode, which is expected). Mirrors today.js's
       removeTasksMatching/bus-subscribe pattern (fix/action-checkoff-
       sync Bug 2), matched here on the SAME 4 fields
       tasks-aggregator.js rows already carry natively — date/topic_id/
       action_index/user_folder — no camelCase adapter translation
       needed here (unlike Today's rolling items, which carry
       actionIndex/folder instead). Un-checking (checked===false) is
       left alone, same reasoning as Today: re-adding a resolved row
       needs its full aggregator-shaped data, which the bus event
       doesn't carry — a range/filter change (which remounts the fetch)
       picks it back up. */
    React.useEffect(function () {
      var bus = window.FS && window.FS.actionsBus;
      if (!bus) return undefined;
      return bus.subscribe(function (payload) {
        if (!payload || !payload.checked) return;
        setState(function (s) {
          if (s.status !== 'ok') return s;
          var next = (s.rows || []).filter(function (r) {
            if (r.date !== payload.date
                || r.topic_id !== payload.topic_id
                || r.action_index !== payload.action_index) return true;
            /* Both sides present and differ → a different owner's
               same-shaped action on the same date — keep it. Either
               side missing (legacy row/payload with no folder) → fall
               through to the looser date+topic+index match, same
               leniency as today.js. */
            if (payload.user_folder && r.user_folder && r.user_folder !== payload.user_folder) return true;
            return false; /* matched — drop */
          });
          if (next.length === (s.rows || []).length) return s;
          return Object.assign({}, s, { rows: next });
        });
      });
    }, []);

    var ctx = { state: state, removeRow: removeRow, patchRow: patchRow, view: view, setView: setView };
    return React.createElement(TasksContext.Provider, { value: ctx },
      props.children);
  }

  /* ---------- TasksMiddleColumn ---------------------------------------- */

  function TasksMiddleColumn(props) {
    var fs                = window.FieldSight;
    var TasksFilterChips  = fs.TasksFilterChips;
    var TaskCard          = fs.TaskCard;
    var RangeToolbar      = fs.RangeToolbar;
    var CreateTaskModal   = fs.CreateTaskModal;
    var onSelect          = props.onSelect || function () {};

    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
    var myName = caller.name || '';
    /* fix/mine-team-attribution — { name, folderName } passed to the
       shared isMineTask predicate everywhere below. folderName prefers
       the REAL folder_name threaded from GET /api/org/me (session-
       bridge.js onto AuthMock.currentUser.folder_name); falls back to
       deriving it from myName when absent (mock/legacy sessions). */
    var myViewer = { name: myName, folderName: caller.folder_name || null };

    /* Default filter: workers and named users see "Mine" first;
       admin/gm sees "All" so they get the full picture. */
    var defaultFilter = (caller.role === 'admin' || caller.role === 'gm' || caller.isAdmin)
      ? 'all' : 'mine';

    var refFilter = React.useState(defaultFilter);
    var filter    = refFilter[0];
    var setFilter = refFilter[1];

    /* 8.8.1 — visible count; reset to PAGE_SIZE when filter changes */
    var refVisible  = React.useState(PAGE_SIZE);
    var visibleCount = refVisible[0];
    var setVisible   = refVisible[1];

    React.useEffect(function () { setVisible(PAGE_SIZE); }, [filter]);

    /* feat/editable-tasks-ui — "+ New task" modal open state, mirrors
       quality.js's ctx.showCreate: conditionally MOUNTED (not just
       open-toggled) below, so a Cancel/close fully resets CreateTaskModal's
       internal form state for the next open — see create-task-modal.js. */
    var refShowCreateTask  = React.useState(false);
    var showCreateTask     = refShowCreateTask[0];
    var setShowCreateTask  = refShowCreateTask[1];

    /* feat/editable-tasks-ui — guards the bulk "Resolve N" button
       against double-submit while the pooled toggleAction batch is in
       flight. Mirrors today.js's resolvingRef / safety.js's
       refBulkResolving. */
    var refBulkResolving = React.useState(false);
    var bulkResolving    = refBulkResolving[0];
    var setBulkResolving = refBulkResolving[1];

    var ctx   = React.useContext(TasksContext);
    var state = ctx && ctx.state;

    /* feat/editable-tasks-ui — batch multi-select over the on-screen
       (filtered, sorted, paginated) rows — mirrors safety.js's
       groupsEarly/batchEligibleRows pattern (safety.js:260-270): the
       useMultiSelect() hook call below needs `items` in on-screen
       order BEFORE it's called, and hook calls must stay unconditional
       per rules-of-hooks, so this whole "what's rendered right now"
       computation is duplicated defensively here (state may still be
       'loading') rather than after the status early-returns below,
       which is where the equivalent rows/buckets/visible computation
       used to live exclusively. Reused verbatim once state.status ===
       'ok' is confirmed further down — not recomputed. */
    var rowsEarly  = (state && state.status === 'ok') ? (state.rows || []) : [];
    var todayEarly = (state && state.today) || window.FS.api.todayNZDT();

    var bucketsEarly = computeBuckets(rowsEarly, myViewer, todayEarly);
    var countsEarly = {
      all:     bucketsEarly.all.length,
      mine:    bucketsEarly.mine.length,
      open:    bucketsEarly.open.length,
      overdue: bucketsEarly.overdue.length,
      done:    bucketsEarly.done.length,
    };

    /* Sort: open first by (overdue desc, deadline asc, date desc),
       then done at the bottom — same comparator the post-early-return
       code below used to own exclusively. */
    var visibleEarly = (bucketsEarly[filter] || bucketsEarly.all).slice().sort(function (a, b) {
      var aDone = isRowDone(a), bDone = isRowDone(b);
      if (aDone !== bDone) return aDone ? 1 : -1;
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (a.action || '').localeCompare(b.action || '');
    });
    var totalVisibleEarly = visibleEarly.length;
    var hasMoreEarly      = visibleCount < totalVisibleEarly;
    visibleEarly          = visibleEarly.slice(0, visibleCount);

    /* Batch-eligible = still open — mirrors safety.js excluding
       already-resolved rows from Select all / Resolve N (its F4): a
       Done task has nothing to bulk-resolve, and letting it into the
       selection would silently no-op on the resolve call (status 'done'
       when it's already 'done'). */
    var batchEligibleRows = visibleEarly.filter(function (r) { return !isRowDone(r); });

    var multiSelect = window.FieldSight.useMultiSelect({
      items: batchEligibleRows,
      getId: function (r) { return r.id; },
    });

    if (!ctx) {
      console.warn('[TasksMiddleColumn] TasksContext missing');
      return null;
    }

    /* Built once and rendered in EVERY non-terminal branch (loading/error/ok):
       RangeToolbar owns resolving the initial preset into {from,to} via its
       onChange, so it must be mounted even while state is still 'loading' —
       otherwise the fetch guard (view.from null) and the loading state
       deadlock each other. */
    var toolbar = RangeToolbar
      ? React.createElement(RangeToolbar, {
          value:      ctx.view,
          onChange:   ctx.setView,
          presets:    ['today', '7d', '30d', 'all', 'custom'],
          storageKey: 'fs.settings.tasksView',
        })
      : null;

    if (state.status === 'loading') {
      /* Sprint 8.7.3 — skeleton rows while aggregating */
      var skeletonWidths = ['75%', '55%', '90%', '65%', '80%'];
      return React.createElement('div', { className: 'fs-tasks' },
        toolbar,
        React.createElement('div', { className: 'fs-tasks__skeleton' },
          skeletonWidths.map(function (w, i) {
            return React.createElement('div', {
              key: i, className: 'fs-skeleton-row',
            },
              React.createElement('span', {
                className: 'fs-skeleton fs-skeleton-row__check',
              }),
              React.createElement('div', { className: 'fs-skeleton-row__body' },
                React.createElement('span', {
                  className: 'fs-skeleton fs-skeleton-row__title',
                  style:     { width: w },
                }),
                React.createElement('span', {
                  className: 'fs-skeleton fs-skeleton-row__sub',
                }),
              ),
              React.createElement('span', {
                className: 'fs-skeleton fs-skeleton-row__badge',
              }),
            );
          }),
        ),
      );
    }

    if (state.status === 'error') {
      var ErrorBanner = window.FieldSight.ErrorBanner;
      return React.createElement('div', { className: 'fs-tasks' },
        toolbar,
        ErrorBanner
          ? React.createElement(ErrorBanner, {
              message:   (state.error && state.error.message) || 'Could not load tasks',
              retryable: true,
              onRetry:   state.retry,
            })
          : React.createElement('div', { className: 'fs-tasks__empty' },
              (state.error && state.error.message) || 'Could not load tasks'),
      );
    }

    if (state.status === 'access_denied') {
      var AccessDenied = fs.AccessDenied;
      return React.createElement('div', { className: 'fs-tasks' },
        AccessDenied
          ? React.createElement(AccessDenied, {
              scope:   'these tasks',
              message: state.message,
            })
          : React.createElement('div', null, 'Access denied.'),
      );
    }

    /* Reuse the "early" computation from above (rows/today/buckets/
       counts/visible/pagination, incl. batchEligibleRows + multiSelect)
       — only reachable here once state.status === 'ok', so these are
       now guaranteed correct. Not recomputed. */
    var rows         = rowsEarly;
    var today        = todayEarly;
    var buckets      = bucketsEarly;
    var counts       = countsEarly;
    var visible      = visibleEarly;
    var totalVisible = totalVisibleEarly;
    var hasMore      = hasMoreEarly;

    var selectedId = props.selectedItem && props.selectedItem.kind === 'task_row'
      ? props.selectedItem.id
      : null;

    /* feat/editable-tasks-ui — bulk "Resolve N", piggybacking the SAME
       check-off path the single-row circle (below, via TaskCard's
       checkable prop) and TasksRightDetail's Mark complete button both
       use — now FS.api.actions.resolveActionItem (feat/checkoff-org-api:
       the authorised PATCH /api/org/action-items/{id} when the row carries
       a durable actionItemId, else the legacy DynamoDB toggle).
       Mirrors today.js's bulkResolveLeftover
       / safety.js's bulkMarkResolved: each selected row carries its OWN
       date/topic_id/action_index (rows span many dates/owners — no
       single "today" to check off against), and user_folder is the
       report OWNER's folder (feat/user-dim-audit-key, Task 6) — the
       aggregator already stamps this onto every row as `user_folder`
       (tasks-aggregator.js), never the caller/currentUser. Partial
       failure: a failed toggle keeps that row selected (retry-able) and
       is reported via toast; successes are dropped from the rendered
       list (ctx.removeRow — the SAME optimistic-removal path the
       single check-off circle and Mark-complete button already use)
       and the selection. */
    function bulkResolveSelected() {
      var candidates = multiSelect.selectedItems;
      if (bulkResolving || candidates.length === 0) return;
      var api = window.FS && window.FS.api;
      if (!api || !api.actions || !api.pooledAll) return;

      setBulkResolving(true);

      var thunks = candidates.map(function (row) {
        return function () {
          return api.actions.resolveActionItem({
            /* feat/checkoff-org-api — the durable action_items.id the
               aggregator already stamps on every row (tasks-aggregator.js
               `actionItemId: a.id || null`); its presence is what routes
               this write to the AUTHORISED PATCH instead of the legacy
               unauthenticated toggle. */
            actionItemId: row.actionItemId,
            date:         row.date,
            topic_id:     row.topic_id,
            action_index: row.action_index,
            checked:      true,
            action_text:  row.action,
            /* row.folder is never actually set by the aggregator (it
               stamps the owner folder as `user_folder` — see
               tasks-aggregator.js) so this resolves to row.user_folder
               in practice; kept as `row.folder || row.user_folder` to
               mirror Today's exact owner-folder fallback expression,
               in case a future caller ever hands this a Today-shaped
               row (which DOES carry `.folder`). Legacy-leg only. */
            user_folder:  row.folder || row.user_folder,
          }).then(function (env) {
            if (env && env.ok) return { ok: true, row: row };
            /* A 403 RESOLVES out of the org write, so the old
               `.then(() => ok:true)` counted a refusal as a success and
               dropped the row from the list unresolved. */
            console.error('[Tasks] bulk resolve refused for', row.id, env);
            return { ok: false, row: row, message: env && env.message };
          });
        };
      });

      window.FS.api.pooledAll(thunks, 6).then(function (results) {
        var okIds = {};
        var okCount = 0, failCount = 0;
        /* feat/checkoff-org-api — surface the FIRST server reason in the
           toast: "try again" is actively misleading when the answer is
           "admin/gm, this site's pm/site_manager, or the assignee only". */
        var firstReason = null;
        (results || []).forEach(function (r) {
          if (r && r.ok) { okIds[r.row.id] = true; okCount++; }
          else {
            failCount++;
            if (!firstReason && r && r.message) firstReason = r.message;
          }
        });

        Object.keys(okIds).forEach(function (id) { if (ctx.removeRow) ctx.removeRow(id); });

        /* multiSelect.setSelectedIds is the hook's raw escape-hatch
           setter (beyond its 6-field spec) — kept for exactly this
           case: a failed toggle must stay selected for retry, so this
           can't be a blanket multiSelect.clear(). Mirrors today.js's
           bulkResolveLeftover / safety.js's bulkMarkResolved. */
        multiSelect.setSelectedIds(function (prev) {
          var next = {};
          Object.keys(prev).forEach(function (id) { if (!okIds[id]) next[id] = prev[id]; });
          return next;
        });
        setBulkResolving(false);

        var toast = window.FS && window.FS.toast;
        if (!toast) return;
        if (failCount === 0) {
          toast.show({
            message: 'Resolved ' + okCount + ' task' + (okCount === 1 ? '' : 's'),
            tone:    'success',
          });
        } else if (okCount === 0) {
          toast.show({
            message: 'Could not resolve ' + failCount + ' task' + (failCount === 1 ? '' : 's')
                     + (firstReason ? ' — ' + firstReason : ' — try again'),
            tone:     'error',
            duration: 5000,
          });
        } else {
          toast.show({
            message: 'Resolved ' + okCount + ', ' + failCount + ' failed'
                     + (firstReason ? ' — ' + firstReason : ' — still selected, try again'),
            tone:     'warning',
            duration: 5000,
          });
        }
      });
    }

    return React.createElement('div', { className: 'fs-tasks' },

      /* Header */
      React.createElement('div', { className: 'fs-tasks__header' },
        React.createElement('div', {
          style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' },
        },
          React.createElement('div', null,
            React.createElement('h2', { className: 'fs-tasks__title' }, 'Tasks'),
            React.createElement('div', { className: 'fs-tasks__subtitle' },
              'Action items assigned across reports — yours, your team’s, by status'),
          ),
          /* feat/editable-tasks-ui — "+ New task" entry point, primary
             home for CreateTaskModal (see file header note there). Always
             available on /tasks (the tasks hub) — no role gate, unlike
             /quality's "+ Log Item" (quality:manage-gated): task creation
             has no equivalent domain-manager permission in roles.js today,
             and gating it incorrectly is worse than not gating it, per the
             brief this shipped under. */
          CreateTaskModal
            ? React.createElement('button', {
                type:      'button',
                className: 'fs-tasks__new-task-btn',
                onClick:   function () { setShowCreateTask(true); },
              }, '+ New task')
            : null,
          /* feat/editable-tasks-ui — Batch Select toggle, same shared
             .fs-multi-select__toggle classes /today's Leftover section
             and /safety's Multi-Select toggle use (composites.css).
             Reachable whenever the CURRENT page of rows has at least
             one batch-eligible (open) row. */
          batchEligibleRows.length > 0
            ? React.createElement('button', {
                type:            'button',
                className:       'fs-multi-select__toggle'
                  + (multiSelect.batchMode ? ' fs-multi-select__toggle--active' : ''),
                onClick:         function () { multiSelect.setBatchMode(function (prev) { return !prev; }); },
                'aria-pressed':  multiSelect.batchMode,
              }, multiSelect.batchMode ? 'Batch Select: On' : 'Batch Select')
            : null,
        ),
        React.createElement('div', { className: 'fs-tasks__meta' },
          rows.length + ' actions · ' + fmtDate(state.from) + ' → ' + fmtDate(state.to),
          React.createElement('span', {
            className: 'fs-tasks__meta-info',
            title:     'Aggregated client-side from /api/timeline + /api/actions per day. A backend /api/actions/all aggregator would speed this up at scale.',
          }, 'ⓘ'),
        ),
      ),

      /* feat/editable-tasks-ui — Create task modal. Conditionally MOUNTED
         (not just open-toggled) so CreateTaskModal's internal form state
         resets on every open, mirroring quality.js's
         `ctx.showCreate && QualityCreateModal ? ... : null` pattern.
         onCreated is a no-op beyond the modal's own toast/close — see
         create-task-modal.js's TOPIC-SCOPING NOTE: the mock write has no
         row shape this page's aggregator-fed list can surface, so there
         is nothing here to prepend/refetch into `rows`. */
      showCreateTask && CreateTaskModal
        ? React.createElement(CreateTaskModal, {
            open:      true,
            onClose:   function () { setShowCreateTask(false); },
            onCreated: function () {},
            siteId:    (window.FS.siteContext && window.FS.siteContext.get()) || '',
          })
        : null,

      /* Date-range selector — Today / 7d / 30d / All / Custom */
      toolbar,

      /* Filter chips */
      React.createElement(TasksFilterChips, {
        value:    filter,
        counts:   counts,
        onChange: function (next) { setFilter(next); },
      }),

      /* feat/editable-tasks-ui — bulk action bar (shared
         MultiSelectBulkBar composite — same one /today's Leftover +
         /safety use), shown whenever Batch Select mode is on. */
      multiSelect.batchMode
        ? React.createElement(fs.MultiSelectBulkBar, {
            count:   multiSelect.selectedItems.length,
            actions: [
              { key: 'resolve', primary: true, onClick: bulkResolveSelected,
                disabled: bulkResolving || multiSelect.selectedItems.length === 0,
                label: bulkResolving ? 'Resolving…' : 'Resolve ' + multiSelect.selectedItems.length },
              { key: 'clear', label: 'Clear', onClick: multiSelect.clear, disabled: bulkResolving },
            ],
          })
        : null,

      /* List */
      visible.length === 0
        ? React.createElement('div', { className: 'fs-tasks__empty' },
            'No ' + (filter === 'all' ? '' : filter + ' ') + 'tasks in this window.')
        : React.createElement('div', { className: 'fs-tasks__list' },
            visible.map(function (row) {
              var rowDone = isRowDone(row);
              var task = {
                id:          row.id,
                topic_id:    row.topic_id,
                actionIndex: row.action_index,
                /* feat/checkoff-org-api — the durable action_items.id
                   (tasks-aggregator.js `actionItemId: a.id || null`). It
                   was NEVER threaded onto this task object, so TaskCard's
                   check-off circle on /tasks always fell through to the
                   legacy unauthenticated toggle even for rows that had a
                   perfectly good id — the /today card has passed it since
                   feat/editable-tasks-ui. Threading it is what actually
                   moves this page's check-off onto the authorised PATCH. */
                actionItemId: row.actionItemId,
                title:       row.action,
                assignee:    row.responsible || '—',
                status:      rowDone ? 'Done' : (isOverdue(row, today) ? 'Overdue' : 'Open'),
                statusTone:  rowDone ? 'success'
                            : (isOverdue(row, today) ? 'danger' : 'info'),
                priority:    row.priority
                              ? row.priority.charAt(0).toUpperCase() + row.priority.slice(1)
                              : 'Medium',
                dueTime:     window.FS.api.resolveDeadline(row.deadline, row.date).display || '—',
                /* feat/editable-tasks-ui — the report OWNER's folder
                   (feat/user-dim-audit-key, Task 6), read by
                   task-card.js's checkable path as `task.folder` and
                   sent as `user_folder` on its toggleAction call. `row`
                   has no `.folder` field of its own (tasks-aggregator.js
                   stamps it as `user_folder`) — `row.folder ||
                   row.user_folder` mirrors the exact owner-folder
                   fallback used elsewhere in this feature. */
                folder:      row.folder || row.user_folder,
                /* Q1 — tier-aware Today/Tasks: threaded straight through so
                   TaskCard can render the "Possibly personal" badge (same
                   field today.js's myTasks/teamTasks items already carry
                   verbatim off today-adapter.js). */
                work_class:  row.work_class,
              };
              /* feat/editable-tasks-ui — batch-eligible = still open
                 (mirrors batchEligibleRows above / safety.js's per-row
                 batchEligible gate): a Done row keeps opening the
                 detail panel regardless of Batch Select mode — no fake
                 selection affordance for a row with nothing left to
                 resolve. */
              var batchEligible = !rowDone;
              var batchSelected = multiSelect.batchMode && batchEligible && !!multiSelect.selectedIds[row.id];
              return React.createElement(TaskCard, {
                key:           row.id,
                task:          task,
                /* fix/mine-team-attribution — same shared predicate as
                   computeBuckets' `mine` bucket above (and today-adapter
                   .js's myTasks/teamTasks split): NOT a strict `===`
                   check any more. row.folder is set on some row shapes,
                   row.user_folder on tasks-aggregator.js's — either one
                   is the row's OWNER folder, used only for the
                   unassigned-row rule. */
                isMine:        window.FS.api.isMineTask(row.responsible, row.folder || row.user_folder, myViewer),
                selected:      selectedId === row.id,
                /* Row-level check-off (feat/editable-tasks-ui) — only
                   open rows get the round checkbox; a Done row falls
                   back to TaskCard's default avatar. actionItemId/date/
                   topic_id/actionIndex/folder above are what task-card.js's
                   checkable path needs to call
                   FS.api.actions.resolveActionItem in place. On success the
                   row drops out of TasksProvider's snapshot via
                   ctx.removeRow — mirrors TasksRightDetail's
                   onMarkComplete. A refusal (403) never reaches
                   onCheckedOff: TaskCard aborts the animation and toasts.
                   feat/checkoff-org-api — "Done" is now the union of the
                   Aurora column and the legacy overlay (isRowDone), so a
                   row completed through the Status editor no longer keeps
                   showing a live check-off circle. */
                checkable:     !rowDone,
                date:          row.date,
                onCheckedOff:  function (t) { if (ctx.removeRow) ctx.removeRow(t.id); },
                /* Batch select (feat/editable-tasks-ui) — the SAME
                   round button doubles as a multi-select toggle while
                   multiSelect.batchMode is on (task-card.js's
                   handleCheckClick branches on batchMode internally). */
                batchMode:     multiSelect.batchMode,
                batchSelected: batchSelected,
                onBatchToggle: multiSelect.onItemClick,
                onSelect:      function () {
                  if (multiSelect.batchMode && batchEligible) {
                    multiSelect.onItemClick(row);
                    return;
                  }
                  onSelect({
                    kind:        'task_row',
                    id:          row.id,
                    row:         row,
                  });
                },
              });
            }),
          ),

      /* Sprint 8.8.1 — load more */
      hasMore
        ? React.createElement('div', { className: 'fs-tasks__load-more' },
            React.createElement('button', {
              type:      'button',
              className: 'fs-tasks__load-more-btn',
              onClick:   function () { setVisible(function (n) { return n + PAGE_SIZE; }); },
            }, 'Load more (' + (totalVisible - visibleCount) + ' remaining)'),
          )
        : null,
    );
  }

  /* =====================================================================
     feat/editable-tasks-ui — task-detail editors (priority/status/due/
     assignee), wired to PATCH /api/org/action-items/{id}. Own copy of
     today.js's identically-named/valued constants — this codebase's
     established convention is each page keeps its own copy rather than
     sharing an export (see CLAUDE.md "Admin permission flow" note on
     adminUserFolders() for the same pattern elsewhere).
     ===================================================================== */
  var PRIORITY_OPTIONS = [
    { value: 'low',    label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high',   label: 'High' },
  ];
  var STATUS_OPTIONS = [
    { value: 'open',        label: 'Open' },
    { value: 'in_progress', label: 'In progress' },
    { value: 'blocked',     label: 'Blocked' },
    { value: 'done',        label: 'Done' },
  ];

  /* ---------- TasksRightDetail ---------------------------------------- */

  function TasksRightDetail(props) {
    var fs           = window.FieldSight;
    var Card         = fs.Card;
    var Badge        = fs.Badge;
    var Button       = fs.Button;
    var IconBtn      = fs.IconButton;
    var EvidenceTabs = fs.EvidenceTabs;
    var Select       = fs.Select;
    var Input        = fs.Input;

    var ctx = React.useContext(TasksContext);
    var sel = props.selectedItem;

    var refBusy = React.useState(false);
    var busy    = refBusy[0];
    var setBusy = refBusy[1];

    /* feat/editable-tasks-ui — Details/History tab split (reuses the
       /evidence page's EvidenceTabs composite). Declared before the
       `!sel` early return below so hook order stays stable across
       selection changes, matching refBusy's placement. */
    var refTab    = React.useState('details');
    var activeTab = refTab[0];
    var setTab    = refTab[1];

    /* feat/editable-tasks-ui — resolve the LIVE row from TasksContext
       (ctx.state.rows), falling back to the selectedItem's own snapshot
       row. Mirrors today.js's `findItemById(data, sel.id) || sel` — after
       a successful edit, ctx.patchRow merges the PATCH response into
       ctx.state.rows, so re-reading it here (rather than trusting the
       possibly-stale `sel.row` captured at click time) is what makes the
       panel reflect the edit without a reload. Declared before the `!sel`
       early return so the hooks below it (draft/roster) stay unconditional
       — same hook-order discipline as refBusy/refTab above. */
    var liveRows = (ctx && ctx.state && ctx.state.status === 'ok') ? ctx.state.rows : null;
    var row = (sel && sel.row) || null;
    if (sel && liveRows) {
      var liveMatch = liveRows.filter(function (r) { return r.id === sel.id; })[0];
      if (liveMatch) row = liveMatch;
    }

    /* feat/editable-tasks-ui — priority/status/due/assignee editors.
       Backend is the real authority gate (400/403/404 on the PATCH); this
       FS.can() check is UX only, exactly mirroring today.js's
       TodayRightDetail (see that file for the full rationale comment —
       not repeated here). */
    var caller        = (window.AuthMock && window.AuthMock.currentUser) || {};
    var canEditTask   = !!(window.FS && window.FS.can && window.FS.P
                        && window.FS.can(caller, window.FS.P('task', 'edit')));
    var canAssignTask = !!(window.FS && window.FS.can && window.FS.P
                        && window.FS.can(caller, window.FS.P('task', 'assign')));

    /* F1 — the caller's OWN task (they are the current responsible party).
       Mirrors today.js's isOwnTask; must be computed before
       fieldsEditable/assigneeEditable/rosterSiteId below, which widen on
       it. Guarded on `row` since this runs before the `!sel`/`!row` early
       return. */
    var isOwnTask = !!(row && row.responsible && row.responsible === (caller && caller.name));

    /* Optimistic per-field overrides — same shape/precedent as today.js's
       draftRef (keyed by the PATCH body's field names, holding RAW
       values). Reset whenever the selected row changes. */
    var draftRef = React.useState({});
    var draft    = draftRef[0];
    var setDraft = draftRef[1];
    React.useEffect(function () { setDraft({}); }, [row && row.id]);

    /* Assignee roster — FS.api.org.getSiteMembers(row.siteId), identical
       call + gating to today.js's TodayRightDetail. row.siteId is threaded
       from tasks-aggregator.js's getOrgSiteIdMap() (mirrors today.js's own
       getOrgSiteIdMap() threaded via today-adapter.js's ctx.siteIdByName);
       a lookup miss (siteId: null) degrades the picker to read-only below,
       same as an empty/errored roster. */
    var rosterRef = React.useState({ status: 'idle', users: [] });
    var roster    = rosterRef[0];
    var setRoster = rosterRef[1];
    var rosterSiteId = (row && (canAssignTask || isOwnTask)) ? row.siteId : null;
    React.useEffect(function () {
      if (!rosterSiteId) { setRoster({ status: 'idle', users: [] }); return undefined; }
      var cancelled = false;
      setRoster({ status: 'loading', users: [] });
      var org = window.FS && window.FS.api && window.FS.api.org;
      if (!org || !org.getSiteMembers) { setRoster({ status: 'error', users: [] }); return undefined; }
      org.getSiteMembers(rosterSiteId).then(function (res) {
        if (cancelled) return;
        if (!res || res._accessDenied || res._notFound) { setRoster({ status: 'error', users: [] }); return; }
        setRoster({ status: 'ok', users: (res.users || []).filter(function (u) { return u && u.name; }) });
      }).catch(function () {
        if (!cancelled) setRoster({ status: 'error', users: [] });
      });
      return function () { cancelled = true; };
    }, [rosterSiteId]);

    if (!sel || sel.kind !== 'task_row' || !row) {
      return React.createElement('div', { className: 'fs-tasks-detail__placeholder' },
        React.createElement('div', { className: 'fs-tasks-detail__placeholder-title' },
          'Select an action'),
        React.createElement('div', { className: 'fs-tasks-detail__placeholder-body' },
          'Pick any row in the list to see its full detail and audit history.'),
      );
    }

    var today = ctx && ctx.state && ctx.state.today;
    var overdue = isOverdue(row, today);

    /* One generic commit path for all 4 fields — PATCH
       /api/org/action-items/{id}, then fold the FULL updated row's fields
       back into TasksContext (ctx.patchRow — updates the list card AND
       this panel at once) or, on _accessDenied/_notFound/thrown error,
       drop the optimistic override and toast. Mirrors today.js's
       commitTaskField exactly; row.priority/row.status here are already
       RAW enum values (tasks-aggregator.js, unlike today-adapter.js's
       item.priority/.status which are DERIVED labels), so — unlike
       today.js — there's no label re-derivation needed on the response,
       just a straight pass-through. */
    function commitRowField(fieldKey, value) {
      if (!row.actionItemId) return;
      var api = window.FS && window.FS.api && window.FS.api.actions;
      if (!api || !api.updateAction) return;
      var patch = {};
      patch[fieldKey] = value;
      setDraft(function (d) {
        var next = Object.assign({}, d);
        next[fieldKey] = value;
        return next;
      });
      function clearDraft() {
        setDraft(function (d) {
          var next = Object.assign({}, d);
          delete next[fieldKey];
          return next;
        });
      }
      api.updateAction(row.actionItemId, patch).then(function (res) {
        if (!res || res._accessDenied || res._notFound) {
          clearDraft();
          var toast = window.FS && window.FS.toast;
          if (toast) {
            toast.show({
              message:  (res && res.error) || 'Could not update task',
              tone:     'error',
              duration: 5000,
            });
          }
          return;
        }
        var patchOut = {};
        if (res.priority)             patchOut.priority    = res.priority;
        if (res.status !== undefined) patchOut.status       = res.status || null;
        if (res.deadline !== undefined) patchOut.deadline   = res.deadline || null;
        if (res.responsible)          patchOut.responsible  = res.responsible;
        if (ctx && ctx.patchRow) ctx.patchRow(row.id, patchOut);
        clearDraft();
      }).catch(function (err) {
        clearDraft();
        var toast = window.FS && window.FS.toast;
        if (toast) {
          toast.show({
            message:  'Could not update task' + ((err && err.message) ? ': ' + err.message : ''),
            tone:     'error',
            duration: 5000,
          });
        }
      });
    }

    var fieldsEditable   = (canEditTask || isOwnTask) && !!row.actionItemId;
    var assigneeEditable = (canAssignTask || isOwnTask) && !!row.actionItemId
                          && !!row.siteId && roster.status === 'ok' && roster.users.length > 0;

    var priorityValue   = draft.priority   !== undefined ? draft.priority   : (row.priority || 'medium');
    var statusValue     = draft.status     !== undefined ? draft.status     : (row.status   || 'open');
    /* fix/date-field-crash — DateField needs a strict 'YYYY-MM-DD' | null, never
       the raw free-text deadline ("Week after next Tuesday (2026-07-28 approx.)"),
       which crashes DatePicker on open. A draft is already a clean ISO from a
       prior DateField onChange; the stored deadline is normalised via
       resolveDeadline (embedded date wins) so old fuzzy values open + edit. */
    var dueValue         = draft.deadline   !== undefined ? draft.deadline   : (window.FS.api.resolveDeadline(row.deadline, row.date).absolute || '');
    var currentAssignee = row.responsible || '';
    var assigneeValue   = draft.responsible !== undefined ? draft.responsible : currentAssignee;

    var ownerCell = assigneeEditable ? React.createElement(Select, {
      size: 'sm', fullWidth: true, value: assigneeValue,
      placeholder: assigneeValue ? undefined : 'Select a member',
      options: roster.users.map(function (u) { return { value: u.name, label: u.name }; }),
      onChange: function (e) { commitRowField('responsible', e.target.value); },
    }) : (row.responsible || '—');

    /* fix/english-date-field — native <input type="date"> replaced with
       DateField (in-page English, theme-aware picker; the native
       calendar popup renders in the OS locale and can't be forced to
       English via HTML/CSS — see date-field.js header doc). DateField's
       onChange already hands back 'YYYY-MM-DD' | null directly — no
       Date() parse either direction, so BUG-19 doesn't apply here.
       Mirrors today.js's dueCell verbatim. */
    var dueCell = fieldsEditable ? React.createElement(fs.DateField, {
      size: 'sm', value: dueValue || null,
      onChange: function (iso) { commitRowField('deadline', iso || null); },
    }) : (window.FS.api.resolveDeadline(row.deadline, row.date).display || '—');

    var statusCell = fieldsEditable ? React.createElement(Select, {
      size: 'sm', fullWidth: true, value: statusValue, options: STATUS_OPTIONS,
      onChange: function (e) { commitRowField('status', e.target.value); },
    }) : window.FS.api.deriveStatus(row.status, row.audit && row.audit.checked).status;

    var priorityCell = fieldsEditable ? React.createElement(Select, {
      size: 'sm', fullWidth: true, value: priorityValue, options: PRIORITY_OPTIONS,
      onChange: function (e) { commitRowField('priority', e.target.value); },
    }) : (row.priority ? row.priority.charAt(0).toUpperCase() + row.priority.slice(1) : 'Medium');

    function onMarkComplete() {
      if (busy || isRowDone(row)) return;
      setBusy(true);
      /* feat/checkoff-org-api — same routed, always-resolving call as the
         list circle and the bulk bar. user_folder feeds the legacy leg
         only; actionItemId is what routes to the authorised PATCH. */
      window.FS.api.actions.resolveActionItem({
        actionItemId: row.actionItemId,
        date:         row.date,
        topic_id:     row.topic_id,
        action_index: row.action_index,
        checked:      true,
        action_text:  row.action,
        user_folder:  row.user_folder,
      }).then(function (env) {
        if (env && env.ok) {
          if (ctx && ctx.removeRow) ctx.removeRow(row.id);
          if (props.onClose) props.onClose();
          return;
        }
        /* Refused/failed — keep the panel open on the unresolved row and
           say why. The old `.catch` never even fired on a 403 (the org
           write RESOLVES it), and closing the panel reads as success. */
        console.error('[Tasks right] markComplete refused', env);
        setBusy(false);
        var toast = window.FS && window.FS.toast;
        if (toast) {
          toast.show({
            message:  (env && env.message) || 'Could not check off this task.',
            tone:     'error',
            duration: 5000,
          });
        }
      });
    }

    function onOpenInTimeline() {
      var qs = '?date=' + encodeURIComponent(row.date);
      if (row.user_folder) qs += '&user=' + encodeURIComponent(row.user_folder);
      window.FS.Router.navigate('/timeline' + qs);
    }

    var statusBadge;
    /* feat/checkoff-org-api — union of the Aurora column and the legacy
       overlay, so this badge can no longer contradict the Status editor
       three rows below it (which writes/reads the column). */
    if (isRowDone(row)) {
      statusBadge = React.createElement(Badge, { tone: 'success', size: 'sm', prefixDot: true }, 'Done');
    } else if (overdue) {
      statusBadge = React.createElement(Badge, { tone: 'danger', size: 'sm', prefixDot: true }, 'Overdue');
    } else {
      statusBadge = React.createElement(Badge, { tone: 'info', size: 'sm', prefixDot: true }, 'Open');
    }

    var priorityBadge = row.priority
      ? React.createElement(Badge, {
          tone: row.priority === 'high' ? 'danger'
              : row.priority === 'low'  ? 'neutral' : 'warning',
          size: 'sm', variant: 'outline',
        }, row.priority.charAt(0).toUpperCase() + row.priority.slice(1))
      : null;

    return React.createElement('div', { className: 'fs-tasks-detail' },

      /* Header */
      React.createElement('div', { className: 'fs-tasks-detail__header' },
        React.createElement('div', { className: 'fs-tasks-detail__header-main' },
          React.createElement('h2', { className: 'fs-tasks-detail__title' },
            row.action),
          React.createElement('div', { className: 'fs-tasks-detail__metaline' },
            statusBadge, priorityBadge,
          ),
        ),
        IconBtn ? React.createElement(IconBtn, {
          icon: 'x', ariaLabel: 'Close detail', size: 'sm',
          onClick: function () { if (props.onClose) props.onClose(); },
        }) : null,
      ),

      /* feat/editable-tasks-ui — Details/History tab split. Details holds
         the full action text (already unclamped in the header above) +
         field rows + action buttons; History holds the Sprint 11 C.3
         cross-day audit drawer, moved under its own tab rather than
         always-rendered inline. */
      EvidenceTabs ? React.createElement(EvidenceTabs, {
        tabs: [
          { key: 'details', label: 'Details' },
          { key: 'history', label: 'History' },
        ],
        active:   activeTab,
        onChange: setTab,
      }) : null,

      activeTab === 'history'
        ? (
            /* Sprint 11 C.3 — Cross-day history drawer.
               Pulls every audit entry (any date) for the same logical
               action (matched by topic_id + action_index) so the drawer
               can show "this action was opened 3 May, closed 5 May, re-
               opened 6 May…". Q-S11-3 default: role-aware visibility —
               admin/gm see all check events; regular users see only
               their own resolutions. */
            React.createElement(ActionHistoryPanel, { row: row })
          )
        : React.createElement(React.Fragment, null,

            /* Field rows — feat/editable-tasks-ui: Owner/Due/Status/Priority
               now render editable Select/Input controls (ownerCell/dueCell/
               statusCell/priorityCell above) when fieldsEditable/
               assigneeEditable permit, exactly like today.js's
               TodayRightDetail; otherwise they fall back to the same
               plain-text values these rows always showed. */
            React.createElement('div', { className: 'fs-tasks-detail__rows' },
              React.createElement(DetailRow, {
                label: 'Owner',     value: ownerCell,
              }),
              React.createElement(DetailRow, {
                label: 'Due',       value: dueCell,
              }),
              React.createElement(DetailRow, {
                label: 'Status',    value: statusCell,
              }),
              React.createElement(DetailRow, {
                label: 'Priority',  value: priorityCell,
              }),
              React.createElement(DetailRow, {
                label: 'Date',      value: fmtDate(row.date),
              }),
              React.createElement(DetailRow, {
                label: 'From topic',value: row.topic_title,
              }),
              React.createElement(DetailRow, {
                label: 'Category',  value: row.topic_category,
              }),
              React.createElement(DetailRow, {
                label: 'Reporter',  value: row.user_name,
              }),
              /* No Time row: unlike Today's rows (item.timeRange, stamped
                 by today-adapter.js from the topic's time_range), the
                 tasks-aggregator.js row shape (see its header comment)
                 does not carry topic time_range onto the row — nothing to
                 show without inventing a field that isn't there. */
            ),

            /* Actions */
            React.createElement('div', { className: 'fs-tasks-detail__actions' },
              !isRowDone(row)
                ? React.createElement(Button, {
                    size: 'sm', leftIcon: 'check',
                    onClick: onMarkComplete, disabled: busy,
                  }, busy ? 'Saving…' : 'Mark complete')
                : null,
              React.createElement(Button, {
                variant: 'secondary', size: 'sm', rightIcon: 'arrow-right',
                onClick: onOpenInTimeline,
              }, 'Open in timeline'),
            ),
          ),
    );
  }

  function DetailRow(props) {
    return React.createElement('div', { className: 'fs-tasks-detail__row' },
      React.createElement('div', { className: 'fs-tasks-detail__row-label' },
        props.label),
      React.createElement('div', { className: 'fs-tasks-detail__row-value' },
        props.value),
    );
  }

  /* ─── Sprint 11 C.3 · ActionHistoryPanel ───────────────────────────── */

  function ActionHistoryPanel(props) {
    var row = props.row;
    /* User-dim audit key (plan §1.3) — match either the composite key
       (row.user_folder present) or the bare legacy key, so records written
       before the migration still surface in history. */
    var bareKey = row.topic_id + '_' + row.action_index;
    var compositeKey = row.user_folder ? (row.user_folder + '|' + bareKey) : bareKey;

    var dataRef = React.useState({ status: 'loading' });
    var data    = dataRef[0]; var setData = dataRef[1];

    React.useEffect(function () {
      var cancelled = false;
      /* Fan-out covers the whole 3-month dates window so we catch
         re-opens / re-closes from earlier dates too. */
      var today = window.FS.api.todayNZDT();
      var from  = window.FS.api.addDaysISO(today, -90);
      window.FS.api.tasks.getCrossDayAudit({
        from: from, to: today,
      }).then(function (res) {
        if (cancelled) return;
        if (!res || res._accessDenied) {
          setData({ status: 'hidden' });
          return;
        }
        var entries = (res.entries || []).filter(function (e) {
          return e.topic_action_key === compositeKey || e.topic_action_key === bareKey;
        });

        /* Q-S11-3 — admin/gm see all events; regular users see only
           their own resolutions. */
        var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
        var isAdminLike = caller.role === 'admin' || caller.role === 'gm'
          || caller.role === 'director' || caller.isAdmin;
        if (!isAdminLike) {
          entries = entries.filter(function (e) {
            return !e.checked_by || e.checked_by === caller.name;
          });
        }
        /* Newest first. */
        entries.sort(function (a, b) {
          return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
        });
        setData({ status: 'ok', entries: entries });
      }).catch(function () {
        if (!cancelled) setData({ status: 'hidden' });
      });
      return function () { cancelled = true; };
    }, [bareKey, compositeKey]);

    if (data.status !== 'ok') return null;

    var anyChecked = data.entries.some(function (e) { return e.checked; });

    return React.createElement('div', { className: 'fs-tasks-detail__history' },
      React.createElement('div', { className: 'fs-tasks-detail__history-label' },
        'History · ' + data.entries.length + ' event' + (data.entries.length === 1 ? '' : 's')),
      data.entries.length === 0 || !anyChecked
        ? React.createElement('div', { className: 'fs-tasks-detail__history-empty' },
            'No check-off events recorded yet.')
        : React.createElement('ol', { className: 'fs-tasks-detail__history-list' },
            data.entries.map(function (e) {
              return React.createElement('li', {
                key:       e.action_id,
                className: 'fs-tasks-detail__history-event'
                           + (e.checked ? ' fs-tasks-detail__history-event--checked' : ''),
              },
                React.createElement('span', { className: 'fs-tasks-detail__history-marker' },
                  e.checked ? '✓' : '○'),
                React.createElement('div', { className: 'fs-tasks-detail__history-meta' },
                  React.createElement('span', { className: 'fs-tasks-detail__history-date' },
                    fmtDate(e.date)),
                  e.checked
                    ? React.createElement('span', { className: 'fs-tasks-detail__history-by' },
                        'by ' + (e.checked_by || '—')
                          + (fmtTimestamp(e.checked_at) ? ' · ' + fmtTimestamp(e.checked_at) : ''))
                    : React.createElement('span', { className: 'fs-tasks-detail__history-by' },
                        'opened (no resolution recorded yet)'),
                ),
              );
            }),
          ),
    );
  }

  /* ---------- Register --------------------------------------------------- */

  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.PAGES) window.FieldSight.PAGES = {};
  window.FieldSight.PAGES['/tasks'] = {
    Middle:   TasksMiddleColumn,
    Right:    TasksRightDetail,
    Provider: TasksProvider,
  };

  /* Expose the pure Q1 bucket helper to Node's test runner only
     (CommonJS). No-op in the browser (Babel standalone leaves `module`
     undefined), so the page bundle is unaffected — mirrors timeline.js's
     identical guard. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { computeBuckets: computeBuckets, isOverdue: isOverdue, isRowDone: isRowDone };
  }

})();
