/* ==========================================================================
   FieldSight Programme — "what should I worry about"
   --------------------------------------------------------------------------
   Spec: docs/superpowers/specs/2026-08-03-ask-programme-routing-examples.md §3.5

   The third Ask route, and the first one worth building. Not retrieval and
   not a free-form query: hand back the alerts the programme has ALREADY
   computed.

   Every signal here is shipped and tested elsewhere — silent tasks
   (programme-mentions), lateness against baseline (programme-lateness),
   overdue and blocked (plain fields). This module recognises the class of
   question and assembles them; it computes no new judgement of its own.

   --------------------------------------------------------------------------
   WHY THIS ROUTE FIRST

   Real query logs run ~14:1 toward retrieval, so the structured-query branch
   is not the urgent one. This route is, for three reasons:

     - every signal already exists, so there is no new query surface
     - it is the only route that answers "I don't know what to ask", which is
       the state a site manager is most often in
     - it carries no routing downside. Misrouting INTO it shows a screen of
       genuinely useful information; misrouting OUT of it degrades to RAG,
       which is today's behaviour. The table branch's failure mode, by
       contrast, is a silently incomplete list.

   --------------------------------------------------------------------------
   WHAT IT REFUSES

   An alert set assembled from data that was not loaded is worse than no
   answer, because "nothing to worry about" is a claim. Each section carries
   its own availability, and a section whose inputs are missing is OMITTED
   rather than rendered empty — the same refusal programme-lateness and
   programme-mentions already make individually.

   Pure: no React, no DOM, no fetch.

   Exported to:
     window.FS.api.programmeAlerts   (browser)
     module.exports                  (node:test)
   ========================================================================== */

