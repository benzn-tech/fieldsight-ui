/* ==========================================================================
   FieldSight Safety Page — Sprint 6.1 (middle column) / 6.2 (right detail)
   --------------------------------------------------------------------------
   /safety — cross-day rollup of safety_observations + topic-level
   safety_flags. Reads via the Sprint 6.0 compliance aggregator.

   Middle column:
     • Header — title + context line (range + row count)
     • Range toolbar (shared RangeToolbar composite — date-range batch
       Task B) — Today | Last 7 days | Last 30 days | All | Custom;
       default 'All' so the real report span (Feb–Mar 2026) is reachable
       even though "today" runs months ahead of the fixture data
     • KpiStrip — total flags · high-risk · sites affected · open vs
       closed
     • List — rows grouped by date desc, each item is a SafetyFlagRow.
       Click → set selectedFlag in SafetyContext.

   Right detail:
     • Sprint 6.1 ships a placeholder ('Select a flag…' message).
     • Sprint 6.2 replaces it with full-context inspection (status
       badge, observation, action, location, source-report link).

   Architecture mirrors /tasks (Sprint 4.2):
     SafetyProvider holds { status, mode, date, fromTo, rows, totals,
                            selectedFlag } via SafetyContext.

   Registers as window.FieldSight.PAGES['/safety']
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  /* ---------- Helpers --------------------------------------------------- */

  function fmtDate(yyyymmdd) {
    if (!yyyymmdd) return '';
    var p = String(yyyymmdd).split('-').map(Number);
    if (p.length !== 3) return yyyymmdd;
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return p[2] + ' ' + months[p[1] - 1] + ' ' + p[0];
  }

  function fmtDateLong(yyyymmdd) {
    if (!yyyymmdd) return '';
    var p = String(yyyymmdd).split('-').map(Number);
    if (p.length !== 3) return yyyymmdd;
    var months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
    var days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return days[d.getUTCDay()] + ', ' + p[2] + ' ' + months[p[1] - 1] + ' ' + p[0];
  }

  /* T6 — mirrors action-item-row.js's fmtCheckedAt (kept local rather than
     exported cross-layer: action-item-row.js is L5, this page-local copy
     avoids adding a new shared-helper surface for one page). Format ISO
     timestamp → "3 May, 2:14 pm" in NZ time. Returns '' on missing/
     unparseable input. */
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

  /* T7/G2 — resolved/closed rows sink to the bottom of their date group;
     unfinished rows keep their existing relative order. Array.sort is
     stable in evergreen browsers, and this comparator only ever
     distinguishes resolved-vs-not (no secondary tiebreaker), so it never
     reorders two rows on the same side of the resolved/unresolved split. */
  function isResolved(r) {
    return r.status === 'resolved' || r.status === 'closed';
  }

  function sinkResolved(rows) {
    return rows.slice().sort(function (a, b) {
      if (isResolved(a) === isResolved(b)) return 0;
      return isResolved(a) ? 1 : -1;
    });
  }

  function groupByDate(rows) {
    var byDate = {};
    rows.forEach(function (r) {
      if (!byDate[r.date]) byDate[r.date] = [];
      byDate[r.date].push(r);
    });
    return Object.keys(byDate).sort().reverse().map(function (date) {
      return { date: date, rows: sinkResolved(byDate[date]) };
    });
  }

  function totalsFromRows(rows) {
    var sites = {};
    var high = 0, openCt = 0, closedCt = 0;
    rows.forEach(function (r) {
      if (r.site) sites[r.site] = true;
      if (r.risk_level === 'high') high += 1;
      if (r.status === 'resolved') closedCt += 1;
      else openCt += 1;
    });
    return {
      total: rows.length,
      high:  high,
      sites: Object.keys(sites).length,
      open:  openCt,
      closed: closedCt,
    };
  }

  /* ---------- SafetyContext --------------------------------------------- */

  var SafetyContext = React.createContext(null);

  /* fs.settings.safetyView now holds { preset, from, to } — persisted and
     restored by the shared RangeToolbar composite itself (Task B), which
     also tolerates the pre-Task-B { mode, day } shape. Default preset
     'all' widens discovery back to the real report span (Feb–Mar 2026)
     instead of the last-7-days window, which used to come up empty since
     "today" runs months ahead of the fixture data. */
  function SafetyProvider(props) {
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
    var depKey = (caller.name || '') + '|' + (caller.role || '') + '|' + (caller.isAdmin ? 'admin' : '');

    var refView = React.useState({ preset: 'all', from: null, to: null });
    var view    = refView[0];
    var setView = refView[1];

    var refState = React.useState({ status: 'loading' });
    var state    = refState[0];
    var setState = refState[1];

    var retryRef   = React.useState(0);
    var retryCount = retryRef[0];
    var setRetry   = retryRef[1];

    /* batch A2 Task 4 — read the global active-site selection; passed
       EXPLICITLY into the aggregator call below (never read inside the
       aggregator itself — see compliance-aggregator.js _AUDIT note). */
    var refActiveSite = React.useState(function () { return (window.FS && window.FS.siteContext) ? window.FS.siteContext.get() : null; });
    var activeSite    = refActiveSite[0];
    var setActiveSite = refActiveSite[1];
    React.useEffect(function () {
      if (!(window.FS && window.FS.siteContext)) return undefined;
      return window.FS.siteContext.onChange(setActiveSite);
    }, []);

    React.useEffect(function () {
      /* RangeToolbar resolves the range asynchronously (e.g. 'all' needs
         FS.api.window.getSpan()) — wait for both ends before fetching. */
      if (!view.from || !view.to) return undefined;
      var cancelled = false;
      setState({ status: 'loading' });

      window.FS.api.compliance.getSafetyRange({
        from: view.from, to: view.to, site: activeSite || undefined,
      }).then(function (res) {
        if (cancelled) return;
        if (res && res._accessDenied) {
          setState({ status: 'access_denied', message: res.error });
          return;
        }
        var rows = (res && res.rows) || [];
        setState({
          status:  'ok',
          rows:    rows,
          from:    view.from,
          to:      view.to,
          totals:  totalsFromRows(rows),
          groups:  groupByDate(rows),
          dates:   (res && res.dates) || [],
          user:    res.user || null,
        });
      }).catch(function (err) {
        if (cancelled) return;
        setState({ status: 'error', error: { code: (err && err.status) || 0, message: (err && err.message) || 'Could not load safety data', retryable: true }, retry: function () { setRetry(function (n) { return n + 1; }); } });
      });

      return function () { cancelled = true; };
    }, [depKey, view.from, view.to, retryCount, activeSite]);

    var refSel = React.useState(null);
    var sel    = refSel[0];
    var setSel = refSel[1];

    var refCreate = React.useState(false);
    var showCreate = refCreate[0];
    var setShowCreate = refCreate[1];

    var ctx = {
      state:         state,
      setState:      setState,
      view:          view,
      setView:       function (next) { setSel(null); setView(next); },
      selectedFlag:  sel,
      setSelected:   setSel,
      showCreate:    showCreate,
      setShowCreate: setShowCreate,
      caller:        caller,
      /* batch B Task 6 — manual Mark closed/Reopen action refetches the
         range (rather than patching rows locally) so the merged manual
         row comes back through the same toManualSafetyRow() mapping. */
      refetch:       function () { setRetry(function (n) { return n + 1; }); },
    };
    return React.createElement(SafetyContext.Provider, { value: ctx },
      props.children);
  }

  /* ---------- Middle column -------------------------------------------- */

  function SafetyMiddleColumn(props) {
    var fs                 = window.FieldSight;
    var KpiStrip           = fs.KpiStrip;
    var StatCard           = fs.StatCard;
    var SafetyFlagRow      = fs.SafetyFlagRow;
    var SafetyCreateModal  = fs.SafetyCreateModal;
    var Badge              = fs.Badge;
    var AccessDenied       = fs.AccessDenied;
    var Button             = fs.Button;
    var RangeToolbar       = fs.RangeToolbar;

    var ctx      = React.useContext(SafetyContext);
    var state    = ctx && ctx.state;
    var onSelect = props.onSelect || function () {};

    /* T4 — Multi-Select toggle + bulk "Mark Resolved" for the middle-
       column list, reusing the SAME useMultiSelect hook /today's
       Leftover section uses (scripts/composites/multi-select-list.js).
       `items` has to be known before the useMultiSelect() call, and
       hook calls must stay unconditional per rules-of-hooks — so the
       flattened, currently-rendered row order is computed defensively
       here (state may not be 'ok' yet) rather than after the status
       early-returns below.

       Batch-eligible = "report-derived" rows only (source !== 'manual'
       && source !== 'live') — mirrors the exact same gate the single-
       row "Mark resolved" button already uses in SafetyRightDetail
       below (manual/live rows have no actions-toggle join to piggyback;
       "SKIP manual observations — they have no batch backend" per the
       task brief). Manual/live rows simply don't enter the selectable
       set — clicking them in batch mode keeps opening the detail panel,
       same as before this feature existed. */
    var groupsEarly = (state && state.status === 'ok') ? (state.groups || []) : [];
    var flatRows = [];
    groupsEarly.forEach(function (g) { flatRows = flatRows.concat(g.rows); });
    var batchEligibleRows = flatRows.filter(function (r) { return r.source !== 'manual' && r.source !== 'live'; });

    var multiSelect = window.FieldSight.useMultiSelect({
      items: batchEligibleRows,
      getId: function (r) { return r.id; },
    });

    /* Guards the bulk "Mark Resolved" button against double-submit
       while the pooled toggleAction batch is in flight. Mirrors
       today.js's resolvingRef. */
    var refBulkResolving = React.useState(false);
    var bulkResolving    = refBulkResolving[0];
    var setBulkResolving = refBulkResolving[1];

    if (!ctx) {
      console.warn('[SafetyMiddleColumn] SafetyContext missing');
      return null;
    }

    /* Gate: only hse_manager or site_manager (or admin) can raise new observations. */
    var caller  = ctx.caller || {};
    var canCreate = !!(window.FS && window.FS.can &&
      (window.FS.can(caller, 'safety:manage') ||
       window.FS.can(caller, 'site:manage') ||
       (caller.isAdmin)));

    /* Header is always visible — toolbar should be reachable even
       during loading/empty states. */
    var raiseBtn = (canCreate && SafetyCreateModal)
      ? React.createElement('button', {
          type:      'button',
          className: 'fs-safety__raise-btn',
          onClick:   function () { ctx.setShowCreate(true); },
        }, '+ Raise Observation')
      : null;

    /* T4 — "Multi-Select" toggle, shared .fs-multi-select__toggle classes
       (same ones /today's Leftover "Batch Select" toggle uses). Reachable
       whenever the list has at least one batch-eligible row, independent
       of canCreate. */
    var multiToggleBtn = React.createElement('button', {
      type:            'button',
      className:       'fs-multi-select__toggle'
        + (multiSelect.batchMode ? ' fs-multi-select__toggle--active' : ''),
      onClick:         function () { multiSelect.setBatchMode(function (prev) { return !prev; }); },
      'aria-pressed':  multiSelect.batchMode,
    }, multiSelect.batchMode ? 'Multi-Select: On' : 'Multi-Select');

    var header = React.createElement('div', { className: 'fs-safety__header' },
      React.createElement('div', { className: 'fs-safety__header-top' },
        React.createElement('div', null,
          React.createElement('h2', { className: 'fs-safety__title' }, 'Safety'),
          React.createElement('div', { className: 'fs-safety__subtitle' },
            'Flags and observations across your accessible reports'),
        ),
        React.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          multiToggleBtn, raiseBtn,
        ),
      ),
    );
    var toolbar = RangeToolbar
      ? React.createElement(RangeToolbar, {
          value:      ctx.view,
          onChange:   ctx.setView,
          presets:    ['today', '7d', '30d', 'all', 'custom'],
          storageKey: 'fs.settings.safetyView',
        })
      : null;

    if (state.status === 'loading') {
      return React.createElement('div', { className: 'fs-safety' },
        header, toolbar,
        React.createElement('div', { className: 'fs-safety__loading' },
          'Loading safety data…'),
      );
    }
    if (state.status === 'error') {
      var ErrorBanner = window.FieldSight.ErrorBanner;
      return React.createElement('div', { className: 'fs-safety' },
        header, toolbar,
        ErrorBanner
          ? React.createElement(ErrorBanner, {
              message:   (state.error && state.error.message) || 'Could not load safety data',
              retryable: true,
              onRetry:   state.retry,
            })
          : React.createElement('div', { className: 'fs-safety__empty' },
              (state.error && state.error.message) || 'Could not load safety data'),
      );
    }
    if (state.status === 'access_denied') {
      return React.createElement('div', { className: 'fs-safety' },
        header,
        AccessDenied
          ? React.createElement(AccessDenied, {
              scope:   'safety data',
              message: state.message,
            })
          : React.createElement('div', null, 'Access denied.'),
      );
    }

    var totals = state.totals || { total: 0, high: 0, sites: 0, open: 0, closed: 0 };
    var groups = state.groups || [];
    var rangeLabel = state.from === state.to
      ? fmtDate(state.from)
      : fmtDate(state.from) + ' → ' + fmtDate(state.to);

    /* Callback when a new observation is successfully created: prepend
       to the provider's list so it appears immediately without a reload. */
    function handleNewFlag(newFlag) {
      ctx.setShowCreate(false);
      if (ctx.setState && newFlag) {
        ctx.setState(function (s) {
          if (s.status !== 'ok') return s;
          var updatedRows = [newFlag].concat(s.rows || []);
          return Object.assign({}, s, {
            rows:   updatedRows,
            totals: totalsFromRows(updatedRows),
            groups: groupByDate(updatedRows),
          });
        });
      }
    }

    /* T4 — bulk "Mark Resolved", piggybacking the SAME actions-toggle
       endpoint SafetyRightDetail's single-row toggleResolve() uses
       (compliance-aggregator.js _AUDIT-2), applied per selected
       report-derived row instead of one at a time. Manual/live rows
       never reach here (excluded from batchEligibleRows above, so they
       can't be selected). Already-resolved rows in the selection are
       silently skipped (nothing to do) rather than re-submitted.
       Partial failure mirrors today.js's bulkResolveLeftover: a failed
       toggle keeps that row selected (multiSelect.setSelectedIds retains
       it) for a retry; successes are dropped from the selection AND
       patched to 'resolved' in the row list (so they sink via
       sinkResolved on the next render — Task 4/T7). */
    function bulkMarkResolved() {
      var candidates = multiSelect.selectedItems.filter(function (r) { return !isResolved(r); });
      if (bulkResolving || candidates.length === 0) return;
      var api = window.FS && window.FS.api;
      if (!api || !api.actions || !api.pooledAll) return;

      setBulkResolving(true);

      var thunks = candidates.map(function (row) {
        return function () {
          var idxMatch = String(row.id || '').match(
            row.source === 'topic_flag' ? /_flag_(\d+)$/ : /_obs_(\d+)$/
          );
          if (!idxMatch) return Promise.resolve({ ok: false, row: row });
          var actionIndex = (row.source === 'topic_flag' ? 'flag_' : 'obs_') + idxMatch[1];
          return api.actions.toggleAction({
            date:         row.date,
            topic_id:     row.topic_id,
            action_index: actionIndex,
            checked:      true,
            action_text:  row.observation,
            user_folder:  row.user_folder,
          }).then(function () { return { ok: true, row: row }; })
            .catch(function (err) {
              console.error('[Safety] bulk resolve failed for', row.id, err);
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

        if (ctx.setState && okCount > 0) {
          ctx.setState(function (s) {
            if (s.status !== 'ok') return s;
            var updatedRows = (s.rows || []).map(function (r) {
              return okIds[r.id] ? Object.assign({}, r, { status: 'resolved' }) : r;
            });
            return Object.assign({}, s, {
              rows:   updatedRows,
              totals: totalsFromRows(updatedRows),
              groups: groupByDate(updatedRows),
            });
          });
        }

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
            message: 'Resolved ' + okCount + ' flag' + (okCount === 1 ? '' : 's'),
            tone:    'success',
          });
        } else if (okCount === 0) {
          toast.show({
            message: 'Could not resolve ' + failCount + ' flag' + (failCount === 1 ? '' : 's') + ' — try again',
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

    return React.createElement('div', { className: 'fs-safety' },
      header,
      toolbar,

      /* Create observation modal (Sprint 8.1.2)
         Batch B Task 5 — live mode sources siteId from the global
         FS.siteContext (the report-side project slug), NOT state.user
         (a user-scoping value from the aggregator that happened to be
         admin-null, which is what made the old fixtures[0] fallback
         WRONG for admin in live). When siteContext has nothing anchored,
         the modal itself collects a Project via its required select.
         Mock mode keeps the pre-existing fixtures[0] fallback verbatim. */
      ctx.showCreate && SafetyCreateModal
        ? React.createElement(SafetyCreateModal, {
            siteId:    !window.FS.api.useMocks
                       ? ((window.FS.siteContext && window.FS.siteContext.get()) || '')
                       : (state.user
                          || (((window.FieldSight && window.FieldSight.fixtures
                               && window.FieldSight.fixtures.sites
                               && window.FieldSight.fixtures.sites.sites) || [])[0] || {}).site_id
                          || ''),
            onSuccess: handleNewFlag,
            onCancel:  function () { ctx.setShowCreate(false); },
          })
        : null,

      /* Meta line */
      React.createElement('div', { className: 'fs-safety__meta' },
        totals.total + (totals.total === 1 ? ' flag · ' : ' flags · ') + rangeLabel),

      /* T4 — bulk action bar, shown whenever Multi-Select mode is on
         (shared MultiSelectBulkBar composite — same one /today's
         Leftover section uses). "Select all" only ever selects
         batch-eligible (report-derived) rows, since that's the `items`
         useMultiSelect was constructed with above. */
      multiSelect.batchMode
        ? React.createElement(fs.MultiSelectBulkBar, {
            count:   multiSelect.selectedItems.length,
            actions: [
              { key: 'select-all', label: 'Select all', onClick: multiSelect.selectAll, disabled: bulkResolving },
              { key: 'resolve', primary: true, onClick: bulkMarkResolved,
                disabled: bulkResolving || multiSelect.selectedItems.length === 0,
                label: bulkResolving ? 'Resolving…' : 'Mark Resolved (' + multiSelect.selectedItems.length + ')' },
              { key: 'clear', label: 'Clear', onClick: multiSelect.clear, disabled: bulkResolving },
            ],
          })
        : null,

      /* KPI strip */
      React.createElement(KpiStrip, null,
        React.createElement(StatCard, { value: totals.total, label: 'Total flags' }),
        React.createElement(StatCard, {
          value: totals.high, label: 'High risk',
          tone:  totals.high > 0 ? 'danger' : 'neutral',
        }),
        React.createElement(StatCard, { value: totals.sites, label: 'Sites affected' }),
        React.createElement(StatCard, {
          /* Sprint 6.6.2 — visual order: closed first (resolved/safe
             reads as the desirable end-state). Tone still keyed on
             `open` since "open issues" is the alarm signal. */
          value: totals.closed + ' / ' + totals.open,
          label: 'Closed / open',
          tone:  totals.open > 0 ? 'warning' : 'success',
        }),
      ),

      /* Grouped list */
      groups.length === 0
        ? React.createElement('div', { className: 'fs-safety__empty' },
            'No safety flags in this window.')
        : React.createElement('div', { className: 'fs-safety__groups' },
            groups.map(function (g) {
              return React.createElement('div', { key: g.date, className: 'fs-safety__group' },
                React.createElement('div', { className: 'fs-safety__group-header' },
                  React.createElement('span', { className: 'fs-safety__group-date' },
                    fmtDateLong(g.date)),
                  React.createElement('span', { className: 'fs-safety__group-count' },
                    g.rows.length + (g.rows.length === 1 ? ' flag' : ' flags')),
                ),
                React.createElement('div', { className: 'fs-safety__group-rows' },
                  g.rows.map(function (row) {
                    var isSel = ctx.selectedFlag && ctx.selectedFlag.id === row.id;
                    /* T4 — batch-eligible = report-derived (source !==
                       'manual' && source !== 'live'); only these rows
                       toggle into the selection while Multi-Select mode
                       is on. Ineligible rows keep opening the detail
                       panel regardless of batchMode — no fake selection
                       affordance offered for a row with no batch
                       backend. */
                    var batchEligible = row.source !== 'manual' && row.source !== 'live';
                    var batchSelected = multiSelect.batchMode && batchEligible && !!multiSelect.selectedIds[row.id];
                    return React.createElement('button', {
                      key:       row.id,
                      type:      'button',
                      className: 'fs-safety__row-btn'
                        + (isSel ? ' fs-safety__row-btn--active' : '')
                        + (isResolved(row) ? ' fs-row--resolved' : '')
                        + (batchSelected ? ' fs-row--batch-selected' : ''),
                      onClick:   function (e) {
                        if (multiSelect.batchMode && batchEligible) {
                          multiSelect.onItemClick(row, e);
                          return;
                        }
                        ctx.setSelected(row);
                        onSelect({ kind: 'safety_flag', id: row.id, row: row });
                      },
                    },
                      React.createElement(SafetyFlagRow, {
                        flag: {
                          observation:        row.observation,
                          risk_level:         row.risk_level,
                          recommended_action: row.recommended_action,
                          location:           row.location,
                          who_raised:         row.who_raised,
                          source:             row.source,
                        },
                        dense: true,
                      }),
                      React.createElement('div', { className: 'fs-safety__row-meta' },
                        row.topic_title !== 'Site safety observations'
                          ? React.createElement('span', { className: 'fs-safety__row-topic' },
                              'From: ' + row.topic_title)
                          : null,
                      ),
                    );
                  }),
                ),
              );
            }),
          ),
    );
  }

  /* ---------- Right detail (Sprint 6.2 — full inspection panel) -------- */

  var RISK_TONE   = { high: 'danger', medium: 'warning', low: 'neutral' };
  var STATUS_TONE = { open: 'warning', resolved: 'success' };

  function DetailRow(props) {
    return React.createElement('div', { className: 'fs-safety-detail__row' },
      React.createElement('div', { className: 'fs-safety-detail__row-label' },
        props.label),
      React.createElement('div', { className: 'fs-safety-detail__row-value' },
        props.value),
    );
  }

  function SafetyRightDetail(props) {
    var fs       = window.FieldSight;
    var Card     = fs.Card;
    var Badge    = fs.Badge;
    var Button   = fs.Button;
    var IconBtn  = fs.IconButton;

    var ctx = React.useContext(SafetyContext);
    var sel = ctx && ctx.selectedFlag;
    var caller = (ctx && ctx.caller) || {};

    /* Task 2 (live-data fixes) — resolve/reopen toggle, piggybacking the
       existing actions-toggle endpoint (see compliance-aggregator.js
       _AUDIT-2). Mirrors action-item-row.js's optimistic pattern: flip
       local state immediately, fire toggleAction, revert on reject. */
    var refPending = React.useState(false);
    var togglePending = refPending[0];
    var setTogglePending = refPending[1];

    function toggleResolve() {
      if (!sel || togglePending) return;
      var idxMatch = String(sel.id || '').match(
        sel.source === 'topic_flag' ? /_flag_(\d+)$/ : /_obs_(\d+)$/
      );
      if (!idxMatch) return;  /* unexpected id shape — no-op, guard only */
      var actionIndex = (sel.source === 'topic_flag' ? 'flag_' : 'obs_') + idxMatch[1];
      var prevSel   = sel;
      var nextStatus = prevSel.status === 'resolved' ? 'open' : 'resolved';
      var nextSel   = Object.assign({}, prevSel, { status: nextStatus });
      /* T6 — reopen clears the resolver line immediately (spec: show only
         the latest Resolved). A fresh resolve does NOT set resolvedBy/
         resolvedAt optimistically — owner-vs-caller guardrail means the
         operator name may ONLY come from the API response (never a local
         AuthMock/session read), so it's filled in once toggleAction
         resolves below. */
      if (nextStatus === 'open') {
        nextSel.resolvedBy = null;
        nextSel.resolvedAt = null;
      }

      function applyStatus(rowId, status) {
        if (!ctx.setState) return;
        ctx.setState(function (s) {
          if (s.status !== 'ok') return s;
          var updatedRows = (s.rows || []).map(function (r) {
            return r.id === rowId ? Object.assign({}, r, { status: status }) : r;
          });
          return Object.assign({}, s, {
            rows:   updatedRows,
            totals: totalsFromRows(updatedRows),
            groups: groupByDate(updatedRows),
          });
        });
      }

      setTogglePending(true);
      if (ctx.setSelected) ctx.setSelected(nextSel);
      applyStatus(prevSel.id, nextStatus);

      window.FS.api.actions.toggleAction({
        date:         sel.date,
        topic_id:     sel.topic_id,
        action_index: actionIndex,
        checked:      nextStatus === 'resolved',
        action_text:  sel.observation,
        user_folder:  sel.user_folder,
      }).then(function (res) {
        setTogglePending(false);
        /* T6 — capture the resolver from the API response ONLY (never
           AuthMock/session — owner ≠ caller). Functional update + id
           guard so a stale response can't clobber a since-changed
           selection. Reopen already cleared these above; skip the
           write there so we don't resurrect them from a slow response. */
        if (nextStatus === 'resolved' && ctx.setSelected) {
          var resolvedBy = (res && res.checked_by) || null;
          var resolvedAt = (res && res.checked_at) || null;
          ctx.setSelected(function (cur) {
            if (!cur || cur.id !== prevSel.id) return cur;
            return Object.assign({}, cur, {
              resolvedBy: resolvedBy,
              resolvedAt: resolvedAt,
            });
          });
        }
      }).catch(function (err) {
        console.error('[SafetyRightDetail] resolve toggle failed, reverting', err);
        setTogglePending(false);
        if (ctx.setSelected) ctx.setSelected(prevSel);
        applyStatus(prevSel.id, prevSel.status);
      });
    }

    /* batch B Task 6 — Mark closed/Reopen for manually-raised observations
       (source === 'manual', merged in by compliance-aggregator.js from
       org.getObservations). Distinct from toggleResolve() above: manual
       rows don't have the report-derived id shape ('<date>_flag_<idx>' /
       '<date>_obs_<idx>') that toggleResolve's action-index regex needs,
       and they use org.updateObservation({status:'open'|'closed'}) — a
       different endpoint/vocabulary than the actions-toggle join. Gated
       to the author or an admin/gm caller (mirrors team.js's
       user:manage-gated archive pattern). No optimistic row-list flip —
       just an immediate local `sel` update for a responsive detail panel,
       plus a full range refetch so the list (and its Manual badge/status)
       comes back through the real toManualSafetyRow() mapping. */
    var refManualPending = React.useState(false);
    var manualPending    = refManualPending[0];
    var setManualPending = refManualPending[1];

    var sessionSub = ((window.FS && window.FS.session && window.FS.session.user) || {}).sub;
    var canManageManual = !!(sel && sel.source === 'manual' && window.FS.can && (
      window.FS.can(caller, 'user:manage') ||
      (sel.author_sub && sel.author_sub === sessionSub)
    ));

    function toggleManualStatus() {
      if (!sel || sel.source !== 'manual' || manualPending) return;
      var prevSel    = sel;
      var nextClosed = !prevSel.closed;

      setManualPending(true);
      window.FS.api.org.updateObservation(prevSel.obs_id, {
        status: nextClosed ? 'closed' : 'open',
      }).then(function (res) {
        /* 403/404 resolve as envelopes (Fable batch-B review F3): a PM whose
           UI gate is broader than the backend's author-or-admin/gm rule must
           see the rejection, not a fake success. */
        if (res && (res._accessDenied || res._notFound)) {
          throw new Error(res.error || 'You cannot update this observation');
        }
        setManualPending(false);
        if (ctx.setSelected) {
          ctx.setSelected(Object.assign({}, prevSel, {
            closed: nextClosed,
            status: nextClosed ? 'resolved' : 'open',
          }));
        }
        var toast = window.FS && window.FS.toast;
        if (toast) {
          toast.show({
            message: nextClosed ? 'Observation marked closed.' : 'Observation reopened.',
            tone:    'success',
          });
        }
        if (ctx.refetch) ctx.refetch();
      }).catch(function (err) {
        console.error('[SafetyRightDetail] manual status update failed', err);
        setManualPending(false);
        var toast = window.FS && window.FS.toast;
        if (toast) {
          toast.show({
            message: (err && err.message) || 'Could not update observation',
            tone:    'error',
          });
        }
      });
    }

    /* Lazy-fetch related action_items from the source topic. Mirrors
       the linked-actions lazy-fetch from programme.js:805-881. The
       source topic carries N action_items — we surface them as
       click-through chips so the field user can jump from a flag to
       any related corrective action in one tap. */
    var refLinks = React.useState({ status: 'idle', items: [] });
    var linksS   = refLinks[0];
    var setLinks = refLinks[1];

    React.useEffect(function () {
      /* Skip lookup for report-level safety_observations — those don't
         carry a topic_id (we set it to -1 in the aggregator). */
      if (!sel || sel.topic_id == null || sel.topic_id < 0 || !sel.date) {
        setLinks({ status: 'ok', items: [] });
        return undefined;
      }
      var cancelled = false;
      setLinks({ status: 'loading', items: [] });

      window.FS.api.timeline.getTimeline({ date: sel.date, user: sel.user_folder })
        .then(function (r) {
          if (cancelled) return;
          if (!r || r._notFound || r.available_users) {
            setLinks({ status: 'ok', items: [] });
            return;
          }
          var topic = (r.topics || []).filter(function (t) {
            return t.topic_id === sel.topic_id;
          })[0];
          var actions = topic ? (topic.action_items || []) : [];
          setLinks({
            status: 'ok',
            items:  actions.map(function (a, idx) {
              return {
                action_index: idx,
                text:         a.action,
                responsible:  a.responsible || null,
                priority:     a.priority || null,
              };
            }),
          });
        })
        .catch(function () {
          if (!cancelled) setLinks({ status: 'error', items: [] });
        });

      return function () { cancelled = true; };
    }, [sel && sel.id]);

    if (!sel) {
      return React.createElement('div', { className: 'fs-safety-detail__placeholder' },
        React.createElement('div', { className: 'fs-safety-detail__placeholder-title' },
          'Select a flag'),
        React.createElement('div', { className: 'fs-safety-detail__placeholder-body' },
          'Pick any flag in the list to see its full detail and source report.'),
      );
    }

    function onOpenInTimeline() {
      /* Sprint 6.6.4 — append &topic=N for topic-source rows so the
         timeline page lands in focus mode (target topic auto-opens
         and flashes; others force-collapse). Observation rows skip
         the topic param since they're report-level — the user lands
         on the daily report's overview without a focal point.

         Sprint 6.7.2 — for topic_flag source, also append &flag=<idx>
         so the precision spotlight lands on the specific flag inside
         the topic's safety_flags[] (not just the whole topic card).
         Flag idx is the trailing number in the row id, format
         '<date>_<topic_id>_flag_<idx>'. */
      var qs = '?date=' + encodeURIComponent(sel.date);
      if (sel.user_folder) qs += '&user=' + encodeURIComponent(sel.user_folder);
      if (sel.topic_id != null && sel.topic_id >= 0) {
        qs += '&topic=' + encodeURIComponent(sel.topic_id);
        if (sel.source === 'topic_flag') {
          var m = String(sel.id || '').match(/_flag_(\d+)$/);
          if (m) qs += '&flag=' + encodeURIComponent(m[1]);
        }
      }
      window.FS.Router.navigate('/timeline' + qs);
    }

    var risk = (sel.risk_level || 'medium').toLowerCase();
    var riskBadge = React.createElement(Badge, {
      tone: RISK_TONE[risk] || 'neutral', size: 'sm', prefixDot: true,
    }, risk.charAt(0).toUpperCase() + risk.slice(1) + ' risk');

    var statusBadge = React.createElement(Badge, {
      tone: STATUS_TONE[sel.status] || 'neutral', size: 'sm', variant: 'outline',
    }, (sel.status || 'open').charAt(0).toUpperCase() + (sel.status || 'open').slice(1));

    /* batch B Task 6 — 'manual' added alongside the two report-derived
       sources; previously fell through to the 'Topic safety flag' label,
       which is wrong for a manually-raised observation.
       Fable-review F3 — 'live' added alongside; previously also fell
       through to 'Topic safety flag', which is wrong for a session-
       sourced live extraction. */
    var sourceLabel = sel.source === 'observation'
      ? 'Site-level observation'
      : sel.source === 'manual'
        ? 'Manually raised observation'
        : sel.source === 'live'
          ? 'Live extraction'
          : 'Topic safety flag';

    /* Build the field rows — skip rows whose value is null, since the
       two source shapes carry different fields. */
    var rows = [];
    if (sel.recommended_action) {
      rows.push(React.createElement(DetailRow, {
        key: 'action', label: 'Action', value: sel.recommended_action,
      }));
    }
    if (sel.location) {
      rows.push(React.createElement(DetailRow, {
        key: 'location', label: 'Location', value: sel.location,
      }));
    }
    if (sel.who_raised) {
      rows.push(React.createElement(DetailRow, {
        key: 'who', label: 'Raised by', value: sel.who_raised,
      }));
    }
    rows.push(React.createElement(DetailRow, {
      key: 'date', label: 'Date', value: fmtDateLong(sel.date),
    }));
    if (sel.topic_id >= 0) {
      rows.push(React.createElement(DetailRow, {
        key: 'topic', label: 'From topic', value: sel.topic_title,
      }));
    }
    if (sel.user_name) {
      rows.push(React.createElement(DetailRow, {
        key: 'reporter', label: 'Reporter', value: sel.user_name,
      }));
    }
    if (sel.site) {
      rows.push(React.createElement(DetailRow, {
        key: 'site', label: 'Site', value: sel.site,
      }));
    }
    rows.push(React.createElement(DetailRow, {
      key: 'source', label: 'Source', value: sourceLabel,
    }));
    /* T6 — report-derived rows only (topic_flag/observation/live all flow
       through toggleResolve above). Manual observations (source==='manual')
       go through toggleManualStatus → org.updateObservation, which carries
       no operator identity — sel.resolvedBy stays unset for them, so this
       row correctly stays hidden (Phase 2 territory; don't fabricate one
       from AuthMock.currentUser). Shows only the latest resolve — cleared
       on Reopen in toggleResolve. */
    if (sel.status === 'resolved' && sel.resolvedBy) {
      rows.push(React.createElement(DetailRow, {
        key: 'resolved-by', label: 'Resolved by',
        value: sel.resolvedBy
          + (fmtCheckedAt(sel.resolvedAt) ? ' · ' + fmtCheckedAt(sel.resolvedAt) : ''),
      }));
    }

    /* Sprint 6.6.3 — photos block, rendered between field rows and
       linked actions. Topic-flag rows carry related_photos from the
       aggregator; observation rows are report-level and don't have a
       specific topic to lift photos from. */
    var photosBlock = null;
    var PhotoGrid   = fs.PhotoGrid;
    var photos      = (sel.related_photos || []);
    if (photos.length > 0 && PhotoGrid) {
      photosBlock = React.createElement('div', { className: 'fs-safety-detail__photos' },
        React.createElement('div', { className: 'fs-safety-detail__photos-label' },
          'Photos · ' + photos.length),
        React.createElement(PhotoGrid, {
          photos:           photos,
          userDisplayName:  sel.user_name,
          date:             sel.date,
          variant:          'carousel',
        }),
      );
    }

    /* Linked-actions block — only shown for topic-flag rows (since
       observation rows don't have a topic to lift action_items from). */
    var linkedBlock = null;
    if (sel.topic_id >= 0) {
      if (linksS.status === 'loading') {
        linkedBlock = React.createElement('div', { className: 'fs-safety-detail__linked' },
          React.createElement('div', { className: 'fs-safety-detail__linked-label' },
            'Related actions'),
          React.createElement('div', { className: 'fs-safety-detail__linked-loading' },
            'Loading…'),
        );
      } else if (linksS.items.length > 0) {
        linkedBlock = React.createElement('div', { className: 'fs-safety-detail__linked' },
          React.createElement('div', { className: 'fs-safety-detail__linked-label' },
            'Related actions in this topic'),
          React.createElement('div', { className: 'fs-safety-detail__linked-items' },
            linksS.items.map(function (it) {
              return React.createElement('div', {
                key:       it.action_index,
                className: 'fs-safety-detail__linked-chip',
              },
                React.createElement('div', { className: 'fs-safety-detail__linked-text' },
                  it.text),
                it.responsible
                  ? React.createElement('div', { className: 'fs-safety-detail__linked-meta' },
                      it.responsible + (it.priority ? ' · ' + it.priority : ''))
                  : null,
              );
            }),
          ),
        );
      }
    }

    return React.createElement('div', { className: 'fs-safety-detail' },

      /* Header */
      React.createElement('div', { className: 'fs-safety-detail__header' },
        React.createElement('div', { className: 'fs-safety-detail__header-main' },
          React.createElement('h2', { className: 'fs-safety-detail__title' },
            sel.observation),
          React.createElement('div', { className: 'fs-safety-detail__metaline' },
            riskBadge, statusBadge,
          ),
        ),
        IconBtn ? React.createElement(IconBtn, {
          icon: 'x', ariaLabel: 'Close detail', size: 'sm',
          onClick: function () {
            if (ctx && ctx.setSelected) ctx.setSelected(null);
            if (props.onClose) props.onClose();
          },
        }) : null,
      ),

      /* Field rows */
      React.createElement('div', { className: 'fs-safety-detail__rows' }, rows),

      /* Photos (Sprint 6.6.3) */
      photosBlock,

      /* Linked actions */
      linkedBlock,

      /* Footer actions
         batch B Task 6 — manual rows get the author/admin-gated Mark
         closed/Reopen action instead of the generic resolve button: its
         id doesn't match toggleResolve()'s action-index regex, so that
         button would silently no-op for them.
         Fable-review F3 — 'live' rows excluded the same way: their id is
         'live_<uuid>', which also doesn't match toggleResolve()'s
         /_obs_(\d+)$/ regex (no-op), and they have no source report yet
         to open (the nightly report hasn't landed) — Open source report
         would navigate to a "_notFound" timeline. */
      React.createElement('div', { className: 'fs-safety-detail__actions' },
        (sel.source !== 'manual' && sel.source !== 'live' && Button) ? React.createElement(Button, {
          variant: 'primary', size: 'sm', loading: togglePending,
          onClick: toggleResolve,
        }, sel.status === 'resolved' ? 'Reopen' : 'Mark resolved') : null,
        (sel.source === 'manual' && canManageManual && Button) ? React.createElement(Button, {
          variant: 'primary', size: 'sm', loading: manualPending,
          onClick: toggleManualStatus,
        }, sel.closed ? 'Reopen' : 'Mark closed') : null,
        /* Manual observations have no source report — the link would land on
           a "_notFound" timeline (batch B review). Same for 'live' rows
           (Fable-review F3) — see comment above. */
        (sel.source !== 'manual' && sel.source !== 'live') ? React.createElement(Button, {
          variant: 'secondary', size: 'sm', rightIcon: 'arrow-right',
          onClick: onOpenInTimeline,
        }, 'Open source report') : null,
      ),
    );
  }

  /* ---------- Register --------------------------------------------------- */

  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.PAGES) window.FieldSight.PAGES = {};
  window.FieldSight.PAGES['/safety'] = {
    Middle:   SafetyMiddleColumn,
    Right:    SafetyRightDetail,
    Provider: SafetyProvider,
  };

})();
