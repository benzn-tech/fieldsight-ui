/* ==========================================================================
   FieldSight Quality Page — Sprint 6.3 (middle) / 6.4 (right detail)
   --------------------------------------------------------------------------
   /quality — cross-day rollup of quality_and_compliance items + topics
   tagged category==='quality'. Reads via the Sprint 6.0 compliance
   aggregator. Mirrors /safety (Sprint 6.1/6.2) — same provider shape,
   same range toolbar, same KPI strip + grouped list pattern.

   Differences from /safety:
     • Items have a real `status` field from the fixture
       ('completed', 'concern', 'observed', etc) — no synthetic 'open'
     • `follow_up_needed` flag drives the warning KPI bucket
     • Rows render as plain Cards (no SafetyFlagRow equivalent — the
       quality item shape is simpler: title + details + status badge)

   Registers as window.FieldSight.PAGES['/quality']
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
    var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return days[d.getUTCDay()] + ', ' + p[2] + ' ' + months[p[1] - 1] + ' ' + p[0];
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

  /* Maps the fixture's status string → a Badge tone. Keep the set tight
     so we pick a deliberate tone on every entry; unknown shapes fall
     through to neutral. */
  function statusTone(status) {
    switch ((status || '').toLowerCase()) {
      case 'completed': return 'success';
      case 'pass':      return 'success';
      case 'concern':   return 'warning';
      case 'fail':      return 'danger';
      case 'blocked':   return 'danger';
      case 'observed':  return 'info';
      case 'resolved':  return 'success';
      default:          return 'neutral';
    }
  }

  function totalsFromRows(rows) {
    var sites = {};
    var followUp = 0, completed = 0;
    rows.forEach(function (r) {
      if (r.site) sites[r.site] = true;
      if (r.follow_up_needed) followUp += 1;
      if ((r.status || '').toLowerCase() === 'completed' ||
          (r.status || '').toLowerCase() === 'pass') completed += 1;
    });
    return {
      total:     rows.length,
      followUp:  followUp,
      sites:     Object.keys(sites).length,
      completed: completed,
    };
  }

  /* ---------- QualityContext ------------------------------------------- */

  var QualityContext = React.createContext(null);

  /* fs.settings.qualityView now holds { preset, from, to } — persisted and
     restored by the shared RangeToolbar composite itself (Task B), which
     also tolerates the pre-Task-B { mode, day } shape. Default preset
     'all' widens discovery back to the real report span (Feb–Mar 2026)
     instead of the last-7-days window, which used to come up empty since
     "today" runs months ahead of the fixture data. */
  function QualityProvider(props) {
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

      window.FS.api.compliance.getQualityRange({
        from: view.from, to: view.to, site: activeSite || undefined,
      }).then(function (res) {
        if (cancelled) return;
        if (res && res._accessDenied) {
          setState({ status: 'access_denied', message: res.error });
          return;
        }
        var rows = (res && res.rows) || [];
        setState({
          status: 'ok',
          rows:   rows,
          from:   view.from,
          to:     view.to,
          totals: totalsFromRows(rows),
          groups: groupByDate(rows),
          dates:  (res && res.dates) || [],
          user:   res.user || null,
        });
      }).catch(function (err) {
        if (cancelled) return;
        setState({ status: 'error', error: { code: (err && err.status) || 0, message: (err && err.message) || 'Could not load quality data', retryable: true }, retry: function () { setRetry(function (n) { return n + 1; }); } });
      });

      return function () { cancelled = true; };
    }, [depKey, view.from, view.to, retryCount, activeSite]);

    var refSel = React.useState(null);
    var sel    = refSel[0];
    var setSel = refSel[1];

    var refCreate  = React.useState(false);
    var showCreate = refCreate[0];
    var setShowCreate = refCreate[1];

    var ctx = {
      state:         state,
      setState:      setState,
      view:          view,
      setView:       function (next) { setSel(null); setView(next); },
      selectedItem:  sel,
      setSelected:   setSel,
      showCreate:    showCreate,
      setShowCreate: setShowCreate,
      caller:        caller,
      /* batch B Task 6 — manual Mark closed/Reopen action refetches the
         range (rather than patching rows locally) so the merged manual
         row comes back through the same toManualQualityRow() mapping. */
      refetch:       function () { setRetry(function (n) { return n + 1; }); },
    };
    return React.createElement(QualityContext.Provider, { value: ctx },
      props.children);
  }

  /* ---------- Middle column -------------------------------------------- */

  function QualityMiddleColumn(props) {
    var fs                  = window.FieldSight;
    var KpiStrip            = fs.KpiStrip;
    var StatCard            = fs.StatCard;
    var Badge               = fs.Badge;
    var AccessDenied        = fs.AccessDenied;
    var QualityCreateModal  = fs.QualityCreateModal;
    var Button              = fs.Button;
    var RangeToolbar        = fs.RangeToolbar;

    var ctx      = React.useContext(QualityContext);
    var state    = ctx && ctx.state;
    var onSelect = props.onSelect || function () {};

    /* T4 — Multi-Select toggle + bulk "Mark Resolved", reusing the SAME
       useMultiSelect hook /today's Leftover section and /safety use
       (scripts/composites/multi-select-list.js). `items` has to be
       known before the useMultiSelect() call, and hook calls must stay
       unconditional per rules-of-hooks — so the flattened, currently-
       rendered row order is computed defensively here (state may not
       be 'ok' yet) rather than after the status early-returns below.

       Batch-eligible = ONLY source === 'topic_quality' — narrower than
       /safety's "report-derived" gate. toggleResolve() below (the
       single-row "Mark resolved" button in QualityRightDetail) already
       explicitly skips 'qc_item' rows: they carry a REAL backend status
       field (not a synthetic open/resolved binary), so toggling them
       via the actions-toggle join would overwrite honest data — same
       reasoning applies to the batch path, so 'qc_item' rows (plus
       'manual'/'live', which have no batch backend either) are excluded
       from the selectable set entirely. */
    var groupsEarly = (state && state.status === 'ok') ? (state.groups || []) : [];
    var flatRows = [];
    groupsEarly.forEach(function (g) { flatRows = flatRows.concat(g.rows); });
    var batchEligibleRows = flatRows.filter(function (r) { return r.source === 'topic_quality'; });

    var multiSelect = window.FieldSight.useMultiSelect({
      items: batchEligibleRows,
      getId: function (r) { return r.id; },
    });

    /* Guards the bulk "Mark Resolved" button against double-submit
       while the pooled toggleAction batch is in flight. */
    var refBulkResolving = React.useState(false);
    var bulkResolving    = refBulkResolving[0];
    var setBulkResolving = refBulkResolving[1];

    if (!ctx) {
      console.warn('[QualityMiddleColumn] QualityContext missing');
      return null;
    }

    var caller    = ctx.caller || {};
    var canCreate = !!(window.FS && window.FS.can &&
      (window.FS.can(caller, 'quality:manage') ||
       window.FS.can(caller, 'site:manage') ||
       (caller.isAdmin)));

    var logBtn = (canCreate && QualityCreateModal)
      ? React.createElement('button', {
          type:      'button',
          className: 'fs-quality__log-btn',
          onClick:   function () { ctx.setShowCreate(true); },
        }, '+ Log Item')
      : null;

    /* T4 — "Multi-Select" toggle, shared .fs-multi-select__toggle
       classes (same ones /today's Leftover "Batch Select" toggle and
       /safety's "Multi-Select" toggle use). */
    var multiToggleBtn = React.createElement('button', {
      type:            'button',
      className:       'fs-multi-select__toggle'
        + (multiSelect.batchMode ? ' fs-multi-select__toggle--active' : ''),
      onClick:         function () { multiSelect.setBatchMode(function (prev) { return !prev; }); },
      'aria-pressed':  multiSelect.batchMode,
    }, multiSelect.batchMode ? 'Multi-Select: On' : 'Multi-Select');

    var header = React.createElement('div', { className: 'fs-quality__header' },
      React.createElement('div', { className: 'fs-quality__header-top' },
        React.createElement('div', null,
          React.createElement('h2', { className: 'fs-quality__title' }, 'Quality'),
          React.createElement('div', { className: 'fs-quality__subtitle' },
            'Quality & compliance items across your accessible reports'),
        ),
        React.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          multiToggleBtn, logBtn,
        ),
      ),
    );
    var toolbar = RangeToolbar
      ? React.createElement(RangeToolbar, {
          value:      ctx.view,
          onChange:   ctx.setView,
          presets:    ['today', '7d', '30d', 'all', 'custom'],
          storageKey: 'fs.settings.qualityView',
        })
      : null;

    if (state.status === 'loading') {
      return React.createElement('div', { className: 'fs-quality' },
        header, toolbar,
        React.createElement('div', { className: 'fs-quality__loading' },
          'Loading quality data…'),
      );
    }
    if (state.status === 'error') {
      var ErrorBanner = window.FieldSight.ErrorBanner;
      return React.createElement('div', { className: 'fs-quality' },
        header, toolbar,
        ErrorBanner
          ? React.createElement(ErrorBanner, {
              message:   (state.error && state.error.message) || 'Could not load quality data',
              retryable: true,
              onRetry:   state.retry,
            })
          : React.createElement('div', { className: 'fs-quality__empty' },
              (state.error && state.error.message) || 'Could not load quality data'),
      );
    }
    if (state.status === 'access_denied') {
      return React.createElement('div', { className: 'fs-quality' },
        header,
        AccessDenied
          ? React.createElement(AccessDenied, {
              scope:   'quality data',
              message: state.message,
            })
          : React.createElement('div', null, 'Access denied.'),
      );
    }

    var totals = state.totals || { total: 0, followUp: 0, sites: 0, completed: 0 };
    var groups = state.groups || [];
    var rangeLabel = state.from === state.to
      ? fmtDate(state.from)
      : fmtDate(state.from) + ' → ' + fmtDate(state.to);

    function handleNewItem(newItem) {
      ctx.setShowCreate(false);
      if (ctx.setState && newItem) {
        ctx.setState(function (s) {
          if (s.status !== 'ok') return s;
          var updatedRows = [newItem].concat(s.rows || []);
          return Object.assign({}, s, {
            rows:   updatedRows,
            totals: totalsFromRows(updatedRows),
            groups: groupByDate(updatedRows),
          });
        });
      }
    }

    /* T4 — bulk "Mark Resolved", piggybacking the SAME actions-toggle
       endpoint QualityRightDetail's single-row toggleResolve() uses,
       applied per selected topic_quality row instead of one at a time.
       qc_item/manual/live rows never reach here (excluded from
       batchEligibleRows above). Already-resolved rows in the selection
       are silently skipped rather than re-submitted. Partial failure
       mirrors today.js's bulkResolveLeftover / safety.js's
       bulkMarkResolved: a failed toggle keeps that row selected for
       retry; successes are dropped from the selection AND patched to
       'resolved' in the row list (so they sink via sinkResolved on the
       next render — Task 4/T7). */
    function bulkMarkResolved() {
      var candidates = multiSelect.selectedItems.filter(function (r) { return !isResolved(r); });
      if (bulkResolving || candidates.length === 0) return;
      var api = window.FS && window.FS.api;
      if (!api || !api.actions || !api.pooledAll) return;

      setBulkResolving(true);

      var thunks = candidates.map(function (row) {
        return function () {
          return api.actions.toggleAction({
            date:         row.date,
            topic_id:     row.topic_id,
            action_index: 'quality',
            checked:      true,
            action_text:  row.item,
            user_folder:  row.user_folder,
          }).then(function () { return { ok: true, row: row }; })
            .catch(function (err) {
              console.error('[Quality] bulk resolve failed for', row.id, err);
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
            message: 'Resolved ' + okCount + ' item' + (okCount === 1 ? '' : 's'),
            tone:    'success',
          });
        } else if (okCount === 0) {
          toast.show({
            message: 'Could not resolve ' + failCount + ' item' + (failCount === 1 ? '' : 's') + ' — try again',
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

    return React.createElement('div', { className: 'fs-quality' },
      header,
      toolbar,

      /* Create item modal (Sprint 8.1.3)
         Batch B Task 5 — live mode sources siteId from the global
         FS.siteContext (the report-side project slug), NOT state.user
         (a user-scoping value from the aggregator that happened to be
         admin-null, which is what made the old fixtures[0] fallback
         WRONG for admin in live). When siteContext has nothing anchored,
         the modal itself collects a Project via its required select.
         Mock mode keeps the pre-existing fixtures[0] fallback verbatim. */
      ctx.showCreate && QualityCreateModal
        ? React.createElement(QualityCreateModal, {
            siteId:    !window.FS.api.useMocks
                       ? ((window.FS.siteContext && window.FS.siteContext.get()) || '')
                       : (state.user
                          || (((window.FieldSight && window.FieldSight.fixtures
                               && window.FieldSight.fixtures.sites
                               && window.FieldSight.fixtures.sites.sites) || [])[0] || {}).site_id
                          || ''),
            onSuccess: handleNewItem,
            onCancel:  function () { ctx.setShowCreate(false); },
          })
        : null,

      React.createElement('div', { className: 'fs-quality__meta' },
        totals.total + (totals.total === 1 ? ' item · ' : ' items · ') + rangeLabel),

      /* T4 — bulk action bar, shown whenever Multi-Select mode is on
         (shared MultiSelectBulkBar composite). "Select all" only ever
         selects batch-eligible (topic_quality) rows, since that's the
         `items` useMultiSelect was constructed with above. */
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

      React.createElement(KpiStrip, null,
        React.createElement(StatCard, { value: totals.total,    label: 'Total items' }),
        React.createElement(StatCard, {
          value: totals.followUp, label: 'Follow-up',
          tone:  totals.followUp > 0 ? 'warning' : 'neutral',
        }),
        React.createElement(StatCard, { value: totals.sites,     label: 'Sites' }),
        React.createElement(StatCard, {
          value: totals.completed, label: 'Completed',
          tone:  totals.completed > 0 ? 'success' : 'neutral',
        }),
      ),

      groups.length === 0
        ? React.createElement('div', { className: 'fs-quality__empty' },
            'No quality items in this window.')
        : React.createElement('div', { className: 'fs-quality__groups' },
            groups.map(function (g) {
              return React.createElement('div', { key: g.date, className: 'fs-quality__group' },
                React.createElement('div', { className: 'fs-quality__group-header' },
                  React.createElement('span', { className: 'fs-quality__group-date' },
                    fmtDateLong(g.date)),
                  React.createElement('span', { className: 'fs-quality__group-count' },
                    g.rows.length + (g.rows.length === 1 ? ' item' : ' items')),
                ),
                React.createElement('div', { className: 'fs-quality__group-rows' },
                  g.rows.map(function (row) {
                    var isSel = ctx.selectedItem && ctx.selectedItem.id === row.id;
                    /* T4 — batch-eligible = source === 'topic_quality'
                       only (see the comment above batchEligibleRows).
                       Ineligible rows keep opening the detail panel
                       regardless of batchMode. */
                    var batchEligible = row.source === 'topic_quality';
                    var batchSelected = multiSelect.batchMode && batchEligible && !!multiSelect.selectedIds[row.id];
                    return React.createElement('button', {
                      key:       row.id,
                      type:      'button',
                      className: 'fs-quality__row-btn'
                        + (isSel ? ' fs-quality__row-btn--active' : '')
                        + (isResolved(row) ? ' fs-row--resolved' : '')
                        + (batchSelected ? ' fs-row--batch-selected' : ''),
                      onClick:   function (e) {
                        if (multiSelect.batchMode && batchEligible) {
                          multiSelect.onItemClick(row, e);
                          return;
                        }
                        ctx.setSelected(row);
                        onSelect({ kind: 'quality_item', id: row.id, row: row });
                      },
                    },
                      React.createElement('div', { className: 'fs-quality__row' },
                        React.createElement('div', { className: 'fs-quality__row-main' },
                          React.createElement('div', { className: 'fs-quality__row-title' },
                            row.item),
                          row.details
                            ? React.createElement('div', { className: 'fs-quality__row-details' },
                                row.details)
                            : null,
                        ),
                        React.createElement('div', { className: 'fs-quality__row-status' },
                          React.createElement(Badge, {
                            tone:    statusTone(row.status), size: 'sm',
                            variant: 'subtle',
                          }, (row.status || '').charAt(0).toUpperCase() +
                             (row.status || '').slice(1) || 'Unknown'),
                          row.follow_up_needed
                            ? React.createElement(Badge, {
                                tone: 'warning', size: 'sm', variant: 'outline',
                              }, 'Follow-up')
                            : null,
                          /* batch B Task 6 — manually-logged items, merged in
                             by compliance-aggregator.js from
                             org.getObservations.
                             feat 4b — 'live' items merged in the same way
                             from org.getLiveItems. */
                          row.source === 'manual'
                            ? React.createElement(Badge, {
                                tone: 'neutral', size: 'sm', variant: 'subtle',
                              }, 'Manual')
                            : null,
                          row.source === 'live'
                            ? React.createElement(Badge, {
                                tone: 'info', size: 'sm', variant: 'subtle',
                              }, 'Live')
                            : null,
                        ),
                      ),
                    );
                  }),
                ),
              );
            }),
          ),
    );
  }

  /* ---------- Right detail (Sprint 6.4) -------------------------------- */

  function DetailRow(props) {
    return React.createElement('div', { className: 'fs-quality-detail__row' },
      React.createElement('div', { className: 'fs-quality-detail__row-label' },
        props.label),
      React.createElement('div', { className: 'fs-quality-detail__row-value' },
        props.value),
    );
  }

  function QualityRightDetail(props) {
    var fs       = window.FieldSight;
    var Card     = fs.Card;
    var Badge    = fs.Badge;
    var Button   = fs.Button;
    var IconBtn  = fs.IconButton;

    var ctx = React.useContext(QualityContext);
    var sel = ctx && ctx.selectedItem;
    var caller = (ctx && ctx.caller) || {};

    /* Task 2 (live-data fixes) — resolve/reopen toggle, piggybacking the
       existing actions-toggle endpoint (see compliance-aggregator.js
       _AUDIT-2). Only 'topic_quality' rows carry the synthetic status
       gap (fixed 'observed' literal) — 'qc_item' rows already have a
       real backend status (q.status) and are left alone; toggling them
       would overwrite honest data with a synthetic binary. Mirrors
       action-item-row.js's optimistic pattern: flip local state
       immediately, fire toggleAction, revert on reject. */
    var refPending = React.useState(false);
    var togglePending = refPending[0];
    var setTogglePending = refPending[1];

    function toggleResolve() {
      if (!sel || togglePending || sel.source !== 'topic_quality') return;
      var prevSel   = sel;
      var nextStatus = prevSel.status === 'resolved' ? 'observed' : 'resolved';
      var nextSel   = Object.assign({}, prevSel, { status: nextStatus });

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
        action_index: 'quality',
        checked:      nextStatus === 'resolved',
        action_text:  sel.item,
        user_folder:  sel.user_folder,
      }).then(function () {
        setTogglePending(false);
      }).catch(function (err) {
        console.error('[QualityRightDetail] resolve toggle failed, reverting', err);
        setTogglePending(false);
        if (ctx.setSelected) ctx.setSelected(prevSel);
        applyStatus(prevSel.id, prevSel.status);
      });
    }

    /* batch B Task 6 — Mark closed/Reopen for manually-logged items
       (source === 'manual', merged in by compliance-aggregator.js from
       org.getObservations). Distinct from toggleResolve() above: that
       one only ever applies to 'topic_quality' rows and piggybacks the
       actions-toggle join; manual rows use
       org.updateObservation({status:'open'|'closed'}) instead. Gated to
       the author or an admin/gm caller (mirrors team.js's
       user:manage-gated archive pattern). No optimistic row-list flip —
       just an immediate local `sel` update for a responsive detail
       panel, plus a full range refetch so the list (Manual badge/status)
       comes back through the real toManualQualityRow() mapping. */
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
            status: nextClosed ? 'resolved' : 'observed',
          }));
        }
        var toast = window.FS && window.FS.toast;
        if (toast) {
          toast.show({
            message: nextClosed ? 'Item marked closed.' : 'Item reopened.',
            tone:    'success',
          });
        }
        if (ctx.refetch) ctx.refetch();
      }).catch(function (err) {
        console.error('[QualityRightDetail] manual status update failed', err);
        setManualPending(false);
        var toast = window.FS && window.FS.toast;
        if (toast) {
          toast.show({
            message: (err && err.message) || 'Could not update item',
            tone:    'error',
          });
        }
      });
    }

    /* Lazy-fetch related action_items from the source topic — only
       applies when the row was sourced from a quality-tagged topic
       (topic_id >= 0). Report-level qc_items have topic_id = -1. */
    var refLinks = React.useState({ status: 'idle', items: [] });
    var linksS   = refLinks[0];
    var setLinks = refLinks[1];

    React.useEffect(function () {
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
      return React.createElement('div', { className: 'fs-quality-detail__placeholder' },
        React.createElement('div', { className: 'fs-quality-detail__placeholder-title' },
          'Select an item'),
        React.createElement('div', { className: 'fs-quality-detail__placeholder-body' },
          'Pick any quality item in the list to see its full detail and source report.'),
      );
    }

    function onOpenInTimeline() {
      /* Sprint 6.6.4 — append &topic=N for topic-source rows so the
         timeline page lands in focus mode. qc_item rows are
         report-level and skip the topic param. */
      var qs = '?date=' + encodeURIComponent(sel.date);
      if (sel.user_folder) qs += '&user=' + encodeURIComponent(sel.user_folder);
      if (sel.topic_id != null && sel.topic_id >= 0) {
        qs += '&topic=' + encodeURIComponent(sel.topic_id);
      }
      window.FS.Router.navigate('/timeline' + qs);
    }

    var statusBadge = React.createElement(Badge, {
      tone: statusTone(sel.status), size: 'sm', prefixDot: true,
    }, (sel.status || '').charAt(0).toUpperCase() + (sel.status || '').slice(1) || 'Unknown');

    var followUpBadge = sel.follow_up_needed
      ? React.createElement(Badge, {
          tone: 'warning', size: 'sm', variant: 'outline',
        }, 'Follow-up needed')
      : null;

    /* batch B Task 6 — 'manual' added alongside the two report-derived
       sources; previously fell through to the 'Quality-tagged topic'
       label, which is wrong for a manually-logged item.
       Fable-review F3 — 'live' added alongside; previously also fell
       through to 'Quality-tagged topic', which is wrong for a session-
       sourced live extraction. */
    var sourceLabel = sel.source === 'qc_item'
      ? 'Report-level Q&C item'
      : sel.source === 'manual'
        ? 'Manually logged item'
        : sel.source === 'live'
          ? 'Live extraction'
          : 'Quality-tagged topic';

    var rows = [];
    if (sel.details) {
      rows.push(React.createElement(DetailRow, {
        key: 'details', label: 'Details', value: sel.details,
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
    if (sel.who_raised && sel.who_raised !== sel.user_name) {
      rows.push(React.createElement(DetailRow, {
        key: 'who', label: 'Raised by', value: sel.who_raised,
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

    /* Sprint 6.6.3 — photos block. Topic-quality rows carry
       related_photos from the aggregator; report-level qc_items don't
       (no topic to lift them from). */
    var photosBlock = null;
    var PhotoGrid   = fs.PhotoGrid;
    var photos      = (sel.related_photos || []);
    if (photos.length > 0 && PhotoGrid) {
      photosBlock = React.createElement('div', { className: 'fs-quality-detail__photos' },
        React.createElement('div', { className: 'fs-quality-detail__photos-label' },
          'Photos · ' + photos.length),
        React.createElement(PhotoGrid, {
          photos:           photos,
          userDisplayName:  sel.user_name,
          date:             sel.date,
          variant:          'carousel',
        }),
      );
    }

    var linkedBlock = null;
    if (sel.topic_id >= 0) {
      if (linksS.status === 'loading') {
        linkedBlock = React.createElement('div', { className: 'fs-quality-detail__linked' },
          React.createElement('div', { className: 'fs-quality-detail__linked-label' },
            'Related actions'),
          React.createElement('div', { className: 'fs-quality-detail__linked-loading' },
            'Loading…'),
        );
      } else if (linksS.items.length > 0) {
        linkedBlock = React.createElement('div', { className: 'fs-quality-detail__linked' },
          React.createElement('div', { className: 'fs-quality-detail__linked-label' },
            'Related actions in this topic'),
          React.createElement('div', { className: 'fs-quality-detail__linked-items' },
            linksS.items.map(function (it) {
              return React.createElement('div', {
                key:       it.action_index,
                className: 'fs-quality-detail__linked-chip',
              },
                React.createElement('div', { className: 'fs-quality-detail__linked-text' },
                  it.text),
                it.responsible
                  ? React.createElement('div', { className: 'fs-quality-detail__linked-meta' },
                      it.responsible + (it.priority ? ' · ' + it.priority : ''))
                  : null,
              );
            }),
          ),
        );
      }
    }

    return React.createElement('div', { className: 'fs-quality-detail' },

      React.createElement('div', { className: 'fs-quality-detail__header' },
        React.createElement('div', { className: 'fs-quality-detail__header-main' },
          React.createElement('h2', { className: 'fs-quality-detail__title' },
            sel.item),
          React.createElement('div', { className: 'fs-quality-detail__metaline' },
            statusBadge, followUpBadge,
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

      React.createElement('div', { className: 'fs-quality-detail__rows' }, rows),

      /* Photos (Sprint 6.6.3) */
      photosBlock,

      linkedBlock,

      /* batch B Task 6 — manual rows get the author/admin-gated Mark
         closed/Reopen action instead of the generic resolve button
         (which is scoped to 'topic_quality' only, above). */
      React.createElement('div', { className: 'fs-quality-detail__actions' },
        (Button && sel.source === 'topic_quality') ? React.createElement(Button, {
          variant: 'primary', size: 'sm', loading: togglePending,
          onClick: toggleResolve,
        }, sel.status === 'resolved' ? 'Reopen' : 'Mark resolved') : null,
        (Button && sel.source === 'manual' && canManageManual) ? React.createElement(Button, {
          variant: 'primary', size: 'sm', loading: manualPending,
          onClick: toggleManualStatus,
        }, sel.closed ? 'Reopen' : 'Mark closed') : null,
        /* Manual observations have no source report — the link would land on
           a "_notFound" timeline (batch B review). Same for 'live' rows
           (Fable-review F3) — the nightly report hasn't landed yet, so
           Open source report would navigate to a "_notFound" timeline
           too. */
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
  window.FieldSight.PAGES['/quality'] = {
    Middle:   QualityMiddleColumn,
    Right:    QualityRightDetail,
    Provider: QualityProvider,
  };

})();
