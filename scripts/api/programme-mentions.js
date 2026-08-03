/* ==========================================================================
   FieldSight Programme — linking site speech to programme tasks
   --------------------------------------------------------------------------
   Spec: docs/superpowers/specs/2026-08-03-programme-breakdown-allocation-design.md §2

   The matcher already works: site speech -> embedding recall -> Claude
   discrimination -> programme_progress_suggestions. What was missing is that
   the result was invisible — a suggestion landed in a review queue while the
   programme task itself showed nothing. This module is the shared data layer
   for putting it back in front of people, in three places:

     on the task     "3/12 Ben on site: '...' -> suggest 50%"
     on the topic    "-> linked to programme: Pour concrete (Level 3)"
     on the timeline a marker on bars that were mentioned

   The third is the least obvious and the most useful, because it makes
   ABSENCE visible: a task nobody has mentioned for weeks currently looks
   exactly like one going fine.

   Which is also the trap this module is built around. Absence of evidence is
   only evidence of absence if you actually loaded the evidence. A caller that
   fetched `?state=pending` and asks "has anyone mentioned this?" would get
   "no" for every task whose mentions were all CONFIRMED — the well-run tasks.
   Silence would light up on exactly the work that is going best.

   So silence is never inferred from an empty lookup. `mentionSummary` takes
   the coverage the caller actually has and returns status 'unknown' when it
   cannot honestly answer, the same way programme-lateness refuses to return
   a bare number.

   Pure: no React, no DOM, no fetch.

   Exported to:
     window.FS.api.programmeMentions   (browser)
     module.exports                    (node:test)
   ========================================================================== */

