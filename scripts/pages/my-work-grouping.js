/* ==========================================================================
   FieldSight My Work — bucketing for the caller's own programme work
   --------------------------------------------------------------------------
   Today answers "what do I do today" and stops three days out. My Work
   answers "what do I have coming" across the whole selected window, so it
   needs coarser buckets: WEEK-relative, not day-relative. At a six-week
   horizon "due in 19 days" is noise; "the week of 1 Jun" is not.

   Overdue keeps its own bucket for the same reason it has one on Today — it
   is the one thing worth interrupting for, and burying it mid-list under a
   date heading defeats that. It is omitted entirely when empty.

   One deliberate difference from Today: an UNDATED task is shown here, in its
   own trailing bucket. On Today it is correctly invisible (it cannot be due
   today). Here it is still the caller's work, and hiding it would mean My
   Work is not actually all of my work.

   Pure: no React, no DOM, no fetch.

   Exported to:
     window.FS.api.myWorkGrouping   (browser)
     module.exports                 (node:test)
   ========================================================================== */

(function () {
  'use strict';

  var CLOSED_STATUSES = ['completed', 'cancelled', 'done'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function due(task) {
    return task.end || task.end_date || null;
  }

  function isClosed(task) {
    return CLOSED_STATUSES.indexOf(task.status) !== -1;
  }

  function toUTC(iso) {
    var p = String(iso).split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }

  function iso(d) {
    return d.toISOString().slice(0, 10);
  }

  /* Monday of the week containing `isoDate`. Weeks start Monday because that
     is how a construction week is planned and talked about. */
  function mondayOf(isoDate) {
    var d = toUTC(isoDate);
    var dow = d.getUTCDay();                 /* 0 = Sunday */
    var back = (dow === 0) ? 6 : dow - 1;
    d.setUTCDate(d.getUTCDate() - back);
    return iso(d);
  }

  function addDays(isoDate, n) {
    var d = toUTC(isoDate);
    d.setUTCDate(d.getUTCDate() + n);
    return iso(d);
  }

  function weekLabel(weekMonday, todayMonday) {
    if (weekMonday === todayMonday) return 'This week';
    if (weekMonday === addDays(todayMonday, 7)) return 'Next week';
    var p = weekMonday.split('-').map(Number);
    return 'Week of ' + p[2] + ' ' + MONTHS[p[1] - 1];
  }

  /* Returns [{ key, label, tasks }] — soonest first, overdue leading and
     undated trailing. Buckets that would be empty are absent, not empty. */
  function groupMyWork(tasks, todayISO) {
    var open = (tasks || []).filter(function (t) { return !isClosed(t); });
    if (!open.length) return [];

    var todayMonday = mondayOf(todayISO);
    var overdue = [];
    var undated = [];
    var byWeek = {};

    open.forEach(function (t) {
      var d = due(t);
      if (!d) { undated.push(t); return; }
      if (d < todayISO) { overdue.push(t); return; }
      var wk = mondayOf(d);
      (byWeek[wk] = byWeek[wk] || []).push(t);
    });

    var out = [];
    if (overdue.length) {
      /* Oldest first — the longest-overdue item is the one to look at. Sorted
         on a copy; the caller's array is React state elsewhere. */
      out.push({
        key: 'overdue', label: 'Overdue',
        tasks: overdue.slice().sort(function (a, b) {
          var da = due(a), db = due(b);
          return da < db ? -1 : da > db ? 1 : 0;
        }),
      });
    }

    Object.keys(byWeek).sort().forEach(function (wk) {
      out.push({ key: wk, label: weekLabel(wk, todayMonday), tasks: byWeek[wk] });
    });

    if (undated.length) {
      out.push({ key: 'undated', label: 'No date set', tasks: undated });
    }
    return out;
  }

  var api = {
    groupMyWork:     groupMyWork,
    mondayOf:        mondayOf,
    CLOSED_STATUSES: CLOSED_STATUSES,
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.myWorkGrouping = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
