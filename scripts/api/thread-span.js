/* ==========================================================================
   api/thread-span.js — what "raised 4×" actually means.
   --------------------------------------------------------------------------
   The badge on a to-do card reads `raised 4×`, and until now its tooltip said
   only "This subject came up on 4 different days and is still open."

   Both halves of that are TRUE — `times_raised` is `count(DISTINCT
   report_date)` (repositories/threads.py:facts_for_threads) and the badge only
   renders on cards in the open list. The problem is not accuracy, it is that
   the number carries no scale. Four days inside one week and four days across
   three months are opposite situations, and the badge rendered them
   identically.

   The scale was already on the wire. `facts_for_threads` returns FOUR facts
   and the payload sends all four inside `topic.thread`:

     times_raised   count(DISTINCT report_date)
     first_seen     min(report_date)
     last_raised    max(report_date)
     open_items     count of action_items with status='open' ACROSS THE THREAD

   The frontend read one. This module turns the other three into the sentence
   the tooltip should have been saying.

   Same shape as the findings defect fixed alongside it: the backend selected
   the field, the payload carried it, the render dropped it.

   Registers as FS.api.threadSpan.
   ========================================================================== */
(function () {
  'use strict';

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* 'YYYY-MM-DD' → '12 Jun 2026', by string surgery rather than Date().
     BUG-19: `new Date('2026-06-12')` parses as UTC and renders as the 11th in
     NZ, which would put a wrong date in a tooltip whose entire purpose is to
     be precise about dates. Returns null for anything that is not a plain ISO
     day, so a malformed value degrades to the short wording instead of
     printing "NaN undefined". */
  function formatDay(iso) {
    if (typeof iso !== 'string') return null;
    var m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    var mon = MONTHS[Number(m[2]) - 1];
    if (!mon) return null;
    return String(Number(m[3])) + ' ' + mon + ' ' + m[1];
  }

  /* The whole tooltip, assembled from whatever facts are present.

     Written to degrade rather than to require: a thread whose facts did not
     come back still gets the sentence it had before, because a missing
     `first_seen` is a reason to say less, not a reason to say nothing. The
     old wording is the floor, never a fallback that reads as an error. */
  function tooltip(opts) {
    opts = opts || {};
    var n = opts.timesRaised;
    if (!n || n < 2) return null;

    var from = formatDay(opts.firstSeen);
    var to = formatDay(opts.lastRaised);

    var span;
    if (from && to && from !== to) {
      span = 'Raised on ' + n + ' different days, from ' + from + ' to ' + to + '.';
    } else if (from && to) {
      /* Same day at both ends with n >= 2 should not be reachable —
         `times_raised` counts DISTINCT dates — but saying "from X to X" if it
         ever happens would look like a bug in the dates rather than in the
         count, and send someone looking in the wrong place. */
      span = 'Raised on ' + n + ' different days.';
    } else {
      span = 'This subject came up on ' + n + ' different days and is still open.';
    }

    /* The thread's open count, and ONLY when it says something the card does
       not already. The card is itself an open item, so `1` means "this one,
       and nothing else" — announcing that as a fact would add a number that
       cannot vary in a way the reader can act on. 0 is impossible here for the
       same reason and is treated as nothing to say rather than as a
       contradiction to render. */
    if (typeof opts.threadOpenItems === 'number' && opts.threadOpenItems > 1) {
      span += ' ' + opts.threadOpenItems + ' items on this subject are still open.';
    }
    return span;
  }

  var mod = { tooltip: tooltip, formatDay: formatDay };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.threadSpan = mod;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = mod;
  }
})();
