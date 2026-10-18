/* ==========================================================================
   FieldSight Programme — measuring how far a programme has been developed
   --------------------------------------------------------------------------
   Spec: docs/superpowers/specs/2026-08-03-programme-breakdown-allocation-design.md §3
   Plan: docs/superpowers/plans/2026-08-03-programme-breakdown-allocation.md Task 7,
         "When unblocked", step 1: *measure both files; set the boundary from
         the two.*

   THIS MODULE MEASURES. IT DOES NOT CLASSIFY.

   That restraint is the whole point of it, so it is stated before the code.
   The design this feeds says: judge a programme's maturity first, then pick
   the mode — mature means "which tasks need intervention", early means
   "propose a breakdown". A wrong judgement costs a second look; a wrong
   generation writes work that does not exist into someone's plan.

   Only one end of that boundary has ever been measured. The Ellesmere
   subcontractor programme (849 tasks, revision 16.10.24) is a LATE revision:
   708 leaves, outline depth 10, median leaf 7 days, 12% of leaves at 15 days
   or more, 99% dependency coverage. There is no early-stage file yet. A
   classifier anchored at one end and guessing the other would look
   quantitative and be arbitrary — and this project has already paid for that
   exact move once, when a dependency-coverage threshold invented at 60% met
   a real file that measured 99%.

   So there is no `isMature`, no score, and no threshold in this file. It
   reports what a programme is, and the boundary gets drawn when there are
   two files to draw it between.

   --------------------------------------------------------------------------
   WHAT IT REFUSES TO ANSWER

   `null` is not a measurement and `0` is not "no dependencies" — both render
   as a claim (`programme-lateness` and `programme-mentions` established this
   rule and refuse the same way). Every signal here carries its own `status`:

     'measured'   the number below it is real
     'unknown'    nothing in the input could answer it

   A programme whose leaves carry no dates yields
   `leafDuration.status === 'unknown'`, not a median of 0 — which would read
   as "every task is instantaneous", the most misleading possible summary of
   a file we simply could not measure.

   --------------------------------------------------------------------------
   INPUT

   Exactly what `programme-import` returns from a real file:

     { parents: [row, …], leaves: [row, …] }

   where a row is the cleaned shape (`cleanXMLRow` / the CSV path): task_id,
   wbs, parent_id, name, start, end, duration_days, depends_on, …

   Depth comes from `wbs` rather than an outline level, because the cleaned
   row is what the consumer is actually handed and it has no `_outlineLevel`.
   A `GET /programme` payload — a flat `tasks[]` with `status === 'group'`
   marking parents — is accepted too, because that is the other shape this
   codebase hands its programme modules, and a module that reads only one of
   the two shapes it is given is a defect this repo has already shipped once.

   Pure: no React, no DOM, no fetch. Reads; decides nothing.

   Exported to:
     window.FS.api.programmeMaturity   (browser — load AFTER api/index.js,
                                        which assigns window.FS.api wholesale)
     module.exports                    (node:test)
   ========================================================================== */

