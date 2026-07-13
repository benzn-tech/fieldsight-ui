/* ==========================================================================
   FieldSight API · Today-Programme adapter (Sprint 4.10)
   --------------------------------------------------------------------------
   Bridges Programme (the high-level work plan) into the Today page,
   so a user logging in sees the programme tasks they're scheduled
   on TODAY alongside the action items derived from yesterday's
   daily report.

   Returns rows shaped to slot into the existing `myTasks` list,
   distinguished by `source: 'programme'` (vs `'action_item'` for
   the existing daily-report-derived rows). Today's UI uses that
   marker to render a separate sub-group with the ProgrammeTaskCard
   visual variant.

   Worker rule (BACKEND-CONTEXT §3) is honoured automatically in mock mode
   — the underlying FS.api.programme.getProgramme worker-scopes tasks
   client-side. The live org-api endpoint doesn't; this adapter still
   applies the caller-folder filter itself further down regardless of
   mode, so worker scoping holds either way.

   UI batch 2026-07-08 / F4 note: FS.api.programme.getProgramme now takes
   the ORG SITE UUID, not a programme_id (see api/programme.js header).
   Today has no active-site concept by design (site-context.js exempts
   it), so this adapter can't resolve "the" site the way the Programme
   page's picker does. It USED TO fall back to the first org site
   returned by org.getOrgSites() — correct only for the single-site
   deployment this shipped against.

   feat/today-by-project — real fan-out. Every org site returned by
   org.getOrgSites() is now queried (pooled via FS.api.pooledAll, same
   bounded-concurrency helper the admin cross-products in
   tasks-aggregator.js / compliance-aggregator.js use), not just
   sites[0]. The existing `folder` assignee filter is unchanged and does
   the real access-scoping per BACKEND-CONTEXT §3: when a folder is
   resolved (normal caller), only tasks that list them as an assignee on
   THAT site survive; when folder is null (admin without an explicit
   user), every task on every site is returned, matching the "fall
   through and return everything they can see" comment below. Each
   surviving row is stamped with `site_name` / `site_slug` from the org
   site it came from. A single site's fetch failing is swallowed
   (pooledAll → null → filtered) rather than failing the whole page.

   Returned shape:
     {
       rows: [
         {
           source:        'programme',
           task_id:       'T-004',
           wbs:           '2.1',
           name:          'Steel frame',
           start:         '2026-05-01',
           end:           '2026-05-15',
           duration_days: 15,
           progress_pct:  12,
           status:        'in_progress',
           critical:      true,
           day_index:     1,        // 1-based: day N of M
           day_total:     15,
           assignees:     ['Jarley_Trainor', 'Ben_Lin', 'David_Barillaro'],
           linked_action_items: [{ date, topic_id, action_index }, ...],
           site_name:     'SB1108 Ellesmere College',
           site_slug:     'sb1108-ellesmere',   // org site_id; null on a
                                                 // malformed site record
         },
         ...
       ],
     }

   Exported to:
     window.FS.api.todayProgramme.getTodayProgrammeTasks({ today, user? })
   ========================================================================== */

