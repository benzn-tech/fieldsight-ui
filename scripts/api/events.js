/* ==========================================================================
   FieldSight · FS.events — named pub/sub (spec 2026-09-15 §5)
   --------------------------------------------------------------------------
   Separate from FS.actionsBus on purpose: every actionsBus subscriber assumes
   the check-off payload shape. Events published here:
     content:edited  { table, id }  — emitted only by FS.api.actions.settleSave

   Public API:
     FS.events.on(name, fn)                 -> off()
     FS.events.emit(name, payload)
     FS.events.onContentEdited(table, id, fn) -> off()
   Loaded after api/index.js in app-shell-preview.html.
   ========================================================================== */

(function () {
  'use strict';

  function createEvents() {
    var byName = {};

    function on(name, fn) {
      if (!byName[name]) byName[name] = new Set();
      byName[name].add(fn);
      return function off() { byName[name].delete(fn); };
    }

    function emit(name, payload) {
      var subs = byName[name];
      if (!subs) return;
      Array.from(subs).forEach(function (fn) {
        try { fn(payload); }
        catch (e) { console.error('[FS.events]', name, e); }
      });
    }

    function onContentEdited(table, id, fn) {
      return on('content:edited', function (p) {
        if (!p || p.table !== table || String(p.id) !== String(id)) return;
        fn(p);
      });
    }

    return { on: on, emit: emit, onContentEdited: onContentEdited };
  }

  if (!window.FS) window.FS = {};
  window.FS.events = createEvents();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createEvents: createEvents };
  }
})();
