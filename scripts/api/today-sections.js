/* ==========================================================================
   FieldSight Today — section model
   --------------------------------------------------------------------------
   Today answers one question: what do I do today. Everything else assigned to
   the caller lives in My Work.

   That split is the point. A Today that lists everything assigned to someone
   stops being read, and then the things that genuinely needed attention today
   are lost along with the noise. Three sections only:

     overdue   past its date and still open — the single thing allowed to
               interrupt, rendered red and HIDDEN ENTIRELY when empty. A
               permanent "0 overdue" heading trains people to skip the
               section that matters most.
     today     due today
     soon      due within the next SOON_DAYS days

   Anything further out is deliberately absent: it is My Work's job.

   Pure: no React, no DOM, no fetch.

   Exported to:
     window.FS.api.todaySections   (browser)
     module.exports                (node:test)
   ========================================================================== */

(function () {
  'use strict';

  var SOON_DAYS = 3;

  /* Closed work cannot be late. Treating a completed task with a past date as
     overdue would put a permanent red section in front of people until they
     learned to ignore the colour — at which point the section is worse than
     useless. `blocked` is deliberately NOT here: it is open, and it is exactly
     what a PM needs to see. */
  var CLOSED_STATUSES = ['completed', 'cancelled', 'done'];

  function dueDate(task) {
    return task.end || task.end_date || null;
  }

  function isClosed(task) {
    return CLOSED_STATUSES.indexOf(task.status) !== -1;
  }

  function addDays(iso, n) {
    var p = String(iso).split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /* Returns { overdue, today, soon } — every task in at most one bucket, and
     tasks beyond the soon window in none of them. */
  function bucketTodayTasks(tasks, todayISO) {
    var out = { overdue: [], today: [], soon: [] };
    var soonEnd = addDays(todayISO, SOON_DAYS);

    (tasks || []).forEach(function (task) {
      if (isClosed(task)) return;
      var due = dueDate(task);
      /* An undated task cannot be late. Without this the red section would be
         permanent on any programme carrying open-ended work. */
      if (!due) return;

      if (due < todayISO)      out.overdue.push(task);
      else if (due === todayISO) out.today.push(task);
      else if (due <= soonEnd)   out.soon.push(task);
    });

    /* Oldest first: the longest-overdue item is the one to look at. Sorting a
       copy — the caller's array is React state elsewhere. */
    out.overdue = out.overdue.slice().sort(function (a, b) {
      var da = dueDate(a), db = dueDate(b);
      return da < db ? -1 : da > db ? 1 : 0;
    });

    return out;
  }

  var api = {
    SOON_DAYS:        SOON_DAYS,
    CLOSED_STATUSES:  CLOSED_STATUSES,
    bucketTodayTasks: bucketTodayTasks,
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.todaySections = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
