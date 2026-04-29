/* ==========================================================================
   FieldSight API · Action items — BACKEND-CONTEXT §4.10
   --------------------------------------------------------------------------
   GET  /api/actions?date=YYYY-MM-DD                → { date, actions: { '<topic_id>_<action_index>': { checked, checked_by, checked_at } } }
   POST /api/actions/toggle  body { date, topic_id, action_index, checked, action_text }

   Backed by an in-memory copy of fixtures.actions during Sprint 2.1, so
   mutations persist for the lifetime of the page (good enough to demo
   the optimistic-update pattern).
   ========================================================================== */

(function () {
  'use strict';

  /* Mutable copy — initial state seeded from fixtures the first time. */
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
    await window.FS.api.delay();
    ensureState();
    return { date: date, actions: state[date] || {} };
  }

  async function toggleAction(opts) {
    opts = opts || {};
    await window.FS.api.delay(60);
    ensureState();

    var date  = opts.date;
    var key   = actionKey(opts.topic_id, opts.action_index);
    var who   = (window.AuthMock && window.AuthMock.currentUser && window.AuthMock.currentUser.name) || 'system';

    if (!state[date]) state[date] = {};
    state[date][key] = {
      checked:    !!opts.checked,
      checked_by: who,
      checked_at: new Date().toISOString(),
    };

    return { message: 'Updated', checked: !!opts.checked };
  }

  window.FS.api.actions = {
    getActions:   getActions,
    toggleAction: toggleAction,
    actionKey:    actionKey,
  };

})();
