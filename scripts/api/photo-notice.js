/* ==========================================================================
   FieldSight · photo-notice — the photographer's heads-up about a day's reports
   --------------------------------------------------------------------------
   Owner, 2026-10-01: a report carries 60 photographs at page size, up to 120
   shrunk automatically, and past 120 the person chooses what to leave out.
   The person who took them is told -- nobody else -- before the report, not
   after: at 50 ("past 60 they go in smaller") and past 120 ("choose").

   The server decides (GET /api/org/photos/notice reads the CALLER's own
   folder only); this polls and holds nothing of its own, like name-proposals.
   A bell row, never a toast: someone on a site taking photographs does not
   need the product interrupting them.

   Exposed as window.FS.photoNotice
   ========================================================================== */
(function () {
  'use strict';

  /* Photographs arrive at walking pace and the line that matters is 50; five
     minutes is soon enough and cheap enough to run on every page. */
  var POLL_MS = 300000;
  var state = { notices: [], loaded: false };
  var subs = [];
  var timer = null;
  var inflight = null;

  function snapshot() {
    return { notices: state.notices.slice(), loaded: state.loaded };
  }

  function emit() {
    subs.slice().forEach(function (fn) {
      try { fn(snapshot()); } catch (e) { /* a bad subscriber must not stop the rest */ }
    });
  }

  async function doRefresh() {
    var org = ((window.FS || {}).api || {}).org;
    if (!org || !org.getPhotoNotice) { inflight = null; return; }
    try {
      var r = await org.getPhotoNotice();
      state.notices = (r && Array.isArray(r.notices)) ? r.notices : [];
    } catch (e) {
      /* keep the last answer: a failed poll is not "no notices" */
    }
    state.loaded = true;
    inflight = null;
    emit();
  }

  function refresh() {
    if (inflight) return inflight;
    inflight = doRefresh();
    return inflight;
  }

  function subscribe(fn) {
    subs.push(fn);
    if (!timer) { refresh(); timer = setInterval(refresh, POLL_MS); }
    fn(snapshot());
    return function () {
      var i = subs.indexOf(fn);
      if (i >= 0) subs.splice(i, 1);
    };
  }

  /* What a notice says, one line. */
  function words(n) {
    if (!n) return '';
    var when = n.date;
    if (n.level === 'choose') {
      return when + ': ' + n.included + ' photographs. A report holds 120 — choose which to leave out.';
    }
    if (n.level === 'smaller') {
      return when + ': ' + n.included + ' photographs. They go into the report smaller so all fit.';
    }
    return when + ': ' + n.included + ' photographs. Past 60 they go into the report smaller.';
  }

  if (!window.FS) window.FS = {};
  window.FS.photoNotice = { subscribe: subscribe, refresh: refresh, get: snapshot, words: words };
})();
