/* ==========================================================================
   FieldSight · checklist-reports — checklist reports that made themselves
   --------------------------------------------------------------------------
   Owner, 2026-10-06: "starting the concrete pre-pour check", gone through out
   loud, comes back as that checklist filled in -- no dialog. The pipeline
   queues it after the recording's final extraction (checklist_reports); this
   polls the caller's own (GET /api/org/checklist-reports/recent) for the
   bell, and says when one is ready or when a check had no checklist to fill.

   Seen ones stop counting (kept per browser; a cleared store just shows them
   again, never hides one).

   Exposed as window.FS.checklistReports
   ========================================================================== */

(function () {
  'use strict';

  /* A report is ready a few minutes after the recording stops. */
  var POLL_MS = 120000;
  var SEEN_KEY = 'fs.checklistReports.seen';
  var state = { reports: [], unmatched: [], folder: null, loaded: false };
  var subs = [];
  var timer = null;
  var inflight = null;

  function readSeen() {
    try { return JSON.parse(window.localStorage.getItem(SEEN_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }

  function markSeen(key) {
    var seen = readSeen();
    seen[key] = Date.now();
    try { window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch (e) { /* fine */ }
    emit();
  }

  function unmatchedKey(u) { return 'u:' + u.date + ':' + u.startAt + ':' + u.checkName; }

  function snapshot() {
    var seen = readSeen();
    return {
      reports: state.reports.slice(),
      unmatched: state.unmatched.filter(function (u) { return !seen[unmatchedKey(u)]; }),
      unseen: state.reports.filter(function (r) { return r.status === 'done' && !seen[r.id]; }).length
        + state.unmatched.filter(function (u) { return !seen[unmatchedKey(u)]; }).length,
      seen: seen,
      folder: state.folder,
      loaded: state.loaded,
    };
  }

  function emit() {
    subs.slice().forEach(function (fn) {
      try { fn(snapshot()); } catch (e) { /* a bad subscriber must not stop the rest */ }
    });
  }

  async function doRefresh() {
    var org = ((window.FS || {}).api || {}).org;
    if (!org || !org.getRecentChecklistReports) { inflight = null; return; }
    try {
      var r = await org.getRecentChecklistReports();
      state.reports = (r && Array.isArray(r.reports)) ? r.reports : [];
      state.unmatched = (r && Array.isArray(r.unmatched)) ? r.unmatched : [];
      state.folder = (r && r.folder) || null;
    } catch (e) {
      /* keep the last answer: a failed poll is not "nothing ready" */
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

  /* "Concrete Pre-pour Inspection Checklist -- level 2 pre-pour, 10:59" */
  function words(r) {
    if (!r) return '';
    var when = (r.startAt || '').slice(0, 5);
    var head = r.templateName + ' — ' + r.checkName + (when ? ', ' + when : '');
    if (r.status === 'done') return head + ': ready';
    if (r.status === 'error') return head + ': could not be written';
    return head + ': being written…';
  }

  function unmatchedWords(u) {
    return 'Heard “' + u.checkName + '” at ' + (u.startAt || '').slice(0, 5)
      + ' — no checklist in your Library matches it.';
  }

  /* The Word file: through the day report's status, which re-checks
     deletions before it hands out a link. */
  async function download(r, folder) {
    var org = ((window.FS || {}).api || {}).org;
    if (!org || !org.getSessionReportStatus) return null;
    var res = await org.getSessionReportStatus({ scope: 'day', date: r.date, user: folder,
                                                 requestId: r.requestId });
    markSeen(r.id);
    if (res && res.status === 'done' && res.docUrl) {
      window.open(res.docUrl, '_blank', 'noopener');
      return res.docUrl;
    }
    return null;
  }

  if (!window.FS) window.FS = {};
  window.FS.checklistReports = {
    subscribe: subscribe, refresh: refresh, get: snapshot, words: words,
    unmatchedWords: unmatchedWords, unmatchedKey: unmatchedKey,
    markSeen: markSeen, download: download,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { words: words, unmatchedWords: unmatchedWords };
  }
})();
