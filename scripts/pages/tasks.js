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
     • Mark complete CTA — wires through FS.api.actions.toggleAction
       (reuses Sprint 2.4 P-04 optimistic flow; on success removes
       the row from the page snapshot via TasksContext.removeRow)

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
  function isOverdue(row, today) {
    if (!row || row.audit.checked) return false;
    var iso = window.FS.api.resolveDeadline(row.deadline, row.date).absolute;
    if (!iso) return false;
    return iso < today;
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

    var ctx = { state: state, removeRow: removeRow, view: view, setView: setView };
    return React.createElement(TasksContext.Provider, { value: ctx },
      props.children);
  }

  /* ---------- TasksMiddleColumn ---------------------------------------- */

  function TasksMiddleColumn(props) {
    var fs                = window.FieldSight;
    var TasksFilterChips  = fs.TasksFilterChips;
    var TaskCard          = fs.TaskCard;
    var RangeToolbar      = fs.RangeToolbar;
    var onSelect          = props.onSelect || function () {};

    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
    var myName = caller.name || '';

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

    var bucketsEarly = {
      all:     rowsEarly,
      mine:    rowsEarly.filter(function (r) { return r.responsible === myName; }),
      open:    rowsEarly.filter(function (r) { return !r.audit.checked; }),
      overdue: rowsEarly.filter(function (r) { return isOverdue(r, todayEarly); }),
      done:    rowsEarly.filter(function (r) { return  r.audit.checked; }),
    };
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
      if (a.audit.checked !== b.audit.checked) return a.audit.checked ? 1 : -1;
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (a.action || '').localeCompare(b.action || '');
    });
    var totalVisibleEarly = visibleEarly.length;
    var hasMoreEarly      = visibleCount < totalVisibleEarly;
    visibleEarly          = visibleEarly.slice(0, visibleCount);

    /* Batch-eligible = still open — mirrors safety.js excluding
       already-resolved rows from Select all / Resolve N (its F4): a
       Done task has nothing to bulk-resolve, and letting it into the
       selection would silently no-op on toggleAction (checked: true
       when it's already true). */
    var batchEligibleRows = visibleEarly.filter(function (r) { return !r.audit.checked; });

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
       actions-toggle endpoint the single-row check-off circle (below,
       via TaskCard's checkable prop) and TasksRightDetail's Mark
       complete button both use. Mirrors today.js's bulkResolveLeftover
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
          return api.actions.toggleAction({
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
               row (which DOES carry `.folder`). */
            user_folder:  row.folder || row.user_folder,
          }).then(function () { return { ok: true, row: row }; })
            .catch(function (err) {
              console.error('[Tasks] bulk resolve failed for', row.id, err);
              return { ok: false, row: row };
            });
        };
      });

      window.FS.api.pooledAll(thunks, 6).then(function (results) {
        var okIds = {};
        var okCount = 0, failCount = 0;
        (results || []).forEach(function (r) {
          if (r && r.ok) { okIds[r.row.id] = true; okCount++; }
          else { failCount++; }
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
            message: 'Could not resolve ' + failCount + ' task' + (failCount === 1 ? '' : 's') + ' — try again',
            tone:    'error',
          });
        } else {
          toast.show({
            message: 'Resolved ' + okCount + ', ' + failCount + ' failed — still selected, try again',
            tone:    'warning',
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
              var task = {
                id:          row.id,
                topic_id:    row.topic_id,
                actionIndex: row.action_index,
                title:       row.action,
                assignee:    row.responsible || '—',
                status:      row.audit.checked ? 'Done' : (isOverdue(row, today) ? 'Overdue' : 'Open'),
                statusTone:  row.audit.checked ? 'success'
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
              };
              /* feat/editable-tasks-ui — batch-eligible = still open
                 (mirrors batchEligibleRows above / safety.js's per-row
                 batchEligible gate): a Done row keeps opening the
                 detail panel regardless of Batch Select mode — no fake
                 selection affordance for a row with nothing left to
                 resolve. */
              var batchEligible = !row.audit.checked;
              var batchSelected = multiSelect.batchMode && batchEligible && !!multiSelect.selectedIds[row.id];
              return React.createElement(TaskCard, {
                key:           row.id,
                task:          task,
                isMine:        row.responsible === myName,
                selected:      selectedId === row.id,
                /* Row-level check-off (feat/editable-tasks-ui) — only
                   open rows get the round checkbox; a Done row falls
                   back to TaskCard's default avatar. date/topic_id/
                   actionIndex/folder above are what task-card.js's
                   checkable path needs to call
                   FS.api.actions.toggleAction in place. On success the
                   row drops out of TasksProvider's snapshot via
                   ctx.removeRow — mirrors TasksRightDetail's
                   onMarkComplete. */
                checkable:     !row.audit.checked,
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

  /* ---------- TasksRightDetail ---------------------------------------- */

  function TasksRightDetail(props) {
    var fs        = window.FieldSight;
    var Card      = fs.Card;
    var Badge     = fs.Badge;
    var Button    = fs.Button;
    var IconBtn   = fs.IconButton;

    var ctx = React.useContext(TasksContext);
    var sel = props.selectedItem;

    var refBusy = React.useState(false);
    var busy    = refBusy[0];
    var setBusy = refBusy[1];

    if (!sel || sel.kind !== 'task_row') {
      return React.createElement('div', { className: 'fs-tasks-detail__placeholder' },
        React.createElement('div', { className: 'fs-tasks-detail__placeholder-title' },
          'Select an action'),
        React.createElement('div', { className: 'fs-tasks-detail__placeholder-body' },
          'Pick any row in the list to see its full detail and audit history.'),
      );
    }

    var row = sel.row;
    var today = ctx && ctx.state && ctx.state.today;
    var overdue = isOverdue(row, today);

    function onMarkComplete() {
      if (busy || row.audit.checked) return;
      setBusy(true);
      window.FS.api.actions.toggleAction({
        date:         row.date,
        topic_id:     row.topic_id,
        action_index: row.action_index,
        checked:      true,
        action_text:  row.action,
        user_folder:  row.user_folder,
      }).then(function () {
        if (ctx && ctx.removeRow) ctx.removeRow(row.id);
        if (props.onClose) props.onClose();
      }).catch(function (err) {
        console.error('[Tasks right] markComplete failed', err);
        setBusy(false);
      });
    }

    function onOpenInTimeline() {
      var qs = '?date=' + encodeURIComponent(row.date);
      if (row.user_folder) qs += '&user=' + encodeURIComponent(row.user_folder);
      window.FS.Router.navigate('/timeline' + qs);
    }

    var statusBadge;
    if (row.audit.checked) {
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

      /* Field rows */
      React.createElement('div', { className: 'fs-tasks-detail__rows' },
        React.createElement(DetailRow, {
          label: 'Owner',     value: row.responsible || '—',
        }),
        React.createElement(DetailRow, {
          label: 'Due',       value: window.FS.api.resolveDeadline(row.deadline, row.date).display || '—',
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
      ),

      /* Sprint 11 C.3 — Cross-day history drawer.
         Pulls every audit entry (any date) for the same logical
         action (matched by topic_id + action_index) so the drawer
         can show "this action was opened 3 May, closed 5 May, re-
         opened 6 May…". Q-S11-3 default: role-aware visibility —
         admin/gm see all check events; regular users see only
         their own resolutions. */
      React.createElement(ActionHistoryPanel, { row: row }),

      /* Actions */
      React.createElement('div', { className: 'fs-tasks-detail__actions' },
        !row.audit.checked
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

})();
