/* ==========================================================================
   FieldSight Programme — rolling breakdown progress up to the contract task
   --------------------------------------------------------------------------
   Spec: docs/superpowers/specs/2026-08-03-programme-breakdown-allocation-design.md §5

   "我这些已经转化成了一个 breakdown，其实 breakdown 分给了每个人，就是他自己的
   to do list 对不对？这个要跟他的 to do list 做一个交互。"

   A site manager ticking off "rebar fixing" has to move "Pour concrete" on the
   programme, or the breakdown is a private list that never reaches the plan.
   This module is the arithmetic; nothing here writes.

   --------------------------------------------------------------------------
   TWO THINGS IT REFUSES TO DO

   1. Treat a PARTIAL breakdown as if it covered the whole task.

      A 10-day "Pour concrete" broken into one 2-day "Rebar fixing" is not
      100% done when the rebar is done. Weighting only across the children
      says it is — the single child is complete, so the average is complete —
      and that is how a programme starts reporting finished work that has not
      happened. Coverage is measured against the PARENT's duration, and below
      full coverage the answer is `partial`, not a number to write.

   2. Lower progress that a person recorded.

      A PM may have set the imported task to 60% before anyone broke it down.
      A fresh breakdown starts at 0%, so a naive rollup would drop it to 0 and
      call it an update. `applyRollup` never returns a value below what is
      already there — the same rule confirm_suggestion applies to
      matcher-suggested progress, for the same reason: automatic movement may
      add information, never destroy it.

   Weighting is by duration, not by task count, matching overallProgress in
   programme-lateness: a 40-day child at 0% and a 1-day child at 100% is not
   half done.

   Pure: no React, no DOM, no fetch.

   Exported to:
     window.FS.api.programmeRollup   (browser)
     module.exports                  (node:test)
   ========================================================================== */

(function () {
  'use strict';

  /* Below this, a breakdown is too thin to speak for its parent. Not 1.0:
     rounding and a day lost to a weekend should not permanently disqualify an
     otherwise complete breakdown. */
  var FULL_COVERAGE = 0.95;

  function _num(v) {
    return typeof v === 'number' && isFinite(v) ? v : 0;
  }

  function _str(v) {
    return v === null || v === undefined || v === '' ? null : String(v);
  }

  function toUTC(iso) {
    var p = String(iso).split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }

  /* Both task shapes reach this module: the document (start/end) and the
     Aurora row (start_date/end_date). See programme-mentions for what
     handling only one costs. */
  function durationOf(task) {
    if (!task) return 0;
    if (_num(task.duration_days) > 0) return _num(task.duration_days);
    var s = _str(task.start_date) || _str(task.start);
    var e = _str(task.end_date) || _str(task.end);
    if (!s || !e) return 0;
    return Math.round((toUTC(e) - toUTC(s)) / 86400000) + 1;
  }

  function progressOf(task) {
    if (!task) return 0;
    if (task.status === 'completed') return 100;
    var p = _num(task.progress_pct);
    return p < 0 ? 0 : p > 100 ? 100 : p;
  }

  /* --------------------------------------------------------------------
     rollupProgress(parent, children) ->
       { status, progress, coverage, childDays, parentDays }

     status:
       'ok'          — the breakdown covers the parent; `progress` is usable
       'partial'     — a breakdown exists but does not cover the parent;
                       `progress` is what the covered part is at, and must NOT
                       be written to the parent as if it were the whole
       'no_children' — nothing to roll up
       'undated'     — the parent has no duration, so nothing can be weighed
     -------------------------------------------------------------------- */
  function rollupProgress(parent, children) {
    var kids = (children || []).filter(Boolean);
    var parentDays = durationOf(parent);

    if (!kids.length) {
      return { status: 'no_children', progress: null, coverage: 0,
               childDays: 0, parentDays: parentDays };
    }

    var childDays = 0, done = 0;
    kids.forEach(function (c) {
      var d = durationOf(c);
      childDays += d;
      done += d * progressOf(c) / 100;
    });

    if (!childDays) {
      /* Every child is undated. Falling back to a count-weighted average here
         would be the "40-day task and a 1-day task" mistake in disguise, so
         it is refused instead. */
      return { status: 'undated', progress: null, coverage: 0,
               childDays: 0, parentDays: parentDays };
    }

    var progress = Math.round(done / childDays * 100);

    if (!parentDays) {
      /* An undated parent is a WBS header. It has no span to cover, so the
         children ARE the whole of it. */
      return { status: 'ok', progress: progress, coverage: 1,
               childDays: childDays, parentDays: 0 };
    }

    var coverage = childDays / parentDays;
    return {
      status: coverage >= FULL_COVERAGE ? 'ok' : 'partial',
      progress: progress,
      coverage: coverage,
      childDays: childDays,
      parentDays: parentDays,
    };
  }

  /* --------------------------------------------------------------------
     applyRollup(parent, rollup) -> { progress_pct } | null

     What to PATCH onto the parent, or null for "leave it alone". Null is the
     common answer and callers must treat it as such rather than as 0.
     -------------------------------------------------------------------- */
  function applyRollup(parent, rollup) {
    if (!rollup || rollup.status !== 'ok') return null;
    var current = progressOf(parent);
    /* Never lower what a person recorded. A fresh breakdown sits at 0%, so
       without this the first split of a 60%-complete task would report it as
       not started. */
    if (rollup.progress <= current) return null;
    return { progress_pct: rollup.progress };
  }

  /* Index children by parent for a flat task list, so a caller with one page
     of tasks can roll up without n queries. Handles both id shapes: the
     document links by `parent_id` -> `task_id`, the Aurora row by
     `parent_id` -> `id`. */
  function groupByParent(tasks) {
    var out = {};
    (tasks || []).forEach(function (t) {
      var p = _str(t.parent_id);
      if (!p) return;
      (out[p] = out[p] || []).push(t);
    });
    return out;
  }

  var api = {
    rollupProgress: rollupProgress,
    applyRollup:    applyRollup,
    groupByParent:  groupByParent,
    durationOf:     durationOf,
    progressOf:     progressOf,
    FULL_COVERAGE:  FULL_COVERAGE,
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.programmeRollup = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
