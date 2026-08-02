/* ==========================================================================
   FieldSight Programme — critical-path tier, and the fallback ranking
   --------------------------------------------------------------------------
   Spec: docs/superpowers/specs/2026-08-03-programme-critical-path-design.md §3

   This module exists because computeCriticalPath returns a plausible-looking
   path on a programme with NO dependencies: every task has zero slack when
   nothing constrains it. Rendering that as a red route would have a PM
   sequencing real work off an artefact of missing data — a fabricated
   critical path is a silent error, where a missing one is a visible gap.

   So the tier is DERIVED from the data, never chosen, and the UI is forbidden
   from drawing a path below tier 1:

     tier 1  dependency coverage >= 60% and the graph is acyclic
             → real CPM, red route, float, lateness
     tier 2  anything else
             → NO path anywhere. Deadline-pressure ranking instead, amber,
               labelled "at risk", with `reason` explaining why.

   MSPDI XML imports carry a real graph (PredecessorLink is parsed).
   CSV/XLSX effectively never do — which is most of tier 2.

   Pure: no React, no DOM, no fetch.

   Exported to:
     window.FS.api.programmeCriticalTier   (browser)
     module.exports                        (node:test)
   ========================================================================== */

(function () {
  'use strict';

  /* Below this, CPM finds a path through whichever small subset happens to be
     connected and presents it with the same visual weight as a real one.
     A judgement call, not a derivation — revisit against real client files. */
  var COVERAGE_THRESHOLD = 0.6;

  var CLOSED_STATUSES = ['completed', 'cancelled', 'done'];

  function toUTC(iso) {
    var p = String(iso).split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }

  function days(a, b) {
    return Math.round((toUTC(b) - toUTC(a)) / 86400000);
  }

  /* How much of the programme is actually constrained.

     Counts a task if it is at EITHER end of a real dependency. Counting only
     successors would halve every real programme's coverage — the first task
     in a chain is just as constrained by being something's predecessor.

     A dependency pointing at a task that is not in the set constrains nothing
     (imports drop tasks, leaving dangling predecessors), and neither does a
     self-dependency. */
  function dependencyCoverage(tasks) {
    var list = tasks || [];
    var present = {};
    list.forEach(function (t) { present[t.task_id] = true; });

    var participating = {};
    list.forEach(function (t) {
      (t.depends_on || []).forEach(function (d) {
        if (d === t.task_id) return;
        if (!present[d]) return;
        participating[t.task_id] = true;
        participating[d] = true;
      });
    });

    var n = Object.keys(participating).length;
    return {
      participating: n,
      total: list.length,
      fraction: list.length ? n / list.length : 0,
    };
  }

  function hasCycle(tasks) {
    var byId = {};
    (tasks || []).forEach(function (t) { byId[t.task_id] = t; });
    var state = {};   /* 1 = visiting, 2 = done */
    var found = false;

    function visit(id) {
      if (found || state[id] === 2) return;
      if (state[id] === 1) { found = true; return; }
      state[id] = 1;
      var t = byId[id];
      ((t && t.depends_on) || []).forEach(function (d) {
        if (byId[d]) visit(d);
      });
      state[id] = 2;
    }

    Object.keys(byId).forEach(function (id) { visit(id); });
    return found;
  }

  /* { tier: 1|2, coverage, reason } — `reason` is null on tier 1 and a
     user-facing sentence on tier 2, carrying the actual number, because
     "not enough dependencies" without it is unactionable. */
  function criticalTier(tasks) {
    var cov = dependencyCoverage(tasks);

    if (!cov.total) {
      return { tier: 2, coverage: cov,
               reason: 'This programme has no tasks yet.' };
    }
    if (!cov.participating) {
      return { tier: 2, coverage: cov,
               reason: 'This file carries no dependencies between tasks, so a '
                       + 'critical path cannot be calculated. Import an '
                       + 'MS Project XML, or link tasks here.' };
    }
    if (hasCycle(tasks)) {
      return { tier: 2, coverage: cov,
               reason: 'The dependencies contain a circular reference, so a '
                       + 'critical path cannot be calculated.' };
    }
    if (cov.fraction < COVERAGE_THRESHOLD) {
      return { tier: 2, coverage: cov,
               reason: 'Dependencies cover ' + Math.round(cov.fraction * 100)
                       + '% of tasks — not enough to calculate a critical path.' };
    }
    return { tier: 1, coverage: cov, reason: null };
  }

  /* How far a task's elapsed time has run ahead of its progress, in [0, 1].

     Half elapsed and 10% done scores 0.4. Overdue-and-open is 1. Being AHEAD
     of schedule clamps to 0 rather than going negative — earliness is not a
     form of risk, and letting it go negative would make the ranking read as
     if some tasks were "less than fine". */
  function deadlinePressure(task, todayISO) {
    if (!task || CLOSED_STATUSES.indexOf(task.status) !== -1) return 0;
    var start = task.start || task.start_date;
    var end = task.end || task.end_date;
    if (!start || !end) return 0;

    if (todayISO > end) return 1;              /* overdue and still open */
    if (todayISO < start) return 0;            /* not started yet */

    var span = days(start, end);
    if (span <= 0) return (task.progress_pct || 0) >= 100 ? 0 : 1;

    var elapsed = days(start, todayISO) / span;
    var progress = (task.progress_pct || 0) / 100;
    return Math.max(0, Math.min(1, elapsed - progress));
  }

  /* Below this, a task is behind by less than ten percentage points — real
     arithmetic, but noise in a list headed "at risk". A programme where every
     task is a day or two adrift would otherwise fill the list completely and
     say nothing. The raw score stays exact; only the ranking applies a floor. */
  var PRESSURE_FLOOR = 0.10;

  /* Most pressured first, trivial slippage omitted — a list that includes
     everything is not a ranking. Sorted on a copy. */
  function rankByPressure(tasks, todayISO) {
    return (tasks || [])
      .map(function (t) { return { task: t, pressure: deadlinePressure(t, todayISO) }; })
      .filter(function (x) { return x.pressure >= PRESSURE_FLOOR; })
      .sort(function (a, b) { return b.pressure - a.pressure; });
  }

  var api = {
    COVERAGE_THRESHOLD: COVERAGE_THRESHOLD,
    dependencyCoverage: dependencyCoverage,
    criticalTier:       criticalTier,
    deadlinePressure:   deadlinePressure,
    rankByPressure:     rankByPressure,
    PRESSURE_FLOOR:     PRESSURE_FLOOR,
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.programmeCriticalTier = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
