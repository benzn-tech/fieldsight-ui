/* ==========================================================================
   FieldSight · report-jobs — generations you started, tracked outside the modal
   --------------------------------------------------------------------------
   Generating a report takes minutes. Until now the only place its progress
   existed was the modal that started it: close it, reload, or walk away, and
   the report was still being written but nothing on screen knew. The person
   who asked for it had to sit and watch a spinner, which is not a thing you
   can ask somebody to do in front of a client.

   So the job lives here instead, and the bell reads it.

   POLLING BELONGS TO THE STORE, NOT TO A COMPONENT. If a component polled, the
   poll would stop when it unmounted, which is exactly the moment the person
   went to do something else -- the case this exists for.

   IT SURVIVES A RELOAD. A job is written to localStorage, and polling resumes
   on load. Losing it costs a refresh rather than the report, which is safe on
   S3 either way.

   IT IS KEPT PER ACCOUNT, NOT PER BROWSER. This header used to say localStorage
   was "per-viewer" and "means nothing to anybody else". It is per BROWSER. On a
   shared machine -- a site office, a tablet in the cab -- the next person to
   sign in saw the previous person's reports in their bell: the template name,
   the date and a Download button. Observed on TEST: reports generated as one
   company's account were listed for an account in another company.

   So the key carries the signed-in user's `sub`, the cache is dropped the
   moment the session changes, and nothing is read or written with nobody
   signed in. The Download was never the leak -- `freshUrl()` asks the server,
   which answers for whoever is signed in now -- but the listing itself was
   somebody else's.

   THE DOWNLOAD URL IS NEVER STORED. It is presigned with a 15-minute expiry
   (BACKEND-CONTEXT §7). Keeping it would hand somebody a link that answers
   403 an hour later -- and this repo answers 403 for absent keys too, so it
   would not even read as "expired". `freshUrl()` asks the server at the
   moment of the click. The cost is one request; the alternative is a download
   button that fails for reasons nobody can see.

   Exposed as window.FS.reportJobs
   ========================================================================== */

