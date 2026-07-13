/* ==========================================================================
   FieldSight · Actions event bus (Sprint 6.7.1)
   --------------------------------------------------------------------------
   A tiny pub/sub for action-item check-state synchronisation. Solves the
   problem where the same action_item appears twice (middle TopicCard +
   right detail OverviewTab) and toggling one didn't update the other.

   Each ActionItemRow:
     - Subscribes on mount
     - Emits on successful toggle
     - On incoming event whose key matches its own (date+topic+index),
       updates its local `checked` state to match server truth

   Each timeline parent state (state.actions in MiddleColumn,
   refActions in RightDetail) ALSO subscribes and updates its own slot
   so subsequent renders / remounts see fresh data.

   Lightweight by design — no dependency, no React context, no AppShell
   plumbing. Mirrors the no-build-step ethos of the prototype.

   Public API:
     window.FS.actionsBus.emit(payload)   → fires payload to all subscribers
     window.FS.actionsBus.subscribe(cb)   → returns unsubscribe fn

   Payload shape (Sprint · user-dimension audit key, see
   docs/superpowers/plans/2026-07-13-user-dimension-audit-key.md):
     { date, topic_id, action_index, checked, checked_by, checked_at, user_folder }
   user_folder = the report OWNER's folder (never the caller/current user),
   forwarded as-is (may be undefined/null for legacy callers — subscribers
   must treat missing user_folder as '' when deriving keys, so pre-migration
   payloads keep matching each other).

   Key derivation (for matching across components) — 3-part identity key:
     `${date}|${user_folder || ''}|${topic_id}_${action_index}`
   This bus is generic emit/subscribe with no key logic of its own; each
   subscriber (e.g. ActionItemRow) computes this key itself from the
   payload — see action-item-row.js for the canonical implementation.
   ========================================================================== */

(function () {
  'use strict';

  var subscribers = new Set();

  function emit(payload) {
    subscribers.forEach(function (cb) {
      try { cb(payload); }
      catch (e) { console.error('[actionsBus]', e); }
    });
  }

  function subscribe(cb) {
    subscribers.add(cb);
    return function () { subscribers.delete(cb); };
  }

  if (!window.FS) window.FS = {};
  window.FS.actionsBus = { emit: emit, subscribe: subscribe };

})();
