/* ==========================================================================
   FieldSight Programme — splitting one contract task into zones
   --------------------------------------------------------------------------
   Spec: docs/superpowers/specs/2026-08-03-programme-breakdown-allocation-design.md §4

   "可能是按 level 来的，可能是按 area 或者是 Grades to Grades。把一个大的
   building 分成五块，分给五个不同的 Site Manager。"

   The imported row stays exactly as the client issued it — contract dates,
   untouched — and the split becomes `origin='local'` children beneath it
   (Project 1 §5). So this needs no schema change: `zone` is free text and
   programme_task_assignees carries the allocation. This module is the pure
   part: given a task and a list of zones, what rows should be created.

   --------------------------------------------------------------------------
   WHY PARALLEL IS THE DEFAULT

   The spec's first draft said to divide the parent's span evenly between the
   zones. That is wrong as a default, and this module deliberately contradicts
   it.

   You split a building into five zones and hand them to five site managers
   BECAUSE THE WORK RUNS AT THE SAME TIME — that is what the five managers are
   for. Dividing the span invents a sequence (zone 1 finishes before zone 2
   starts) that nobody stated, and §3 of the same spec forbids exactly this
   move for AI-generated breakdowns: an inferred order must never become data.
   A zone split is the same hazard with a friendlier name — worse, actually,
   because the invented sequence lands on real people's dates.

   Sequential division is still offered, because floor-by-floor splits often
   ARE sequential. It just has to be asked for.

   Contrast with the AI breakdown (§3), which IS sequential — formwork, rebar,
   pour, cure genuinely follow one another. Same-looking operation, opposite
   default, which is why they are separate functions rather than one with a
   flag.

   Pure: no React, no DOM, no fetch. Creates nothing; returns a plan.

   Exported to:
     window.FS.api.programmeZoneSplit   (browser)
     module.exports                     (node:test)
   ========================================================================== */

(function () {
  'use strict';

  function _str(v) {
    return v === null || v === undefined || v === '' ? null : String(v);
  }

  function startOf(t) { return t ? (_str(t.start_date) || _str(t.start)) : null; }
  function endOf(t)   { return t ? (_str(t.end_date)   || _str(t.end))   : null; }

  function toUTC(iso) {
    var p = String(iso).split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }
  function iso(d) { return d.toISOString().slice(0, 10); }
  function addDays(isoDate, n) {
    var d = toUTC(isoDate);
    d.setUTCDate(d.getUTCDate() + n);
    return iso(d);
  }
  function inclusiveDays(a, b) {
    return Math.round((toUTC(b) - toUTC(a)) / 86400000) + 1;
  }

  /* Contiguous, whole-day slices of [start, end]. Remainder days go to the
     EARLIEST slices: on a 10-day task across 3 zones that is 4/3/3 rather
     than 3/3/4. Front-loading is the convention a PM expects — the tail
     absorbs slippage, so leaving it thinnest is the wrong way round. */
  function _sequentialRanges(start, end, n) {
    var total = inclusiveDays(start, end);
    var base = Math.floor(total / n);
    var extra = total % n;
    var out = [];
    var cursor = start;
    for (var i = 0; i < n; i++) {
      var len = base + (i < extra ? 1 : 0);
      var s = cursor;
      var e = addDays(s, len - 1);
      out.push({ start_date: s, end_date: e, duration_days: len });
      cursor = addDays(e, 1);
    }
    return out;
  }

  /* --------------------------------------------------------------------
     planZoneSplit(task, opts) -> { ok, errors, children }

     opts:
       zones        ['Level 1', 'Level 2', ...]   required, non-empty
       assignees    ['ben', 'sam', ...]           optional, positional
       distribute   'parallel' (default) | 'sequential'
       nameTemplate '{name} — {zone}' by default

     Returns errors rather than throwing: this runs behind a form, and every
     error here is something a person typed.
     -------------------------------------------------------------------- */
  function planZoneSplit(task, opts) {
    opts = opts || {};
    var errors = [];
    var zones = (opts.zones || []).map(function (z) {
      return String(z === null || z === undefined ? '' : z).trim();
    });
    var distribute = opts.distribute || 'parallel';
    var template = opts.nameTemplate || '{name} — {zone}';

    if (!task) errors.push('No task to split.');
    if (!zones.length) errors.push('Name at least one zone.');
    if (zones.some(function (z) { return !z; })) {
      errors.push('A zone needs a name.');
    }

    /* Two zones with the same name is a typo, not an intent. Silently
       merging them would drop one manager's allocation with no trace. */
    var seen = {}, dupes = [];
    zones.forEach(function (z) {
      var k = z.toLowerCase();
      if (k && seen[k]) { if (dupes.indexOf(z) < 0) dupes.push(z); }
      seen[k] = true;
    });
    if (dupes.length) errors.push('Duplicate zone: ' + dupes.join(', ') + '.');

    var start = startOf(task), end = endOf(task);

    /* An undated row is a WBS header, not work (the same rule
       programme_snapshot uses to split parents from leaves). Splitting one
       would create dated children under an undated parent, which reads as a
       schedule nobody wrote. */
    if (task && (!start || !end)) {
      errors.push('This is a structural heading with no dates, so there is '
                  + 'nothing to divide. Split the tasks underneath it.');
    }

    if (start && end && distribute === 'sequential'
        && zones.length > inclusiveDays(start, end)) {
      errors.push('This task is ' + inclusiveDays(start, end) + ' days long '
                  + 'and cannot be divided into ' + zones.length
                  + ' consecutive parts. Run the zones in parallel instead.');
    }

    if (opts.assignees && opts.assignees.length
        && opts.assignees.length !== zones.length) {
      errors.push('Give one person per zone, or none at all.');
    }

    if (errors.length) return { ok: false, errors: errors, children: [] };

    var ranges = distribute === 'sequential'
      ? _sequentialRanges(start, end, zones.length)
      /* Parallel: every zone inherits the parent's dates verbatim. No
         sequence is invented, and the PM drags whatever is genuinely
         staggered. */
      : zones.map(function () {
          return { start_date: start, end_date: end,
                   duration_days: inclusiveDays(start, end) };
        });

    var children = zones.map(function (zone, i) {
      return {
        name: template.replace('{name}', task.name || '').replace('{zone}', zone),
        zone: zone,
        assignee: (opts.assignees || [])[i] || null,
        start_date: ranges[i].start_date,
        end_date: ranges[i].end_date,
        duration_days: ranges[i].duration_days,
        /* Always local: only an import mints imported rows, and these have to
           survive the next one. */
        origin: 'local',
        status: 'not_started',
        progress_pct: 0,
      };
    });

    return { ok: true, errors: [], children: children };
  }

  /* Does the plan still fit inside the contract dates?

     The parent is NOT recomputed from its children (Project 1 §5), so a split
     that runs past the contract end stays visible instead of quietly moving
     the deadline. This is what makes that visible. */
  function overrunDays(task, children) {
    var end = endOf(task);
    if (!end || !children || !children.length) return 0;
    var latest = children.reduce(function (acc, c) {
      return !acc || c.end_date > acc ? c.end_date : acc;
    }, null);
    return latest && latest > end ? inclusiveDays(end, latest) - 1 : 0;
  }

  var api = {
    planZoneSplit: planZoneSplit,
    overrunDays:   overrunDays,
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.programmeZoneSplit = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