(function () {
  'use strict';

  /* The prefix. The real key is `KEY + ':' + sub` -- see accountKey(). The bare
     KEY is what every version before this one wrote to, shared by everyone who
     used the browser; it is removed on first load, because nothing in it says
     whose each entry was. Its entries would have expired within a day anyway. */
  var KEY = 'fs.reportJobs.v1';
  var POLL_MS = 15000;
  /* Long enough that a slow generation is not declared dead (the backend's own
     budget for a report is minutes, and a day report bundles several
     sessions); short enough that a job cannot sit "working" forever and be
     mistaken for a live one. */
  var GIVE_UP_MS = 30 * 60 * 1000;
  /* A finished job stays in the list for a day. It is a record of something
     you asked for, not a toast. */
  var KEEP_MS = 24 * 60 * 60 * 1000;

  var _jobs = null;
  var _owner = null;   /* the `sub` that _jobs belongs to */
  var _timer = null;
  var _listeners = [];

  /* ── Storage ─────────────────────────────────────────────────────────── */

  /* Whose list this is, or null when nobody is signed in. */
  function currentSub() {
    var session = (window.FS || {}).session;
    var user = session && session.user;
    return (user && user.sub) || null;
  }

  function accountKey(sub) {
    return KEY + ':' + sub;
  }

  var _legacyCleared = false;
  function clearLegacy() {
    if (_legacyCleared) return;
    _legacyCleared = true;
    try { localStorage.removeItem(KEY); } catch (_) {}
  }

  function load() {
    var sub = currentSub();
    /* NOBODY SIGNED IN, NOTHING SHOWN. Not the last person's list, and not an
       empty list cached as if it were somebody's. */
    if (!sub) {
      _jobs = null;
      _owner = null;
      return [];
    }
    if (_jobs && _owner === sub) return _jobs;
    clearLegacy();
    _owner = sub;
    try {
      var raw = localStorage.getItem(accountKey(sub));
      var arr = raw ? JSON.parse(raw) : [];
      _jobs = Array.isArray(arr) ? arr : [];
    } catch (_) {
      _jobs = [];
    }
    /* Drop what nobody will look at again. Done on read rather than on a
       timer: the list is only interesting when somebody is looking. */
    var now = Date.now();
    _jobs = _jobs.filter(function (j) {
      if (j.status === 'working') return (now - (j.startedAt || 0)) < GIVE_UP_MS;
      return (now - (j.finishedAt || j.startedAt || 0)) < KEEP_MS;
    });
    return _jobs;
  }

  function save() {
    /* Written under the account the list was LOADED for, never under whoever
       happens to be signed in at the moment of writing. A poll that settles
       after a sign-out must not land in the next person's list. */
    if (!_owner || !_jobs) return;
    try { localStorage.setItem(accountKey(_owner), JSON.stringify(_jobs)); } catch (_) {}
  }

  function emit() {
    var snapshot = list();
    _listeners.forEach(function (fn) { try { fn(snapshot); } catch (_) {} });
  }

  /* ── Reading ─────────────────────────────────────────────────────────── */

  function list() {
    return load().slice().sort(function (a, b) {
      return (b.startedAt || 0) - (a.startedAt || 0);
    });
  }

  function unseenCount() {
    return load().filter(function (j) {
      return j.status !== 'working' && !j.seen;
    }).length;
  }

  function working() {
    return load().filter(function (j) { return j.status === 'working'; }).length;
  }

  function subscribe(fn) {
    _listeners.push(fn);
    return function () {
      _listeners = _listeners.filter(function (f) { return f !== fn; });
    };
  }

  /* ── Writing ─────────────────────────────────────────────────────────── */

  /* `scope` carries everything getSessionReportStatus needs, because the poll
     happens long after the screen that knew it has gone. */
  function track(job) {
    if (!job || !job.requestId) return null;
    if (!currentSub()) return null;
    var jobs = load();
    if (jobs.some(function (j) { return j.requestId === job.requestId; })) return job.requestId;
    jobs.unshift({
      requestId: job.requestId,
      label: job.label || 'Report',
      templateName: job.templateName || null,
      scope: job.scope || null,
      sessionId: job.sessionId || null,
      date: job.date || null,
      user: job.user || null,
      status: 'working',
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      seen: false,
    });
    save();
    emit();
    ensurePolling();
    return job.requestId;
  }

  function markSeen(requestId) {
    var hit = load().filter(function (j) { return j.requestId === requestId; })[0];
    if (!hit || hit.seen) return;
    hit.seen = true;
    save();
    emit();
  }

  function markAllSeen() {
    var changed = false;
    load().forEach(function (j) {
      if (j.status !== 'working' && !j.seen) { j.seen = true; changed = true; }
    });
    if (changed) { save(); emit(); }
  }

  function dismiss(requestId) {
    _jobs = load().filter(function (j) { return j.requestId !== requestId; });
    save();
    emit();
  }

  /* ── Polling ─────────────────────────────────────────────────────────── */

  function statusOpts(job) {
    return {
      scope: job.scope, sessionId: job.sessionId, date: job.date,
      user: job.user, requestId: job.requestId,
    };
  }

  function settle(job, status, error) {
    /* No "is this still the current account's job" guard here, and that is
       deliberate: it was tried and a mutation run showed it could never
       matter. What stops a poll that settles after a sign-out from landing in
       the next person's list is save(), which writes the list under the
       account it was LOADED for. That is the one place it is enforced. */
    job.status = status;
    job.error = error || null;
    job.finishedAt = Date.now();
    job.seen = false;
    save();
    emit();
  }

  function pollOnce() {
    var org = (((window.FS || {}).api) || {}).org;
    var pending = load().filter(function (j) { return j.status === 'working'; });
    if (!pending.length || !org || !org.getSessionReportStatus) {
      stopPollingIfIdle();
      return;
    }
    pending.forEach(function (job) {
      if (Date.now() - (job.startedAt || 0) > GIVE_UP_MS) {
        /* Says what is and is not known. The report may well have been
           written -- this only means nobody heard back in half an hour, and
           /reports is where a finished one would show up. */
        settle(job, 'error',
               'No answer after 30 minutes. The report may still have been '
               + 'written; check the Reports page.');
        return;
      }
      org.getSessionReportStatus(statusOpts(job)).then(function (res) {
        if (!res) return;
        if (res.status === 'done') {
          settle(job, 'done', null);
        } else if (res.status === 'error') {
          settle(job, 'error', res.error || 'The report could not be generated.');
        } else if (res.status === 'removed') {
          settle(job, 'error', 'The recording this report covers was deleted.');
        } else if (res._accessDenied) {
          settle(job, 'error', 'You no longer have access to this report.');
        }
        /* pending / queued / anything else: leave it working. */
      }).catch(function () {
        /* A failed poll is not a failed report. Leave it working; the
           give-up clock is what ends it. */
      });
    });
  }

  function ensurePolling() {
    if (_timer) return;
    if (!working()) return;
    _timer = setInterval(pollOnce, POLL_MS);
    /* One immediately, so a reload does not look idle for 15 seconds. */
    pollOnce();
  }

  function stopPollingIfIdle() {
    if (_timer && !working()) {
      clearInterval(_timer);
      _timer = null;
    }
  }

  /* ── The download ────────────────────────────────────────────────────── */

  /* Asked for at the moment of the click, never stored. See the header. */
  function freshUrl(requestId) {
    var job = load().filter(function (j) { return j.requestId === requestId; })[0];
    var org = (((window.FS || {}).api) || {}).org;
    if (!job) return Promise.reject(new Error('That report is no longer listed.'));
    if (!org || !org.getSessionReportStatus) {
      return Promise.reject(new Error('Downloads need the org API.'));
    }
    return org.getSessionReportStatus(statusOpts(job)).then(function (res) {
      if (res && res.status === 'done' && res.docUrl) return res.docUrl;
      if (res && res.status === 'error') {
        throw new Error(res.error || 'The report could not be generated.');
      }
      throw new Error('That report is not ready yet.');
    });
  }

  /* ── Expose ──────────────────────────────────────────────────────────── */

  if (!window.FS) window.FS = {};
  window.FS.reportJobs = {
    list: list,
    track: track,
    subscribe: subscribe,
    unseenCount: unseenCount,
    working: working,
    markSeen: markSeen,
    markAllSeen: markAllSeen,
    dismiss: dismiss,
    freshUrl: freshUrl,
    /* for tests */
    _pollOnce: pollOnce,
    _reset: function () { _jobs = null; _owner = null; if (_timer) { clearInterval(_timer); _timer = null; } },
    _onSessionChange: onSessionChange,
    POLL_MS: POLL_MS,
    GIVE_UP_MS: GIVE_UP_MS,
  };

  /* A DIFFERENT PERSON SIGNS IN, A DIFFERENT LIST. Signing out and back in
     does not reload the page, so the in-memory list has to be dropped here --
     otherwise the bell keeps showing the previous account's reports until
     somebody refreshes, which is exactly the case this change is for. */
  function onSessionChange() {
    if (_owner === currentSub()) return;
    if (_timer) { clearInterval(_timer); _timer = null; }
    _jobs = null;
    _owner = null;
    emit();
    ensurePolling();
  }

  var session = (window.FS || {}).session;
  if (session && typeof session.onChange === 'function') {
    session.onChange(onSessionChange);
  }

  /* Resume on load: a report started before a refresh is still being written. */
  if (typeof window !== 'undefined') ensurePolling();

})();
