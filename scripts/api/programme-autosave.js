/* ==========================================================================
   FieldSight Programme Autosave — pure planning helpers
   --------------------------------------------------------------------------
   The page used to hold every edit in memory behind a Save button that PUT
   the whole document. On a real programme that document is ~1.5MB, which is
   why the button existed. With per-task PATCH the write is small enough to
   happen on every change, so the button goes away.

   These three functions are the decision logic, kept pure so they can be
   tested under Node — the page owns the debounce timers and the request
   itself.

   Exported to:
     window.FS.api.programmeAutosave   (browser)
     module.exports                    (node:test)
   ========================================================================== */

(function () {
  'use strict';

  /* Returns the request to send, or null when nothing actually changed.

     Sending unchanged fields would burn row_versions, which turns a second
     editor's harmless concurrent edit into a spurious 409 — the user would
     be told someone else changed a task when nobody did anything to it. */
  function planAutosave(task, edits) {
    var changed = {};
    var any = false;
    Object.keys(edits || {}).forEach(function (k) {
      if (edits[k] !== task[k]) { changed[k] = edits[k]; any = true; }
    });
    if (!any) return null;

    /* Assigned after the loop so a field literally named row_version in the
       edit set can never shadow the lock value. */
    changed.row_version = task.row_version;
    return { method: 'PATCH', task_id: task.task_id, body: changed };
  }

  /* On 409 the server hands back the current row. Replace just that one and
     leave every other pending edit alone — reloading the whole programme
     would discard work the user has not been told about.

     Returns a new array; React state is never mutated in place. */
  function applyConflict(tasks, fresh) {
    var found = false;
    var next = (tasks || []).map(function (t) {
      if (t.task_id === fresh.task_id) { found = true; return fresh; }
      return t;
    });
    return found ? next : tasks;
  }

  /* Collapse a queued edit with a newer one for the same task, last write
     winning per field.

     Dragging a progress slider fires a change per pixel. Those have to
     become one PATCH: sending them in sequence would make every one after
     the first fail the optimistic lock against a row_version the server has
     already bumped, so the user would see a conflict caused entirely by
     their own dragging. */
  function mergeQueued(pending, next) {
    return Object.assign({}, pending || {}, next || {});
  }

  var api = {
    planAutosave:   planAutosave,
    applyConflict:  applyConflict,
    mergeQueued:    mergeQueued,
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.programmeAutosave = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
