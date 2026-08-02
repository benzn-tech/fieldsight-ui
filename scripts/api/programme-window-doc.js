/* ==========================================================================
   FieldSight — window rows → the {parents, leaves} document the Gantt renders
   --------------------------------------------------------------------------
   The window endpoint speaks Aurora: start_date/end_date, parent_id as a uuid,
   and an `in_window` flag marking rows pulled in only as ancestors. The Gantt
   speaks the legacy document. Something has to translate, and doing it once
   here beats teaching the page two shapes.

   The parents/leaves split uses the SAME rule as the server's snapshot
   builder: DATES decide, not whether a task has children.

   That is not the intuitive rule, and the intuitive one is harmful. Sorting by
   "has children" drops a contract task out of `leaves` the moment a PM breaks
   it down — on the backend that silently stopped it being a match candidate,
   and the shape tests all passed. Repeating the mistake here would drop it out
   of the Gantt's task rows instead.

   Rows carried in only as ancestors keep `out_of_window: true` so the page can
   grey them: they are context for the tree, not work happening in the selected
   range.

   Pure: no React, no DOM, no fetch.

   Exported to:
     window.FS.api.programmeWindowDoc   (browser)
     module.exports                     (node:test)
   ========================================================================== */

(function () {
  'use strict';

  /* The file's identifier when it has one, our uuid otherwise — the same
     precedence the server's snapshot uses, so a task keeps one identity
     across the window view, the full document and any suggestion that
     already references it. */
  function docId(row) {
    return row.source_task_id || String(row.id);
  }

  function windowRowsToDoc(rows) {
    var list = rows || [];
    var byUuid = {};
    list.forEach(function (r) { byUuid[String(r.id)] = r; });

    var parents = [], leaves = [];
    var starts = [], ends = [];

    list.forEach(function (r) {
      var start = r.start_date || null;
      var end = r.end_date || null;
      var outOfWindow = r.in_window === false;

      if (!start && !end) {
        parents.push({
          task_id: docId(r),
          id: r.id,
          name: r.name,
          wbs: r.wbs_code,
          out_of_window: outOfWindow,
        });
        return;
      }

      var parentRow = r.parent_id ? byUuid[String(r.parent_id)] : null;
      leaves.push({
        task_id:       docId(r),
        id:            r.id,           /* PATCH addresses the uuid, not task_id */
        parent_id:     parentRow ? docId(parentRow) : null,
        name:          r.name,
        wbs:           r.wbs_code,
        start:         start,
        end:           end,
        duration_days: r.duration_days,
        progress_pct:  r.progress_pct || 0,
        status:        r.status || 'not_started',
        zone:          r.zone || null,
        assignees:     r.assignees || [],
        depends_on:    r.depends_on || [],
        row_version:   r.row_version,  /* autosave's optimistic lock */
        out_of_window: outOfWindow,
        linked_action_items: [],
      });

      if (start) starts.push(start);
      if (end) ends.push(end);
    });

    return {
      parents:    parents,
      leaves:     leaves,
      start_date: starts.length ? starts.reduce(function (a, b) { return a < b ? a : b; }) : null,
      end_date:   ends.length ? ends.reduce(function (a, b) { return a > b ? a : b; }) : null,
    };
  }

  var api = { windowRowsToDoc: windowRowsToDoc, docId: docId };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.programmeWindowDoc = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
