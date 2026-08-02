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

  /* Fields a drag or an edit can move. Everything else on a row is either
     ours to derive (day counts, critical flags) or the file's. */
  var BATCH_FIELDS = ['start', 'end', 'duration_days', 'progress_pct',
                      'status', 'name', 'zone', 'sort_order'];

  /* Server column names differ from the legacy document's. The batch endpoint
     speaks Aurora, so translate on the way out rather than making every call
     site remember which shape it is holding. */
  var TO_COLUMN = { start: 'start_date', end: 'end_date' };

  /* One request for a whole cascade.

     Dragging one bar shifts every downstream dependent, so a single user
     action changes N rows. They must travel together: N independent PATCHes
     are not atomic, and a lost optimistic lock halfway through leaves the
     Gantt looking right while the database is wrong — with nothing raised.

     Returns null when nothing actually moved, so a drag that lands where it
     started writes nothing at all. */
  function planBatchAutosave(before, after) {
    var prev = {};
    (before || []).forEach(function (t) { prev[t.task_id] = t; });

    var tasks = [];
    (after || []).forEach(function (t) {
      var was = prev[t.task_id];
      /* A row that did not exist before is a creation, and creation goes
         through POST. Folding it in here would send it with a row_version it
         never had. */
      if (!was) return;

      var entry = null;
      BATCH_FIELDS.forEach(function (f) {
        if (t[f] === was[f]) return;
        if (!entry) entry = { id: t.task_id, row_version: was.row_version };
        entry[TO_COLUMN[f] || f] = t[f];
      });
      if (entry) tasks.push(entry);
    });

    if (!tasks.length) return null;
    return { method: 'PATCH', body: { tasks: tasks } };
  }

  /* A batch 409 comes back naming the rows that moved. Replace exactly those
     and leave every other pending edit alone — reloading the programme would
     discard work the user has not been told about. */
  function applyBatchConflict(tasks, freshRows) {
    if (!freshRows || !freshRows.length) return tasks;
    var byId = {};
    freshRows.forEach(function (r) { byId[r.task_id] = r; });
    return (tasks || []).map(function (t) {
      return byId[t.task_id] || t;
    });
  }

  var api = {
    planAutosave:        planAutosave,
    applyConflict:       applyConflict,
    mergeQueued:         mergeQueued,
    planBatchAutosave:   planBatchAutosave,
    applyBatchConflict:  applyBatchConflict,
    BATCH_FIELDS:        BATCH_FIELDS,
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