(function () {
  'use strict';

  /* A task with no site mention for this long is worth surfacing. Three weeks
     rather than one: on a multi-month programme a fortnight of silence on a
     task that has not started yet is normal, and an alert that fires on
     normal is an alert people learn to ignore. */
  var SILENT_AFTER_DAYS = 21;

  /* ----------------------------------------------------------------------
     The document id.

     programme_progress_suggestions.task_id is one text column holding TWO
     identifier spaces: the file's Activity ID for imported rows, our UUID for
     local ones. That rule is programme_snapshot._doc_id in Python and
     programme_tasks.get_task_by_doc_id in SQL; this is the third and last
     place it may live.

     It is a named export precisely so it does not get inlined into a page.
     If the rule ever changes, the failure mode is silent — suggestions simply
     stop appearing next to tasks, with no error anywhere.

     Two task shapes reach this function, which is not obvious and is exactly
     how a half-working version ships:

       document shape  { task_id, wbs, parent_id, ... }   — GET /programme,
                         built by programme_snapshot.build_snapshot, and what
                         the mock fixtures use. `task_id` IS the document id.
       row shape       { id, source_task_id, ... }        — GET
                         /programme/tasks?window=..., straight from Aurora.

     Handling only the row shape works perfectly against the live window
     endpoint and shows nothing in every mock and demo run.
     ---------------------------------------------------------------------- */
  function _str(v) {
    return v === null || v === undefined || v === '' ? null : String(v);
  }

  function docIdOf(task) {
    if (!task) return null;
    // Document shape first: programme_tasks has no `task_id` column, so this
    // cannot shadow a row-shaped task.
    return _str(task.task_id)
        || _str(task.source_task_id)
        || _str(task.id);
  }

  /* Same two-shape problem as docIdOf: the document calls it `start`, the
     Aurora row calls it `start_date`. */
  function startOf(task) {
    return task ? (_str(task.start_date) || _str(task.start)) : null;
  }

  function toUTC(iso) {
    var p = String(iso).split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }

  function daysBetween(a, b) {
    return Math.round((toUTC(b) - toUTC(a)) / 86400000);
  }

  /* Newest first — a task's most recent mention is the one worth showing
     inline, and the rest are history. Ties broken by id so the order is
     stable across renders rather than dependent on fetch order. */
  function _newestFirst(a, b) {
    if (a.report_date !== b.report_date) return a.report_date < b.report_date ? 1 : -1;
    return String(a.id) < String(b.id) ? 1 : -1;
  }

  function _index(rows, keyOf) {
    var out = {};
    (rows || []).forEach(function (r) {
      var k = keyOf(r);
      if (k === null || k === undefined || k === '') return;
      (out[k] = out[k] || []).push(r);
    });
    Object.keys(out).forEach(function (k) { out[k].sort(_newestFirst); });
    return out;
  }

  /* { [docId]: [suggestion, ...] } — what to show ON a programme task. */
  function indexByTask(suggestions) {
    return _index(suggestions, function (s) { return s.task_id; });
  }

  /* { [topicId]: [suggestion, ...] } — what to show ON a report topic, so the
     person who spoke sees that their words landed on the plan.

     Suggestions whose topic was superseded carry topic_id null (the backend's
     ON DELETE SET NULL); they are dropped here rather than bucketed under
     "null", which would render as a phantom topic. */
  function indexByTopic(suggestions) {
    return _index(suggestions, function (s) { return s.topic_id; });
  }

  /* Mentions for one rendered report topic.
     --------------------------------------------------------------------
     READ THIS BEFORE INDEXING A TOPIC ANYWHERE.

     There are two different things called `topic_id`:

       report side      topic.topic_id is PER-REPORT SEQUENTIAL (0, 1, 2…).
                        Every section has a topic 0. The durable Aurora
                        identity is carried separately, as `topic_row_id`
                        (see timeline.js's optimistic-override helpers, which
                        exist because of exactly this distinction).
       suggestion side  suggestion.topic_id is topics.id — a uuid.

     So `byTopic[topic.topic_id]` is the obvious join and it is wrong. It
     matches nothing when the sequential index never equals a uuid, and would
     match the WRONG topic if anything ever normalised the two. This function
     exists so no page has to know that.

     Returns [] for a topic with no durable id (meeting topics carry none),
     rather than falling back to the sequential index. */
  function mentionsForTopic(topic, byTopic) {
    if (!topic) return [];
    var key = _str(topic.topic_row_id);
    if (!key) return [];
    return (byTopic || {})[key] || [];
  }

  /* ----------------------------------------------------------------------
     coverage — what the caller actually loaded.

       { states: ['pending'] | 'all', from: 'YYYY-MM-DD'|null, to: ... }

     `states: 'all'` and a date range covering the period asked about are what
     make a "nobody mentioned this" claim honest. Anything less and
     mentionSummary says so.
     ---------------------------------------------------------------------- */
  function _coversSilence(coverage, since, today) {
    if (!coverage) return false;
    if (coverage.states !== 'all') return false;
    // A range that starts AFTER the period we are claiming silence over tells
    // us nothing about the earlier part of it.
    if (coverage.from && coverage.from > since) return false;
    if (coverage.to && coverage.to < today) return false;
    return true;
  }

  /* { status, count, latest, daysSinceLastMention }

     status:
       'mentioned' — count > 0; latest is the newest suggestion
       'silent'    — nothing in the covered period, and the period is covered
       'unknown'   — nothing found, but the caller did not load enough to
                     tell the difference between "nobody said anything" and
                     "the mentions were all confirmed and we only fetched
                     pending ones"
  */
  function mentionSummary(task, byTask, opts) {
    opts = opts || {};
    var today = opts.today;
    var coverage = opts.coverage;
    var rows = (byTask || {})[docIdOf(task)] || [];

    if (rows.length) {
      var latest = rows[0];
      return {
        status: 'mentioned',
        count: rows.length,
        latest: latest,
        daysSinceLastMention: today && latest.report_date
          ? daysBetween(latest.report_date, today) : null,
      };
    }

    var since = null;
    if (today) {
      var d = toUTC(today);
      d.setUTCDate(d.getUTCDate() - SILENT_AFTER_DAYS);
      since = d.toISOString().slice(0, 10);
    }

    if (!today || !_coversSilence(coverage, since, today)) {
      return {
        status: 'unknown', count: 0, latest: null, daysSinceLastMention: null,
        reason: 'Only part of the suggestion history was loaded, so silence '
                + 'cannot be told apart from mentions that were already '
                + 'reviewed.',
      };
    }

    return {
      status: 'silent', count: 0, latest: null, daysSinceLastMention: null,
      silentSince: since,
    };
  }

  /* Tasks worth asking about: dated, started or due, and silent. Sorted by
     start date so the oldest neglected work leads.

     Deliberately excludes completed tasks — finished work nobody is talking
     about is finished work, not a problem — and tasks that have not started,
     whose silence is expected. */
  function silentTasks(tasks, byTask, opts) {
    opts = opts || {};
    var today = opts.today;
    return (tasks || []).filter(function (t) {
      var start = startOf(t);
      if (!start) return false;
      if (today && start > today) return false;          // not started yet
      if (t.status === 'completed' || t.progress_pct === 100) return false;
      return mentionSummary(t, byTask, opts).status === 'silent';
    }).sort(function (a, b) {
      var x = startOf(a), y = startOf(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }

  var api = {
    docIdOf:          docIdOf,
    startOf:          startOf,
    indexByTask:      indexByTask,
    indexByTopic:     indexByTopic,
    mentionsForTopic: mentionsForTopic,
    mentionSummary:   mentionSummary,
    silentTasks:      silentTasks,
    SILENT_AFTER_DAYS: SILENT_AFTER_DAYS,
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.programmeMentions = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
