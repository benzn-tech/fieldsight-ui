/* ==========================================================================
   FieldSight Programme — validating an AI breakdown proposal
   --------------------------------------------------------------------------
   Spec: docs/superpowers/specs/2026-08-03-programme-breakdown-allocation-design.md §3
   Plan: docs/superpowers/plans/2026-08-03-programme-breakdown-allocation.md Task 7a

   "有的时候这个 program 是非常 high level，比如说 pour concrete，它不会说很细节，
   前面的准备工作。"

   The model proposes steps; this decides whether they may become rows. It is
   the deterministic half of Task 7, and it is written BEFORE the prompt on
   purpose: the contract a proposal must satisfy is ours to define, not the
   model's to reveal. Waiting for a real programme would only have delayed
   the half that does not depend on one.

   --------------------------------------------------------------------------
   WHAT IT REFUSES, AND WHY EACH ONE MATTERS

   An inferred ORDER is never stored. §3 forbids it and §4 learned it the
   hard way: a sequence nobody stated, written as data, lands on real
   people's dates. A proposal may carry `after` hints; they are dropped here
   and offered to the PM separately, never persisted by this path.

   A proposal that does not cover the parent is rejected. Steps summing to
   three days under a ten-day task means the model dropped most of the work,
   and accepting it would produce a breakdown whose rollup reports the task
   nearly done the moment the first step finishes (programme-rollup's
   coverage rule would call it `partial`, but by then the rows exist).

   Nothing is coerced. A step with no duration is not given a default; the
   whole proposal is refused. Silently inventing a number here is how a
   plausible-looking schedule gets built out of a model's omission.

   Contrast with programme-zone-split: zones run in PARALLEL by default,
   because five managers on five zones work at the same time. Breakdown
   steps are SEQUENTIAL — formwork, rebar, pour, cure genuinely follow one
   another. Same-looking operation, opposite default, which is why they are
   separate modules rather than one with a flag.

   Pure: no React, no DOM, no fetch. Creates nothing; returns a plan.

   Exported to:
     window.FS.api.programmeBreakdown   (browser)
     module.exports                     (node:test)
   ========================================================================== */

(function () {
  'use strict';

  /* The user's brief: "拆个 4 条，稍微粗糙一点". Bounds rather than a target —
     a two-step breakdown is usually the model restating the task, and past
     six it is inventing detail nobody asked for. */
  var MIN_STEPS = 2;
  var MAX_STEPS = 8;

  /* How far the steps may fall short of the parent's span before the
     proposal is refused. Some slack is right: a model that lands 9 of 10
     days has understood the task. */
  var MIN_COVERAGE = 0.8;

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

  /* --------------------------------------------------------------------
     validateProposal(task, proposal) -> { ok, errors, children }

     `proposal` is what the model returned, already JSON-parsed:
       { steps: [ { name, duration_days, after? }, ... ] }

     Returns errors rather than throwing: every one of them is something a
     person will read before deciding whether to accept.
     -------------------------------------------------------------------- */
  function validateProposal(task, proposal) {
    var errors = [];
    var steps = (proposal && proposal.steps) || [];
    var start = startOf(task), end = endOf(task);

    if (!task) errors.push('No task to break down.');

    /* Same rule as a zone split: an undated row is a WBS header, and dated
       children under an undated parent read as a schedule nobody wrote. */
    if (task && (!start || !end)) {
      errors.push('This is a structural heading with no dates, so there is '
                  + 'nothing to break down. Break down the tasks underneath '
                  + 'it.');
    }

    if (!steps.length) {
      errors.push('The proposal contained no steps.');
    } else if (steps.length < MIN_STEPS) {
      errors.push('A single step is not a breakdown.');
    } else if (steps.length > MAX_STEPS) {
      errors.push('This proposes ' + steps.length + ' steps. More than '
                  + MAX_STEPS + ' is detail nobody asked for — ask again.');
    }

    var named = 0, total = 0;
    steps.forEach(function (s, i) {
      var name = _str(s && s.name);
      if (!name) {
        errors.push('Step ' + (i + 1) + ' has no name.');
      } else {
        named++;
      }
      var d = s && s.duration_days;
      /* Not coerced. A missing or nonsense duration refuses the proposal
         rather than being defaulted — inventing a number here is how a
         plausible schedule gets built out of the model's omission. */
      if (typeof d !== 'number' || !isFinite(d) || d <= 0
          || Math.floor(d) !== d) {
        errors.push('Step ' + (i + 1) + ' ("' + (name || '?')
                    + '") has no usable duration.');
      } else {
        total += d;
      }
    });

    /* Duplicate names would produce two indistinguishable rows on the Gantt
       and two indistinguishable entries on somebody's to-do list. */
    var seen = {}, dupes = [];
    steps.forEach(function (s) {
      var k = (_str(s && s.name) || '').toLowerCase();
      if (k && seen[k] && dupes.indexOf(s.name) < 0) dupes.push(s.name);
      seen[k] = true;
    });
    if (dupes.length) errors.push('Duplicate step: ' + dupes.join(', ') + '.');

    if (start && end && named === steps.length && !errors.length) {
      var span = inclusiveDays(start, end);
      if (total > span) {
        errors.push('These steps add up to ' + total + ' days against a '
                    + span + '-day task. Ask again, or extend the task '
                    + 'first.');
      } else if (total / span < MIN_COVERAGE) {
        errors.push('These steps cover only ' + total + ' of ' + span
                    + ' days. Most of the work is missing — ask again.');
      }
    }

    if (errors.length) return { ok: false, errors: errors, children: [] };

    /* Sequential, tiling the parent's span from its start. Any remainder is
       left at the END rather than padded into the steps: the model sized the
       work, and stretching its numbers to fill the box would be this
       module's own invention. */
    var cursor = start;
    var children = steps.map(function (s) {
      var childStart = cursor;
      var childEnd = addDays(childStart, s.duration_days - 1);
      cursor = addDays(childEnd, 1);
      return {
        name: s.name,
        start_date: childStart,
        end_date: childEnd,
        duration_days: s.duration_days,
        /* Always local: only an import mints imported rows, and these have
           to survive the next one. */
        origin: 'local',
        status: 'not_started',
        progress_pct: 0,
        /* Deliberately absent: depends_on. The proposal's `after` hints are
           dropped — see the module header. */
      };
    });

    return { ok: true, errors: [], children: children };
  }

  /* The order the model suggested, as a PROPOSAL for a person to accept —
     never written by validateProposal, and never stored as `depends_on`
     without that acceptance. Returned separately so a caller cannot pass it
     to a write path by accident. */
  function suggestedOrder(proposal) {
    return ((proposal && proposal.steps) || [])
      .filter(function (s) { return s && s.after; })
      .map(function (s) { return { step: s.name, after: s.after }; });
  }

  var api = {
    validateProposal: validateProposal,
    suggestedOrder:   suggestedOrder,
    MIN_STEPS:        MIN_STEPS,
    MAX_STEPS:        MAX_STEPS,
    MIN_COVERAGE:     MIN_COVERAGE,
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.programmeBreakdown = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
