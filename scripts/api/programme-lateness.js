/* ==========================================================================
   FieldSight Programme — lateness against baseline, and overall progress
   --------------------------------------------------------------------------
   Spec: docs/superpowers/specs/2026-08-03-programme-critical-path-design.md §4

   "落后多少天" is the number the user called out as the important one, and the
   easiest thing here to get quietly wrong — because there is always SOME
   number available. Three ways to be dishonest, all of which this module
   refuses:

     - measuring against the first import when nobody set a baseline, and
       calling that "the plan"
     - reporting lateness on a tier-2 programme, where there is no projected
       finish at all — only a latest end date, and the difference between
       those is exactly what makes the number mean anything
     - returning 0 for "we cannot tell", which renders as "on programme"

   Hence a STATUS rather than a bare number. A caller that renders `days`
   without checking `status` gets `null`, not a plausible zero.

   Definition, of the three that were on the table: projected finish minus
   baseline finish, stated as a projection. Earned-value schedule variance is
   more rigorous and cannot be explained to a site manager.

   Pure: no React, no DOM, no fetch.

   Exported to:
     window.FS.api.programmeLateness   (browser)
     module.exports                    (node:test)
   ========================================================================== */

(function () {
  'use strict';

  function toUTC(iso) {
    var p = String(iso).split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }

  function daysBetween(a, b) {
    return Math.round((toUTC(b) - toUTC(a)) / 86400000);
  }

  /* Latest end date across the set. Completed tasks are INCLUDED: the finish
     date is when the work ends, not when the unfinished work ends, and
     excluding them would make a nearly-done programme appear to finish
     early. */
  function finishDate(tasks) {
    var latest = null;
    (tasks || []).forEach(function (t) {
      var end = t.end || t.end_date;
      if (!end) return;
      if (latest === null || end > latest) latest = end;
    });
    return latest;
  }

  /* { status, days, projectedFinish, baselineFinish, baselineVersion, message }

     status:
       'ok'           — days is a number, negative when ahead of programme
       'no_baseline'  — nobody has chosen which revision is the plan
       'unavailable'  — tier 2, or nothing dated to measure
  */
  function programmeLateness(opts) {
    opts = opts || {};
    var tasks = opts.tasks || [];
    var baselineTasks = opts.baselineTasks || [];

    if (opts.tier !== 1) {
      return {
        status: 'unavailable', days: null,
        projectedFinish: null, baselineFinish: null,
        baselineVersion: opts.baselineVersion || null,
        message: 'This programme has no dependency data, so there is no '
                 + 'projected finish to measure against — only the latest end '
                 + 'date.',
      };
    }

    if (!baselineTasks.length) {
      return {
        status: 'no_baseline', days: null,
        projectedFinish: finishDate(tasks), baselineFinish: null,
        baselineVersion: null,
        message: 'No baseline set. Choose the revision the client approved to '
                 + 'measure progress against it.',
      };
    }

    var projected = finishDate(tasks);
    var baseline = finishDate(baselineTasks);
    if (!projected || !baseline) {
      return {
        status: 'unavailable', days: null,
        projectedFinish: projected, baselineFinish: baseline,
        baselineVersion: opts.baselineVersion || null,
        message: 'Not enough dated tasks to work out a finish date.',
      };
    }

    /* Negative when ahead. NOT clamped: being ahead of programme is
       information a PM wants, and clamping would hide the only good news
       this metric can carry. */
    return {
      status: 'ok',
      days: daysBetween(baseline, projected),
      projectedFinish: projected,
      baselineFinish: baseline,
      baselineVersion: opts.baselineVersion || null,
      message: null,
    };
  }

  /* Duration-weighted, because a 40-day task at 0% and a 1-day task at 100%
     is not "50% done" — the same weighting the Gantt's group rollup uses. */
  function overallProgress(tasks) {
    var total = 0, done = 0;
    (tasks || []).forEach(function (t) {
      var d = t.duration_days || 0;
      total += d;
      done += d * (t.progress_pct || 0) / 100;
    });
    return total > 0 ? Math.round(done / total * 100) : 0;
  }

  var api = {
    programmeLateness: programmeLateness,
    overallProgress:   overallProgress,
    finishDate:        finishDate,
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.programmeLateness = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