(function () {
  'use strict';

  /* A reporting bucket, NOT a maturity boundary. It exists so the "12% of
     leaves at 15 days or more" figure already measured on the real file
     stays reproducible, and it is a parameter so the next file can be cut
     the same way or differently without editing this module. Nothing in
     here decides anything from it. */
  var DEFAULT_LONG_LEAF_DAYS = 15;

  /* ---------------------------------------------------------------------- */

  function _isFiniteNumber(n) {
    return typeof n === 'number' && isFinite(n);
  }

  function _median(sorted) {
    var n = sorted.length;
    if (n === 0) return null;
    var mid = Math.floor(n / 2);
    return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function _percentile(sorted, p) {
    if (sorted.length === 0) return null;
    var idx = Math.min(sorted.length - 1,
                       Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  }

  /* Days between two YYYY-MM-DD strings, inclusive of both ends — the same
     convention `programme-import` uses for `duration_days`, so a row that
     carries one and a row that only carries dates measure the same way.
     String dates only: `new Date('YYYY-MM-DD')` parses as UTC and drifts a
     day in NZ (BUG-19). */
  function _spanDays(start, end) {
    if (!start || !end) return null;
    var a = Date.parse(start + 'T00:00:00Z');
    var b = Date.parse(end + 'T00:00:00Z');
    if (isNaN(a) || isNaN(b) || b < a) return null;
    return Math.round((b - a) / 86400000) + 1;
  }

  function _durationOf(row) {
    if (_isFiniteNumber(row.duration_days) && row.duration_days > 0) {
      return row.duration_days;
    }
    return _spanDays(row.start || row.start_date, row.end || row.end_date);
  }

  /* WBS "1.4.2" → depth 3. An absent or non-numeric WBS yields null rather
     than 1: a row we cannot place is not a row at the top. */
  function _wbsDepth(row) {
    var wbs = row.wbs;
    if (typeof wbs !== 'string') return null;
    wbs = wbs.trim();
    if (!wbs) return null;
    var parts = wbs.split('.').filter(function (p) { return p.length > 0; });
    return parts.length > 0 ? parts.length : null;
  }

  /* ---------------------------------------------------------------------- */

  /* Accept either shape this codebase hands its programme modules:
       { parents, leaves }  — programme-import
       { tasks }            — GET /programme, groups marked status === 'group'
       [ … ]                — a bare array, same group rule
     Returns { parents, leaves } or null when the input is not a programme. */
  function _normalise(input) {
    if (!input) return null;

    if (Array.isArray(input)) return _normalise({ tasks: input });

    if (Array.isArray(input.parents) || Array.isArray(input.leaves)) {
      return {
        parents: Array.isArray(input.parents) ? input.parents : [],
        leaves:  Array.isArray(input.leaves)  ? input.leaves  : [],
      };
    }

    if (Array.isArray(input.tasks)) {
      var parents = [];
      var leaves  = [];
      input.tasks.forEach(function (t) {
        if (!t) return;
        if (t.status === 'group') parents.push(t);
        else leaves.push(t);
      });
      return { parents: parents, leaves: leaves };
    }

    return null;
  }

  /* ---------------------------------------------------------------------- */

  /**
   * measure(programme, opts) → a description of the programme, no verdict.
   *
   * opts.longLeafDays — the reporting bucket (default 15).
   *
   * Returns:
   *   { status: 'empty' | 'measured' | 'not_a_programme',
   *     counts:       { tasks, parents, leaves },
   *     depth:        { status, max, median, histogram, unplaced },
   *     leafDuration: { status, medianDays, p90Days, maxDays,
   *                     longLeafDays, longCount, longShare, undated },
   *     dependencies: { status, edges, linkedLeaves, leafCoverage,
   *                     danglingRefs } }
   */
  function measure(programme, opts) {
    var options = opts || {};
    var longLeafDays = _isFiniteNumber(options.longLeafDays)
      ? options.longLeafDays
      : DEFAULT_LONG_LEAF_DAYS;

    var norm = _normalise(programme);
    if (!norm) {
      return {
        status: 'not_a_programme',
        reason: 'Expected { parents, leaves } or { tasks } — got ' +
                (programme === null ? 'null' : typeof programme) + '.',
      };
    }

    var parents = norm.parents;
    var leaves  = norm.leaves;
    var all     = parents.concat(leaves);

    var counts = {
      tasks:   all.length,
      parents: parents.length,
      leaves:  leaves.length,
    };

    if (all.length === 0) {
      return {
        status: 'empty',
        reason: 'The programme has no rows.',
        counts: counts,
        depth:        { status: 'unknown', max: null, median: null, histogram: {}, unplaced: 0 },
        leafDuration: { status: 'unknown', medianDays: null, p90Days: null, maxDays: null,
                        longLeafDays: longLeafDays, longCount: null, longShare: null, undated: 0 },
        dependencies: { status: 'unknown', edges: 0, linkedLeaves: null,
                        leafCoverage: null, danglingRefs: 0 },
      };
    }

    /* --- depth ------------------------------------------------------------
       Measured over EVERY row, not only leaves: the depth of a programme is
       how far its hierarchy reaches, and the deepest node may well be a
       summary bar with the real work under it. */
    var depths = [];
    var histogram = {};
    var unplaced = 0;
    all.forEach(function (row) {
      var d = _wbsDepth(row);
      if (d === null) { unplaced++; return; }
      depths.push(d);
      histogram[d] = (histogram[d] || 0) + 1;
    });
    depths.sort(function (a, b) { return a - b; });

    var depth = depths.length === 0
      ? { status: 'unknown', max: null, median: null, histogram: {}, unplaced: unplaced }
      : {
          status:    'measured',
          max:       depths[depths.length - 1],
          median:    _median(depths),
          histogram: histogram,
          unplaced:  unplaced,
        };

    /* --- leaf duration ---------------------------------------------------- */
    var durations = [];
    var undated = 0;
    leaves.forEach(function (row) {
      var d = _durationOf(row);
      if (d === null) { undated++; return; }
      durations.push(d);
    });
    durations.sort(function (a, b) { return a - b; });

    var leafDuration;
    if (durations.length === 0) {
      leafDuration = {
        status: 'unknown', medianDays: null, p90Days: null, maxDays: null,
        longLeafDays: longLeafDays, longCount: null, longShare: null,
        undated: undated,
      };
    } else {
      var longCount = durations.filter(function (d) { return d >= longLeafDays; }).length;
      leafDuration = {
        status:       'measured',
        medianDays:   _median(durations),
        p90Days:      _percentile(durations, 90),
        maxDays:      durations[durations.length - 1],
        longLeafDays: longLeafDays,
        longCount:    longCount,
        /* Share of the leaves we could measure — NOT of all leaves. An
           undated leaf is not a short one, and folding it into the
           denominator would quietly report a finer programme than the file
           describes. `undated` sits beside it so the gap is visible. */
        longShare:    longCount / durations.length,
        undated:      undated,
      };
    }

    /* --- dependencies -----------------------------------------------------
       Coverage = the share of leaves that sit on at least one edge, in
       either direction. A leaf nobody sequenced is the signal; whether it is
       a predecessor or a successor is not. Edges are counted on the leaf
       side only — a summary bar inherits its children's logic and counting
       it would inflate both halves of the ratio.

       Dangling refs (a `depends_on` naming a task_id not in the file) are
       reported rather than dropped: on the real file that number was the
       first visible symptom of the truncated-id collision (ui#191), and a
       measurement that silently discards them would have hidden it. */
    var byId = {};
    all.forEach(function (row) {
      var id = row.task_id || row.id || row.source_task_id;
      if (id) byId[id] = row;
    });

    var linked = {};
    var edges = 0;
    var danglingRefs = 0;

    leaves.forEach(function (row) {
      var id = row.task_id || row.id || row.source_task_id;
      var deps = Array.isArray(row.depends_on) ? row.depends_on : [];
      deps.forEach(function (depId) {
        if (!depId) return;
        if (!byId[depId]) { danglingRefs++; return; }
        edges++;
        if (id) linked[id] = true;
        linked[depId] = true;
      });
    });

    var linkedLeaves = leaves.filter(function (row) {
      var id = row.task_id || row.id || row.source_task_id;
      return id ? !!linked[id] : false;
    }).length;

    var dependencies = leaves.length === 0
      ? { status: 'unknown', edges: edges, linkedLeaves: null,
          leafCoverage: null, danglingRefs: danglingRefs }
      : { status: 'measured', edges: edges, linkedLeaves: linkedLeaves,
          leafCoverage: linkedLeaves / leaves.length, danglingRefs: danglingRefs };

    return {
      status:       'measured',
      counts:       counts,
      depth:        depth,
      leafDuration: leafDuration,
      dependencies: dependencies,
    };
  }

  /* ----------------------------------------------------------------------
     A one-line-per-signal rendering, so a measurement can be read in a
     terminal or pasted into the plan next to the other file's column. It
     prints 'unknown' where a signal is unknown rather than a stand-in
     number, for the same reason `measure` refuses to invent one. */
  function format(result) {
    if (!result || result.status === 'not_a_programme') {
      return 'not a programme: ' + ((result && result.reason) || 'no input');
    }
    if (result.status === 'empty') return 'empty programme (0 rows)';

    function pct(x) { return x === null ? 'unknown' : (Math.round(x * 1000) / 10) + '%'; }
    function num(x) { return x === null ? 'unknown' : String(x); }

    var lines = [
      'tasks                 ' + result.counts.tasks +
        ' (' + result.counts.parents + ' summary / ' + result.counts.leaves + ' leaf)',
      'outline depth         ' + num(result.depth.max) +
        ' (median ' + num(result.depth.median) + ')',
      'median leaf duration  ' + num(result.leafDuration.medianDays) + ' days',
      'p90 leaf duration     ' + num(result.leafDuration.p90Days) + ' days',
      'leaves >= ' + result.leafDuration.longLeafDays + ' days     ' +
        pct(result.leafDuration.longShare) +
        ' (' + num(result.leafDuration.longCount) + ')',
      'dependency coverage   ' + pct(result.dependencies.leafCoverage) +
        ' (' + result.dependencies.edges + ' edges)',
    ];
    if (result.leafDuration.undated > 0) {
      lines.push('undated leaves        ' + result.leafDuration.undated +
                 ' (excluded from the duration figures)');
    }
    if (result.depth.unplaced > 0) {
      lines.push('rows with no WBS      ' + result.depth.unplaced +
                 ' (excluded from depth)');
    }
    if (result.dependencies.danglingRefs > 0) {
      lines.push('dangling depends_on   ' + result.dependencies.danglingRefs +
                 ' (named a task_id absent from the file)');
    }
    return lines.join('\n');
  }

  var api = {
    measure: measure,
    format: format,
    DEFAULT_LONG_LEAF_DAYS: DEFAULT_LONG_LEAF_DAYS,
  };

  /* Guarded, so `require` works under node:test. An unconditional window
     attach is why `programme-import` went untested through every session
     until a real file broke it (ui#194). */
  if (typeof window !== 'undefined') {
    window.FS = window.FS || {};
    window.FS.api = window.FS.api || {};
    window.FS.api.programmeMaturity = api;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
