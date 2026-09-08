/* ==========================================================================
   FieldSight API · Timeline (Daily Report) — BACKEND-CONTEXT §4.4 / §5.1
   --------------------------------------------------------------------------
   GET /api/timeline?date=YYYY-MM-DD&user=<Folder_Name>
     → DailyReport JSON (§5.1) OR
     → 404-body { message, date }                       (no report)
     → 200-body { date, available_users:[...] }         (admin disambig)
   ========================================================================== */

(function () {
  'use strict';

  function fixtures() {
    return (window.FieldSight && window.FieldSight.fixtures) || {};
  }

  /* Look up a fixture report by (date, folder) — fixtures keyed by both
     forms (Jarley_Trainor and Jarley Trainor). */
  function lookupReport(date, user) {
    var byDate = (fixtures().reports || {})[date];
    if (!byDate) return null;
    if (!user) return byDate.__summary || null;
    var folder = window.FS.api.folderName(user);
    return byDate[folder] || byDate[user] || null;
  }

  /* authority flip (pipeline plan 2026-07-14): 'aurora' only takes effect
     when orgBaseUrl is non-empty (kill switch) — see api/index.js. */
  function timelineSource() {
    var api = window.FS.api;
    return (api.timelineSource === 'aurora' && api.orgBaseUrl) ? 'aurora' : 'report';
  }

  /* Session-stable read: reports are generated server-side and not edited
     in-app, so a few minutes of staleness is safe — see api/_cache.js.
     Cache key intentionally includes only (date, user); it's the exact
     request shape callers pass. */
  async function fetchTimeline(opts) {
    if (!window.FS.api.useMocks) {
      var params = { date: opts.date, user: opts.user };
      if (timelineSource() === 'aurora') {
        try {
          var r = await window.FS.api.orgRequest('/timeline', { params: params });
          /* _accessDenied → ACL divergence (shim v1 is stricter than prod for
             site_manager/pm, plan D10): fall through to the report path rather
             than blanking the page. _notFound is authoritative (the shim
             already fell back to S3 server-side) — return it. */
          if (r && !r._accessDenied) return r;
          if (!window.FS.api.legacyReadFallback) return r;  // D5: legacy retired → Aurora authoritative
        } catch (e) {
          if (!window.FS.api.legacyReadFallback) throw e;   // D5: no legacy transport fallback
        }
      }
      return window.FS.api.request('/timeline', { params: params });   // legacy read path (flag-gated above)
    }
    await window.FS.api.delay(120);

    var date = opts.date;
    var user = opts.user;
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};

    /* Worker rule: server forces user = self (BACKEND-CONTEXT §3, §8.5). */
    if (caller.role === 'worker') {
      user = window.FS.api.folderName(caller.name);
    }

    var report = lookupReport(date, user);
    if (report) return report;

    /* Admin/gm with no user param → either summary or available_users.
       Sprint 2.1 fixtures don't ship a summary, so surface picker shape. */
    if (!user && (caller.role === 'admin' || caller.role === 'gm' || caller.isAdmin)) {
      var byDate = (fixtures().reports || {})[date] || {};
      var folders = Object.keys(byDate).filter(function (k) { return k.charAt(0) !== '_'; });
      if (folders.length > 0) {
        return { date: date, available_users: folders };
      }
    }

    /* No report. MIRRORS THE REAL ENVELOPE, which nests the body under `raw`
       rather than merging it (_fetch.js). This used to fabricate the fields
       flat, so every offline render read `report.message` where the live app
       reads `report.raw.message` -- a mock that does not carry the real shape
       teaches the wrong contract, and the branch it teaches is the one nobody
       exercises until a customer does.

       A day with uploads carries what arrived (backend 2026-09-06): that is
       what turns "nothing here" into "56 photos, report not generated". The
       2026-04-27 fixture day is the one with uploads so the branch is
       reachable in the preview; every other date keeps the bare shape, which
       is also real -- three producers emit _notFound with no raw at all. */
    var bare = {
      message: 'No report for ' + (user || '(unknown)') + ' on ' + date,
      date:    date,
      user:    user || null,
    };
    /* 2026-04-24 is the dates-fixture's captured-but-not-summarised day
       (hasReport:false, hasUploads:true), so clicking its outline dot in the
       preview reaches this branch and renders the arrival line + photo grid.
       2026-04-27 keeps its own entry: it is a day that HAS a report for some
       folders and none for Jarley_Trainor, which is a different shape and is
       what tests/day-photos-are-not-only-the-bound-ones.test.js drives. */
    if (date === '2026-04-24') {
      bare.uploads = { sessions: 0, duration_s: 0, photos: 3 };
      bare.transcripts = 0;
      bare.day_state = 'captured';
      bare.photo_filenames = [
        'Benl1_2026-04-24_07-42-11.jpg',
        'Benl1_2026-04-24_11-15-40.jpg',
        'Benl1_2026-04-24_15-58-02.jpg',
      ];
    }
    if (date === '2026-04-27') {
      bare.uploads = { sessions: 0, duration_s: 0, photos: 3 };
      bare.transcripts = 0;
      bare.day_state = 'captured';
      bare.photo_filenames = [
        'Benl1_2026-04-27_08-01-10.jpg',
        'Benl1_2026-04-27_08-04-55.jpg',
        'Benl1_2026-04-27_09-30-02.jpg',
      ];
    }
    return { _notFound: true, status: 404, raw: bare,
             /* kept alongside `raw` because callers written before the
                envelope was understood still read it off the top level */
             message: bare.message, date: date };
  }

  function getTimeline(opts) {
    opts = opts || {};
    var key = 'tl:' + timelineSource() + ':' + opts.date + ':' + (opts.user || '');
    return window.FS.api.cache.cached(key, undefined, function () {
      return fetchTimeline(opts);
    });
  }

  window.FS.api.timeline = { getTimeline: getTimeline };

})();