(function () {
  'use strict';

  function callerFolder() {
    var u = (window.AuthMock && window.AuthMock.currentUser) || {};
    if (!u.name) return null;
    return window.FS.api.folderName(u.name);
  }

  function diffDays(fromISO, toISO) {
    var a = new Date(fromISO + 'T00:00:00Z').getTime();
    var b = new Date(toISO   + 'T00:00:00Z').getTime();
    return Math.round((b - a) / 86400000);
  }

  async function getTodayProgrammeTasks(opts) {
    opts = opts || {};
    var today = opts.today || (window.FS.api.todayNZDT && window.FS.api.todayNZDT());
    if (!today) return { rows: [] };

    var folder = opts.user || callerFolder();

    var sitesRes = await window.FS.api.org.getOrgSites().catch(function () { return null; });
    if (!sitesRes || sitesRes._accessDenied || !(sitesRes.sites || []).length) {
      return { rows: [] };
    }
    var orgSites = sitesRes.sites;

    /* Pooled, not Promise.all — mirrors the admin cross-product pooling
       in tasks-aggregator.js / compliance-aggregator.js. A failed site's
       getProgramme() maps to null via pooledAll and is filtered out
       below rather than failing the whole Today page. */
    var siteThunks = orgSites.map(function (site) {
      return function () {
        return window.FS.api.programme.getProgramme(site.site_id)
          .then(function (res) { return { site: site, res: res }; });
      };
    });
    var perSite = (await window.FS.api.pooledAll(siteThunks, 8)).filter(Boolean);

    var sched = window.FieldSight && window.FieldSight.programmeSchedule;
    var rows = [];

    perSite.forEach(function (entry) {
      var site = entry.site;
      var res  = entry.res;
      if (!res || res._notFound || res._accessDenied || !res.programme) return;

      var doc    = res.programme;
      var leaves = doc.leaves || [];
      var critical = new Set(sched ? sched.computeCriticalPath(leaves, doc.start_date) : []);

      leaves.forEach(function (t) {
        /* Today must fall within the task's date range. */
        if (today < t.start || today > t.end) return;
        /* Caller must be in the assignee list. (When folder is null —
           e.g. admin without an explicit folder — fall through and
           return everything they can see.) */
        if (folder && (t.assignees || []).indexOf(folder) === -1) return;

        var dayIndex = diffDays(t.start, today) + 1;          /* 1-based */
        var dayTotal = (t.duration_days != null)
          ? t.duration_days
          : (diffDays(t.start, t.end) + 1);

        rows.push({
          source:               'programme',
          task_id:              t.task_id,
          wbs:                  t.wbs,
          name:                 t.name,
          start:                t.start,
          end:                  t.end,
          duration_days:        dayTotal,
          progress_pct:         t.progress_pct || 0,
          status:               t.status,
          critical:             critical.has(t.task_id),
          day_index:            dayIndex,
          day_total:            dayTotal,
          assignees:            t.assignees || [],
          linked_action_items:  t.linked_action_items || [],
          tags:                 t.tags || [],
          site_name:            site.name || null,
          site_slug:            site.site_id || null,
        });
      });
    });

    /* Sort: critical first, then by progress desc (closest to done
       wraps up first in the user's mental model). */
    rows.sort(function (a, b) {
      if (a.critical !== b.critical) return a.critical ? -1 : 1;
      return (b.progress_pct || 0) - (a.progress_pct || 0);
    });

    return { rows: rows, today: today, user: folder };
  }

  /* =========================================================================
     feat/today-rolling-open-items — getUpcomingProgrammeTasks({from, to, user?})
     -------------------------------------------------------------------------
     Widened sibling of getTodayProgrammeTasks above: instead of "is this
     task ACTIVE today" (today between start/end), this asks "is this
     task's DEADLINE (its `end`) coming up in the next N days" — a task
     that hasn't started yet but is due soon still surfaces, one that's
     active today but not due for months does not. Overdue (`end` <
     `from`) is explicitly OUT of scope here — deadlines are free-text /
     unreliable per the Today rework spec, so this only ever looks
     forward.

     Same fan-out (every org site, pooled), same worker/assignee scoping,
     same row shape as getTodayProgrammeTasks (plus one additive field,
     deadline_in_days) so the existing ProgrammeTaskCard render and the
     `data.programmeTasks` wiring in today.js need zero changes to
     consume either function's output interchangeably.

     Exported to:
       window.FS.api.todayProgramme.getUpcomingProgrammeTasks({ from, to, user? })
     ========================================================================= */
  async function getUpcomingProgrammeTasks(opts) {
    opts = opts || {};
    var from = opts.from || (window.FS.api.todayNZDT && window.FS.api.todayNZDT());
    var to   = opts.to;
    if (!from || !to) return { rows: [] };

    var folder = opts.user || callerFolder();

    var sitesRes = await window.FS.api.org.getOrgSites().catch(function () { return null; });
    if (!sitesRes || sitesRes._accessDenied || !(sitesRes.sites || []).length) {
      return { rows: [] };
    }
    var orgSites = sitesRes.sites;

    var siteThunks = orgSites.map(function (site) {
      return function () {
        return window.FS.api.programme.getProgramme(site.site_id)
          .then(function (res) { return { site: site, res: res }; });
      };
    });
    var perSite = (await window.FS.api.pooledAll(siteThunks, 8)).filter(Boolean);

    var sched = window.FieldSight && window.FieldSight.programmeSchedule;
    var rows = [];

    perSite.forEach(function (entry) {
      var site = entry.site;
      var res  = entry.res;
      if (!res || res._notFound || res._accessDenied || !res.programme) return;

      var doc    = res.programme;
      var leaves = doc.leaves || [];
      var critical = new Set(sched ? sched.computeCriticalPath(leaves, doc.start_date) : []);

      leaves.forEach(function (t) {
        /* Deadline (end) must fall within [from, to] — never in the
           past relative to `from` (that's "overdue", out of scope). */
        if (!t.end || t.end < from || t.end > to) return;
        if (folder && (t.assignees || []).indexOf(folder) === -1) return;

        /* day_index/day_total only make sense once the task has
           actually started — a near-deadline task that hasn't started
           yet (t.start > from) omits both so ProgrammeTaskCard's
           `row.day_index && row.day_total` guard hides the "Day N of
           M" line instead of showing a confusing negative day count. */
        var started  = from >= t.start;
        var dayIndex = started ? diffDays(t.start, from) + 1 : null;
        var dayTotal = started
          ? ((t.duration_days != null) ? t.duration_days : (diffDays(t.start, t.end) + 1))
          : null;

        rows.push({
          source:               'programme',
          task_id:              t.task_id,
          wbs:                  t.wbs,
          name:                 t.name,
          start:                t.start,
          end:                  t.end,
          duration_days:        t.duration_days != null ? t.duration_days : (diffDays(t.start, t.end) + 1),
          progress_pct:         t.progress_pct || 0,
          status:               t.status,
          critical:             critical.has(t.task_id),
          day_index:            dayIndex,
          day_total:            dayTotal,
          assignees:            t.assignees || [],
          linked_action_items:  t.linked_action_items || [],
          tags:                 t.tags || [],
          site_name:            site.name || null,
          site_slug:            site.site_id || null,
          /* Additive — how many days until the deadline. Not consumed
             by ProgrammeTaskCard today; here for the sort below and
             for any future "Due in Nd" affordance. */
          deadline_in_days:     diffDays(from, t.end),
        });
      });
    });

    /* Soonest deadline first, then critical, then progress desc. */
    rows.sort(function (a, b) {
      if (a.deadline_in_days !== b.deadline_in_days) return a.deadline_in_days - b.deadline_in_days;
      if (a.critical !== b.critical) return a.critical ? -1 : 1;
      return (b.progress_pct || 0) - (a.progress_pct || 0);
    });

    return { rows: rows, from: from, to: to, user: folder };
  }

  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};
  window.FS.api.todayProgramme = {
    getTodayProgrammeTasks:    getTodayProgrammeTasks,
    getUpcomingProgrammeTasks: getUpcomingProgrammeTasks,
  };

})();
