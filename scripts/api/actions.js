/* ==========================================================================
   FieldSight API · Action items — BACKEND-CONTEXT §4.10  (Sprint 8.1.1)
   --------------------------------------------------------------------------
   GET    /api/actions?date=YYYY-MM-DD
          → { date, actions: { '<topic_id>_<action_index>': { checked, checked_by, checked_at } } }

   POST   /api/actions/toggle          (useMocks=false — Phase 0 Task 2)
          body { date, topic_id, action_index, checked, action_text }
          → { message: "Updated", checked: true }

   POST   /api/actions                 (useMocks=false, writeMocks=false — Sprint 8.1.1)
          body { date, topic_id, action_index, action_text, responsible, ... }
          → { id, ...action }

   Mock path: in-memory copy of fixtures.actions, mutations persist for the
   lifetime of the page (good enough to demo the optimistic-update pattern).

   On real-backend failure:
     • Emits a revert event to FS.actionsBus so sibling ActionItemRows
       can roll back to previous state.
     • Shows a toast via FS.toast.show (if available).
   ========================================================================== */

(function () {
  'use strict';

  var state = null;

  function ensureState() {
    if (state) return;
    var f = (window.FieldSight && window.FieldSight.fixtures && window.FieldSight.fixtures.actions) || {};
    state = JSON.parse(JSON.stringify(f));
  }

  function actionKey(topic_id, action_index) {
    return topic_id + '_' + action_index;
  }

  async function getActions(date) {
    if (!window.FS.api.useMocks) {
      return window.FS.api.request('/actions', { params: { date: date } });
    }
    await window.FS.api.delay();
    ensureState();
    return { date: date, actions: state[date] || {} };
  }

  async function toggleAction(opts) {
    opts = opts || {};
    var date         = opts.date;
    var topic_id     = opts.topic_id;
    var action_index = opts.action_index;
    var checked      = !!opts.checked;
    var action_text  = opts.action_text;

    /* --- Real backend path (Phase 0 Task 2) ------------------------------
       Optimistic flow:
         1. ActionItemRow already flips its local checkbox state.
         2. We fire POST /api/actions/toggle (BACKEND-CONTEXT §4.10).
         3. On success: emit confirmed bus event (sibling rows sync).
         4. On failure: emit revert bus event + show toast error.
    */
    if (!window.FS.api.useMocks) {
      return window.FS.api.request('/actions/toggle', {
        method: 'POST',
        body:   { date: date, topic_id: topic_id, action_index: action_index, checked: checked, action_text: action_text },
      }).then(function (res) {
        /* Emit confirmed bus event so any sibling row with the same key
           updates to the server-truth value. */
        var bus = window.FS && window.FS.actionsBus;
        if (bus) {
          bus.emit({
            date:         date,
            topic_id:     topic_id,
            action_index: action_index,
            checked:      checked,
            checked_by:   (res && res.checked_by) || null,
            checked_at:   (res && res.checked_at) || null,
          });
        }
        return res;
      }).catch(function (err) {
        /* Emit revert event so ActionItemRow rolls back. */
        var bus = window.FS && window.FS.actionsBus;
        if (bus) {
          bus.emit({
            date:         date,
            topic_id:     topic_id,
            action_index: action_index,
            checked:      !checked,  /* revert */
            checked_by:   null,
            checked_at:   null,
            _revert:      true,
          });
        }
        /* Toast the failure. */
        var toast = window.FS && window.FS.toast;
        if (toast) {
          toast.show({
            message:  'Could not update action item' + ((err && err.message) ? ': ' + err.message : ''),
            tone:     'error',
            duration: 5000,
          });
        }
        throw err;
      });
    }

    /* --- Mock path ------------------------------------------------------- */
    await window.FS.api.delay(60);
    ensureState();

    var key = actionKey(topic_id, action_index);
    var who = (window.AuthMock && window.AuthMock.currentUser && window.AuthMock.currentUser.name) || 'system';

    if (!state[date]) state[date] = {};
    state[date][key] = {
      checked:    checked,
      checked_by: who,
      checked_at: new Date().toISOString(),
    };

    return { message: 'Updated', checked: checked };
  }

  /* Sprint 8.1.1 — create a new action item. Used by future write flows. */
  async function createAction(payload) {
    if (!window.FS.api.useMocks && !window.FS.api.writeMocks) {
      return window.FS.api.request('/actions', {
        method: 'POST',
        body:   payload,
      });
    }
    await window.FS.api.delay(80);
    ensureState();
    var date = payload.date;
    var key  = actionKey(payload.topic_id, payload.action_index || 0);
    if (!state[date]) state[date] = {};
    state[date][key] = {
      checked:    false,
      checked_by: null,
      checked_at: null,
    };
    return { id: date + '_' + key, created: true };
  }

  /* Sprint 4.2 — cross-day audit aggregation. */
  async function getActionsRange(opts) {
    opts = opts || {};
    var from = opts.from, to = opts.to;
    if (!from || !to) return { byDate: {}, dates: [] };

    var dates = [];
    var cursor = from;
    while (cursor <= to) {
      dates.push(cursor);
      cursor = window.FS.api.addDaysISO(cursor, 1);
    }

    /* Narrow to days that actually have a report — actions only exist where
       reports do, and the calendar enumeration above can span 150 days on
       the 'All' range. getSpan() reuses the same cached /api/dates fetch the
       toolbar uses; on failure keep the full enumeration. */
    try {
      var span = await window.FS.api.window.getSpan();
      var dmap = (span && span.dates) || {};
      var reportDays = dates.filter(function (d) { return dmap[d] && dmap[d].hasReport; });
      if (reportDays.length) dates = reportDays;
    } catch (e) { /* keep full enumeration */ }

    /* Pooled + per-day catch (an uncaught throttle rejection here killed
       /tasks even after the timeline leg was pooled — a failed day degrades
       to "no audit info" instead). */
    var perDay = (await window.FS.api.pooledAll(dates.map(function (d) {
      return function () {
        return getActions(d).then(function (res) { return { date: d, res: res }; })
          .catch(function () { return { date: d, res: { actions: {} } }; });
      };
    }), 8)).filter(Boolean);

    var byDate = {};
    var anyDenied = null;
    perDay.forEach(function (x) {
      if (x.res && x.res._accessDenied) { anyDenied = x.res; return; }
      byDate[x.date] = (x.res && x.res.actions) || {};
    });

    if (anyDenied) {
      return { _accessDenied: true, error: anyDenied.error || 'Access denied' };
    }
    return { byDate: byDate, dates: dates };
  }

  window.FS.api.actions = {
    getActions:      getActions,
    getActionsRange: getActionsRange,
    toggleAction:    toggleAction,
    createAction:    createAction,
    actionKey:       actionKey,
  };

})();