(function () {
  'use strict';

  /* Questions this route answers. Deliberately narrow: the cost of matching
     too widely is stealing a question RAG would have answered well, and RAG
     is what people actually ask 14 times out of 15.

     "issue" is deliberately ABSENT. It was in the first version and it stole
     a real logged question -- "does today's door issue relevant with any
     previous issue?" -- which is a retrieval question about a topic. On a
     construction site "issue" names a subject far more often than a state,
     and it is the most overloaded word in the domain. "problem" is kept
     because it does not carry that second sense. */
  var WORRY = /\b(worry|worried|concern(ed|s)?|at risk|risks?|attention|watch out|problem(s)?|behind|slipping|going wrong|off track)\b/i;
  var SCOPE = /\b(i|we|my|our|us|anything|what|which|any)\b/i;

  /* Speech verbs are decisive for retrieval — "were any risks flagged" is a
     question about what was SAID, and the report answers it far better than
     a list of task states. Checked before WORRY so it wins. */
  var SPEECH = /\b(say|said|says|saying|mention(ed)?|discuss(ed)?|talk(ed|ing)?|raise[dn]?|told|tell|flagged|reported)\b/i;

  /* A named subject means they are asking about a thing, not for a sweep:
     "is the slab pour at risk" is one task, not "what should I worry about".
     Only a leading-question shape with no object reaches this route. */
  function isAlertsQuestion(text) {
    var q = String(text || '').trim();
    if (!q) return false;
    if (SPEECH.test(q)) return false;
    if (!WORRY.test(q)) return false;
    return SCOPE.test(q);
  }

  function _str(v) {
    return v === null || v === undefined || v === '' ? null : String(v);
  }
  function startOf(t) { return t ? (_str(t.start_date) || _str(t.start)) : null; }
  function endOf(t)   { return t ? (_str(t.end_date)   || _str(t.end))   : null; }

  function isFinished(t) {
    return t.status === 'completed' || t.progress_pct === 100;
  }

  /* Past its end date and not finished. A plain comparison, which is exactly
     what retrieval cannot do. */
  function overdueTasks(tasks, today) {
    if (!today) return [];
    return (tasks || []).filter(function (t) {
      var end = endOf(t);
      return end && end < today && !isFinished(t);
    }).sort(function (a, b) {
      return endOf(a) < endOf(b) ? -1 : endOf(a) > endOf(b) ? 1 : 0;
    });
  }

  function blockedTasks(tasks) {
    return (tasks || []).filter(function (t) {
      return t.status === 'blocked' && !isFinished(t);
    });
  }

  /* Started, unfinished, and not due for weeks — the ones a person is most
     likely to have forgotten rather than deprioritised. */
  function notStartedButDue(tasks, today) {
    if (!today) return [];
    return (tasks || []).filter(function (t) {
      var start = startOf(t);
      return start && start < today && t.status === 'not_started';
    });
  }

  /* --------------------------------------------------------------------
     buildAlerts(opts) -> { sections: [...], empty, unavailable }

     opts:
       tasks      leaf tasks in scope
       today      'YYYY-MM-DD'; without it the date-based sections are omitted
       silent     result of programmeMentions.silentTasks, or null when the
                  caller could not establish coverage
       lateness   result of programmeLateness, or null

     A section is present only when its inputs were available. `unavailable`
     names what could not be checked, so the caller can say so rather than
     implying a clean bill of health.
     -------------------------------------------------------------------- */
  function buildAlerts(opts) {
    opts = opts || {};
    var tasks = opts.tasks || [];
    var today = opts.today || null;
    var sections = [];
    var unavailable = [];

    var late = opts.lateness;
    if (late && late.status === 'ok' && late.days > 0) {
      sections.push({
        key: 'lateness', severity: 'high',
        title: late.days + ' day' + (late.days === 1 ? '' : 's') + ' behind baseline',
        detail: 'Projected finish ' + late.projectedFinish
                + ' against a baseline of ' + late.baselineFinish + '.',
        items: [],
      });
    } else if (!late || late.status !== 'ok') {
      /* No baseline, or no dependency data. Saying nothing here would imply
         the programme is on time. */
      unavailable.push(late && late.message ? late.message
                       : 'progress against baseline');
    }

    if (today) {
      var overdue = overdueTasks(tasks, today);
      if (overdue.length) {
        sections.push({
          key: 'overdue', severity: 'high',
          title: overdue.length + ' task' + (overdue.length === 1 ? '' : 's')
                 + ' past their end date',
          items: overdue,
        });
      }
      var late_start = notStartedButDue(tasks, today);
      if (late_start.length) {
        sections.push({
          key: 'not_started', severity: 'medium',
          title: late_start.length + ' task' + (late_start.length === 1 ? '' : 's')
                 + ' due to have started',
          items: late_start,
        });
      }
    } else {
      unavailable.push('anything date-based');
    }

    var blocked = blockedTasks(tasks);
    if (blocked.length) {
      sections.push({
        key: 'blocked', severity: 'high',
        title: blocked.length + ' task' + (blocked.length === 1 ? '' : 's') + ' blocked',
        items: blocked,
      });
    }

    /* null means the caller could not establish coverage — NOT that nothing
       is silent. silentTasks already refuses to guess; this preserves that
       refusal instead of flattening it to an empty list. */
    if (opts.silent === null || opts.silent === undefined) {
      unavailable.push('which tasks nobody has mentioned');
    } else if (opts.silent.length) {
      sections.push({
        key: 'silent', severity: 'medium',
        title: opts.silent.length + ' task'
               + (opts.silent.length === 1 ? '' : 's')
               + ' nobody has mentioned on site',
        items: opts.silent,
      });
    }

    var order = { high: 0, medium: 1, low: 2 };
    sections.sort(function (a, b) { return order[a.severity] - order[b.severity]; });

    return {
      sections: sections,
      unavailable: unavailable,
      /* "Nothing to worry about" is only sayable when everything was
         checkable. Otherwise it is silence dressed as reassurance. */
      empty: sections.length === 0 && unavailable.length === 0,
    };
  }

  var api = {
    isAlertsQuestion:  isAlertsQuestion,
    buildAlerts:       buildAlerts,
    overdueTasks:      overdueTasks,
    blockedTasks:      blockedTasks,
    notStartedButDue:  notStartedButDue,
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.programmeAlerts = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
