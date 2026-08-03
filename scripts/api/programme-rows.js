/* ==========================================================================
   FieldSight Programme Rows — pure row model for the Gantt
   --------------------------------------------------------------------------
   Extracted from GanttView (scripts/pages/programme.js), where the visible
   row list was rebuilt inline on every render and cost O(parents x leaves):
   each parent ran `rollupGroup(parent, leaves)` — a full scan — and then a
   second full `leaves.filter(...)` for its children. On a 200-group /
   5,000-leaf programme that is ~2M iterations, and the scroll handler
   re-rendered on every scrolled pixel, so it was paid ~60x a second.

   Everything here is pure: no React, no DOM, no window access. That is what
   lets the page memoize it on [parents, leaves, collapsed] and what lets it
   be tested under Node.

   Exported to:
     window.FS.api.programmeRows   (browser)
     module.exports                (node:test)
   ========================================================================== */

(function () {
  'use strict';

  /* Bucket leaves by parent_id in ONE pass. Built once per task-set change;
     every parent then reads its children in O(children) instead of O(leaves). */
  function buildChildIndex(leaves) {
    var idx = {};
    var list = leaves || [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var pid = t.parent_id;
      if (pid == null) continue;
      if (!idx[pid]) idx[pid] = [];
      idx[pid].push(t);
    }
    return idx;
  }

  /* Date span + duration-weighted progress for a group row. Weighting by
     duration (not task count) is deliberate: a 40-day task at 0% and a 1-day
     task at 100% is not "50% done". */
  function rollupFromChildren(children) {
    if (!children || !children.length) return { start: null, end: null, progress: 0 };
    var start = null, end = null, totalDays = 0, doneDays = 0;
    for (var i = 0; i < children.length; i++) {
      var t = children[i];
      if (t.start && (start === null || t.start < start)) start = t.start;
      if (t.end   && (end   === null || t.end   > end))   end   = t.end;
      var d = t.duration_days || 0;
      totalDays += d;
      doneDays  += d * (t.progress_pct || 0) / 100;
    }
    return {
      start:    start,
      end:      end,
      progress: totalDays > 0 ? Math.round(doneDays / totalDays * 100) : 0,
    };
  }

  /* The visible row list in WBS order: each group, then its leaves unless the
     group is collapsed. Leaves whose parent_id matches no parent are not
     emitted — same as the behaviour this replaced. */
  function buildRows(parents, leaves, collapsed) {
    var idx  = buildChildIndex(leaves);
    var rows = [];
    var list = parents || [];
    for (var i = 0; i < list.length; i++) {
      var parent   = list[i];
      var children = idx[parent.task_id] || [];
      var roll     = rollupFromChildren(children);

      var groupTask = Object.assign({}, parent, {
        start:         roll.start,
        end:           roll.end,
        duration_days: 0,
        progress_pct:  roll.progress,
        status:        'group',
      });
      rows.push({ kind: 'group', task: groupTask, parent: parent, indent: 0 });

      if (collapsed && collapsed.has(parent.task_id)) continue;
      for (var j = 0; j < children.length; j++) {
        pushLeaf(rows, idx, children[j], 1, collapsed, {});
      }
    }
    return rows;
  }

  /* How deep the tree may go before we stop descending. Groups are level 0,
     contract tasks 1, their zone split or AI breakdown 2, a breakdown of a
     zone 3. Beyond that is almost certainly a data problem rather than a
     plan, and a bound is cheaper than discovering it as a hung tab. */
  var MAX_DEPTH = 6;

  /* A leaf, then anything parented to THAT leaf.
   
     This is what makes the tree three levels rather than two. The row
     builder used to emit only leaves whose parent_id matched a WBS group, so
     a task parented to another task — which is exactly what a zone split and
     an AI breakdown produce (Project 1 §5: local children hang under the
     untouched imported row) — was silently never emitted. No error, no
     warning, just a row that does not exist on screen.
   
     `seen` guards a parent_id cycle. The server-side window CTE was proved
     to terminate on one against real Aurora; nothing was protecting the
     client, and here a cycle is an infinite loop in a render path. */
  function pushLeaf(rows, idx, task, indent, collapsed, seen) {
    var id = task.task_id;
    if (seen[id]) return;
    seen[id] = true;

    var kids = idx[id] || [];
    rows.push({
      kind:   'leaf',
      task:   task,
      indent: indent,
      /* The cell needs to know whether to draw a disclosure control, and
         only the row builder knows the shape of the tree. */
      hasChildren: kids.length > 0,
    });

    if (!kids.length) return;
    if (collapsed && collapsed.has(id)) return;
    if (indent + 1 > MAX_DEPTH) return;
    for (var k = 0; k < kids.length; k++) {
      pushLeaf(rows, idx, kids[k], indent + 1, collapsed, seen);
    }
  }

  /* Which rows the virtualizer should mount, plus the spacer heights that
     stand in for the ones it does not. Pure arithmetic so the page can
     compare two slices and skip a re-render when they are identical. */
  function visibleSlice(scrollTop, viewportH, rowCount, rowH, overscan) {
    if (!rowCount) return { first: 0, last: -1, topSpc: 0, botSpc: 0 };
    var first = Math.max(0, Math.floor((scrollTop - overscan) / rowH));
    var last  = Math.min(rowCount - 1, Math.ceil((scrollTop + viewportH + overscan) / rowH));
    return {
      first:  first,
      last:   last,
      topSpc: first * rowH,
      botSpc: Math.max(0, (rowCount - 1 - last) * rowH),
    };
  }

  var api = {
    buildChildIndex:     buildChildIndex,
    rollupFromChildren:  rollupFromChildren,
    buildRows:           buildRows,
    visibleSlice:        visibleSlice,
  };

  /* Browser: register onto the shared api namespace. */
  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.programmeRows = api;
  }

  /* Node test runner (CommonJS). No-op in the browser. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
