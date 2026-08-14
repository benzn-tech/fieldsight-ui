/* ==========================================================================
   FieldSight Evidence Page — Sprint 4.3
   --------------------------------------------------------------------------
   /evidence — filterable media library aggregated across recent
   reports. Reuses the Phase C media composites verbatim
   (PhotoGrid / AudioPlaylist / VideoPlayer / TranscriptList) — each
   composite is one-day-scoped and fetches its own data lazily, so
   the Evidence page just decides which days to show and renders one
   per-day section per tab.

   Middle column:
     • Header: "Evidence" + range caption + Load more
     • EvidenceTabs (Photos / Audio / Video / Transcripts)
     • Active-tab content: per-day sections (date header + composite
       scoped to that date+user)

   Right detail:
     • Summary card: active tab name + day count + range
     • Optional contextual help

   Architecture:
     • EvidenceProvider owns date discovery + active-tab + the
       photos count (the only count we can compute cheaply, since
       photos are filenames inside report topics — we already have
       to fetch /api/timeline anyway). Audio/Video/Transcripts
       counts left as null (the underlying composites self-fetch).
     • Default range = trailing 7 days. "Load more" extends by 7.
     • Worker rule: user forced to caller's folder client-side.

   Registers as window.FieldSight.PAGES['/evidence']
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var DEFAULT_DAYS = 3;  /* Sprint 8.8.2 — start with 3 days; load-more adds 3 more */
  var LOAD_STEP    = 3;

  /* ---------- Helpers --------------------------------------------------- */

  function callerFolder() {
    var u = (window.AuthMock && window.AuthMock.currentUser) || {};
    if (!u.name) return null;
    return window.FS.api.folderName(u.name);
  }

  function isAdminLike(user) {
    return user && (user.role === 'admin' || user.role === 'gm' || user.isAdmin);
  }

  /* folder_name if present (fixtures + live /api/users alike), else
     derived client-side from name. Real /api/users returns only
     {device_id,name,role,sites} — no folder_name. */
  function deriveFolder(u) {
    return u.folder_name || (u.name ? u.name.replace(/ /g, '_') : '');
  }

  /* batch A2 Task 4 — the existing all-users fan-out source (GET /api/users,
     falling back to fixtures on error). Extracted so the site-scoped path
     below can fall back to the same unscoped source if getSiteUsers fails. */
  function allUsersFoldersPromise() {
    return window.FS.api.sites.getUsers().then(function (res) {
      return ((res && res.users) || []).map(deriveFolder).filter(Boolean);
    }).catch(function () {
      var fxUsers = (window.FieldSight && window.FieldSight.fixtures
        && window.FieldSight.fixtures.sites && window.FieldSight.fixtures.sites.users) || [];
      return fxUsers.map(deriveFolder).filter(Boolean);
    });
  }

  function fmtDate(yyyymmdd) {
    if (!yyyymmdd) return '';
    var p = String(yyyymmdd).split('-').map(Number);
    if (p.length !== 3) return yyyymmdd;
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return days[d.getUTCDay()] + ' ' + p[2] + ' ' + months[p[1] - 1] + ' ' + p[0];
  }

  /* Topic time_range "07:00 – 07:30" → { start: 'HH:MM:SS', end: ... } */
  function parseTimeRange(time_range) {
    if (!time_range) return { start: null, end: null };
    var m = String(time_range).match(/(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/);
    if (!m) return { start: null, end: null };
    function pad(s) { return s.length === 1 ? '0' + s : s; }
    return {
      start: pad(m[1]) + ':' + m[2] + ':00',
      end:   pad(m[3]) + ':' + m[4] + ':00',
    };
  }

  /* ---------- EvidenceContext ----------------------------------------- */

  var EvidenceContext = React.createContext(null);

  function EvidenceProvider(props) {
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
    var depKey = (caller.name || '') + '|' + (caller.role || '') + '|' + (caller.isAdmin ? 'admin' : '');

    /* fs.settings.evidenceView holds { preset, from, to } — persisted and
       restored by the shared RangeToolbar composite (Task B). Default
       preset 'all' so Evidence reaches the real report span (Feb–Mar
       2026) instead of a trailing-days window that comes up empty since
       "today" runs months ahead of the fixture data. */
    var refView = React.useState({ preset: 'all', from: null, to: null });
    var view    = refView[0];
    var setView = refView[1];

    var refDays = React.useState(DEFAULT_DAYS);
    var daysToLoad    = refDays[0];
    var setDaysToLoad = refDays[1];

    var refTab = React.useState('photos');
    var activeTab    = refTab[0];
    var setActiveTab = refTab[1];

    var refState = React.useState({ status: 'loading' });
    var state    = refState[0];
    var setState = refState[1];

    var retryRef   = React.useState(0);
    var retryCount = retryRef[0];
    var setRetry   = retryRef[1];

    /* batch A2 Task 4 — read the global active-site selection; passed
       EXPLICITLY into the photos fan-out folders source below (never read
       inside an aggregator itself). The dates-span discovery effect below
       intentionally keeps the global span — see that effect's comment. */
    var refActiveSite = React.useState(function () { return (window.FS && window.FS.siteContext) ? window.FS.siteContext.get() : null; });
    var activeSite    = refActiveSite[0];
    var setActiveSite = refActiveSite[1];
    React.useEffect(function () {
      if (!(window.FS && window.FS.siteContext)) return undefined;
      return window.FS.siteContext.onChange(setActiveSite);
    }, []);

    /* Fable review #3 — the photos effect guards on status==='ok', and only
       the discovery effect (which deliberately excludes activeSite) resets
       it. Without this, switching projects left the previous scope's
       gallery on screen under the new selection. */
    React.useEffect(function () {
      setPhotos({ status: 'idle', perDay: [], totalCount: 0 });
    }, [activeSite]);

    /* Photos cache — populated when the Photos tab activates (first
       open) and shared with the right-pane summary. */
    var refPhotos = React.useState({ status: 'idle', perDay: [], totalCount: 0 });
    var photos    = refPhotos[0];
    var setPhotos = refPhotos[1];

    /* Recordings cache — same lazy shape as photos. Bumping `recReload`
       re-runs the fan-out after a delete or a restore, because the topics
       those recordings own vanish from (and come back to) every read path. */
    var refRecs = React.useState({ status: 'idle', perDay: [] });
    var recordings    = refRecs[0];
    var setRecordings = refRecs[1];
    var refRecReload = React.useState(0);
    var recReload    = refRecReload[0];
    var bumpRecReload = refRecReload[1];

    /* Fable review #4 (batch IB-2 revision) — mirror the aggregators' A2
       rule: sm/pm (non-admin, non-worker) NEVER get forced to self-only,
       whether or not a site is anchored. With an anchored site they widen
       to the site fan-out (getSiteUsers, server-side permission-scoped to
       self + own-site workers); with NO site anchored they widen further
       to the unscoped all-users fan-out (allUsersFoldersPromise below —
       server/graceful-degrade drops any folder they can't read, IB-1).
       Previously `!isAdminLike(caller) && !activeSite` forced sm/pm to
       callerFolder() here, which collapsed Evidence to the caller's own
       (usually-empty) media whenever no site was picked — the page read
       as "no data" for every site_manager until they happened to select
       a site. Workers stay forced-self always — that rule is unchanged. */
    var user = caller.role === 'worker'
      ? callerFolder()
      : null;

    React.useEffect(function () {
      /* RangeToolbar resolves the range asynchronously (e.g. 'all' needs
         FS.api.window.getSpan()) — wait for both ends before fetching.
         batch A2 Task 4 — this discovery step deliberately does NOT take
         activeSite: the date-span itself is global (which days have any
         report at all), not site-scoped. Narrowing happens per-day in the
         photos fan-out effect below, whose folders source IS site-scoped;
         a date with no site-matching photos just yields zero rows for
         that day (existing perDay.length === 0 skip), not an error —
         acceptable here. */
      if (!view.from || !view.to) return undefined;
      var cancelled = false;
      setState({ status: 'loading' });
      setPhotos({ status: 'idle', perDay: [], totalCount: 0 });

      /* Reuses FS.api.window.getSpan()'s cached wide-discovery fetch
         (same underlying GET /api/dates the toolbar's 'all' preset and
         DatePicker already share) instead of a separate months-scoped
         call, then narrows to the selected [from, to] window client-side
         and paginates within it. */
      window.FS.api.window.getSpan().then(function (span) {
        if (cancelled) return;
        var datesMap = (span && span.dates) || {};
        var allDates = Object.keys(datesMap)
          .filter(function (d) {
            return datesMap[d] && datesMap[d].hasReport && d >= view.from && d <= view.to;
          })
          .sort()
          .reverse();
        /* Sprint 8.8.2 pagination only applies to the bounded presets —
           the 'all' preset already widened from/to to the full report
           span, so capping by daysToLoad on top of that silently hid
           every in-range day past the first DEFAULT_DAYS. */
        var dates = (view.preset === 'all') ? allDates : allDates.slice(0, daysToLoad);

        setState({ status: 'ok', dates: dates, user: user });
      }).catch(function (err) {
        if (cancelled) return;
        setState({ status: 'error', error: { code: (err && err.status) || 0, message: (err && err.message) || 'Could not load evidence', retryable: true }, retry: function () { setRetry(function (n) { return n + 1; }); } });
      });

      return function () { cancelled = true; };
    }, [depKey, view.preset, view.from, view.to, daysToLoad, retryCount]);

    /* Lazy-load photos when the Photos tab is the active one and we
       don't yet have data for it. Other tabs are populated by their
       own composites internally — no central fetch needed. */
    React.useEffect(function () {
      if (state.status !== 'ok') return undefined;
      if (activeTab !== 'photos') return undefined;
      if (photos.status === 'ok') return undefined;
      var cancelled = false;
      setPhotos({ status: 'loading', perDay: [], totalCount: 0 });

      /* Sprint 8 follow-up — admin fan-out across all known users so
         /evidence Photos tab isn't blank when running as admin. Sourced
         from the real GET /api/users (report identity) — live =
         pass-through of /api/users, mock = fixtures (unchanged
         behaviour). Falls back to the fixtures read on any /api/users
         error.

         batch A2 Task 4 — when there's no forced single user AND an
         active site is selected, narrow the fan-out to that site's users
         via GET /site-users; any failure there falls back to the same
         unscoped all-users source above (partial/unscoped data beats a
         dead page). */
      var foldersPromise = state.user
        ? Promise.resolve([state.user])
        : (activeSite
            ? window.FS.api.sites.getSiteUsers(activeSite).then(function (res) {
                return ((res && res.users) || []).map(deriveFolder).filter(Boolean);
              }).catch(allUsersFoldersPromise)
            : allUsersFoldersPromise());

      foldersPromise.then(function (fanoutFolders) {
        /* Pooled, not Promise.all: the cross-product reaches 150+ requests
           on the 'All' range — see FS.api.pooledAll. Failed fetches → null
           → skipped below (partial data beats a dead page). */
        var evThunks = (state.dates || []).reduce(function (acc, d) {
          fanoutFolders.forEach(function (f) {
            acc.push(function () {
              return window.FS.api.timeline.getTimeline({ date: d, user: f })
                .then(function (r) { return { date: d, report: r }; });
            });
          });
          return acc;
        }, []);
        return window.FS.api.pooledAll(evThunks, 8).then(function (rs) {
          /* batch 2c Task 6 — all-failed → error (lands in the .catch below
             → photos error state), not a silently-empty gallery. */
          if (evThunks.length > 0 && rs.filter(Boolean).length === 0) {
            throw new Error('Could not load photos — all requests failed. Please retry.');
          }
          return rs;
        });
      }).then(function (perDay) {
        if (cancelled) return;

        /* IB-1 mirror (compliance-aggregator.fanoutDates) — a denied
           per-day report just yields zero photos for that day (dropped
           below, same as _notFound); accessible days still render. Only
           surface a distinct denied state when EVERY item that came back
           was a denial with nothing accessible AND nothing genuinely
           empty either — otherwise this is indistinguishable from (and
           falls through to) the ordinary "no photos in range" empty
           state, which is correct when the fan-out is a mix of
           _notFound/accessible days. */
        var reportItems = perDay.filter(function (x) { return x && x.report; });
        var deniedItems = reportItems.filter(function (x) { return x.report._accessDenied; });
        if (deniedItems.length > 0 && deniedItems.length === reportItems.length) {
          setPhotos({
            status: 'error', perDay: [], totalCount: 0,
            message: 'You don’t have access to this media.',
          });
          return;
        }

        var rows = [];
        var total = 0;
        perDay.forEach(function (x) {
          if (!x || !x.report || x.report._notFound || x.report._accessDenied || x.report.available_users) return;
          var photosForDate = [];
          (x.report.topics || []).forEach(function (t) {
            (t.related_photos || []).forEach(function (filename) {
              photosForDate.push({
                filename:        filename,
                topic_id:        t.topic_id,
                topic_title:     t.topic_title,
                userDisplayName: x.report.user_name,
              });
            });
          });
          if (photosForDate.length === 0) return;
          rows.push({
            date:        x.date,
            user_name:   x.report.user_name,
            user_folder: x.report.user_name
                          ? window.FS.api.folderName(x.report.user_name)
                          : null,
            photos:      photosForDate,
          });
          total += photosForDate.length;
        });
        setPhotos({ status: 'ok', perDay: rows, totalCount: total });
      }).catch(function () {
        if (!cancelled) setPhotos({ status: 'error', perDay: [], totalCount: 0 });
      });

      return function () { cancelled = true; };
    }, [activeTab, state.status, state.dates && state.dates.join(','), activeSite]);

    /* Recordings fan-out. Same (dates × folders) cross-product the photos
       effect uses, but it fetches TWO things per pair:

         getSessions  — the selectable unit. `session_id` IS the backend's
                        `session_base` (session_scope.session_ref), which is
                        exactly what POST /recordings/delete addresses, so no
                        translation is needed and none should be invented.
         getTimeline  — the topics, so the confirm step can NAME what is
                        about to go rather than showing a count. `topic
                        .session_id` carries the same session_base, so the
                        join is local.

       A failed timeline call leaves `topics: null`, NOT `[]`. The modal
       renders those differently on purpose: "could not read" and "contains
       nothing" are different statements and only one is safe to confirm. */
    React.useEffect(function () {
      if (state.status !== 'ok') return undefined;
      /* Audio and Video both render selectable session blocks off this
         fan-out. Photos deliberately does not: deleting a photo is a
         different mechanism (topic_photos CASCADEs from its topic, and
         PhotoGrid already has its own keyframe delete), and one Delete
         button meaning two things across tabs is a real source of
         mis-clicks. */
      if (activeTab !== 'audio' && activeTab !== 'video') return undefined;
      if (recordings.status === 'ok' && recReload === recordings.tick) return undefined;
      var cancelled = false;
      var tick = recReload;
      setRecordings({ status: 'loading', perDay: [], tick: tick });

      var foldersPromise = state.user
        ? Promise.resolve([state.user])
        : (activeSite
            ? window.FS.api.sites.getSiteUsers(activeSite).then(function (res) {
                return ((res && res.users) || []).map(deriveFolder).filter(Boolean);
              }).catch(allUsersFoldersPromise)
            : allUsersFoldersPromise());

      foldersPromise.then(function (folders) {
        var thunks = [];
        (state.dates || []).forEach(function (d) {
          folders.forEach(function (f) {
            thunks.push(function () {
              return Promise.all([
                window.FS.api.org.getSessions({ date: d, user: f })
                  .catch(function () { return null; }),
                window.FS.api.timeline.getTimeline({ date: d, user: f })
                  .catch(function () { return null; }),
              ]).then(function (pair) {
                return { date: d, folder: f, sess: pair[0], report: pair[1] };
              });
            });
          });
        });
        return window.FS.api.pooledAll(thunks, 8);
      }).then(function (pairs) {
        if (cancelled) return;
        var perDay = {};
        (pairs || []).forEach(function (p) {
          if (!p || !p.sess || p.sess._notFound || p.sess._accessDenied) return;
          var list = (p.sess.sessions || []);
          if (!list.length) return;
          var report = p.report;
          var usable = report && !report._notFound && !report._accessDenied
                       && !report.available_users;
          var topics = usable ? (report.topics || []) : null;
          var rows = list.map(function (s) {
            var base = s.session_id || null;
            return {
              date:        p.date,
              folder:      p.folder,
              sessionBase: base,
              label:       s.label || (base ? 'Recording' : 'Whole day'),
              topicCount:  s.topic_count || 0,
              /* started_at is authoritative (parsed from the session key);
                 ended_at is cosmetic and may be null — see
                 recording-deletion.sessionWindow. */
              started_at:  s.started_at || null,
              ended_at:    s.ended_at || null,
              /* null = unknown (report unreadable), [] = genuinely none. */
              topics: (topics == null || base == null) ? null
                : topics.filter(function (t) { return t && t.session_id === base; }),
            };
          });
          if (!perDay[p.date]) perDay[p.date] = { date: p.date, rows: [] };
          perDay[p.date].rows = perDay[p.date].rows.concat(rows);
        });
        var out = Object.keys(perDay).sort().reverse().map(function (d) {
          /* Chronological within the day, so `sessionWindow` can use the NEXT
             session's start as a boundary when a session has no known end.
             Sorted on the ISO STRING — fixed-width ISO sorts lexicographically
             exactly as it sorts chronologically, and it is null-safe without
             inventing a sentinel date (same rule the backend sorts by). */
          perDay[d].rows.sort(function (a, b) {
            var an = a.started_at == null, bn = b.started_at == null;
            if (an !== bn) return an ? 1 : -1;
            return String(a.started_at || '').localeCompare(String(b.started_at || ''));
          });
          return perDay[d];
        });
        setRecordings({ status: 'ok', perDay: out, tick: tick });
      }).catch(function () {
        if (cancelled) return;
        setRecordings({ status: 'error', perDay: [], tick: tick });
      });

      return function () { cancelled = true; };
    }, [activeTab, state.status, state.dates && state.dates.join(','), activeSite,
        recReload, state.user]);

    React.useEffect(function () {
      setRecordings({ status: 'idle', perDay: [] });
    }, [activeSite]);

    function loadMore() { setDaysToLoad(function (n) { return n + LOAD_STEP; }); }

    /* A newly picked range restarts pagination from the top — the old
       daysToLoad count belonged to the previous window and has no
       meaning in the new one. */
    function handleViewChange(next) {
      setDaysToLoad(DEFAULT_DAYS);
      setView(next);
    }

    var ctx = {
      state:        state,
      activeTab:    activeTab,
      setActiveTab: setActiveTab,
      daysToLoad:   daysToLoad,
      loadMore:     loadMore,
      photos:       photos,
      recordings:   recordings,
      reloadRecordings: function () { bumpRecReload(function (n) { return n + 1; }); },
      view:         view,
      setView:      handleViewChange,
    };
    return React.createElement(EvidenceContext.Provider, { value: ctx },
      props.children);
  }

  /* ---------- Section: Photos (per-day groups using PhotoGrid) -------- */

  function PhotosTab(props) {
    var ctx = React.useContext(EvidenceContext);
    var PhotoGrid = window.FieldSight.PhotoGrid;
    var photos = ctx.photos;

    if (photos.status === 'idle' || photos.status === 'loading') {
      return React.createElement('div', { className: 'fs-evidence__loading' },
        'Aggregating photos…');
    }
    if (photos.status === 'error') {
      return React.createElement('div', { className: 'fs-evidence__empty' },
        photos.message || 'Could not load photos.');
    }
    if (!photos.perDay.length) {
      return React.createElement('div', { className: 'fs-evidence__empty' },
        'No photos in the selected range.');
    }

    return React.createElement('div', { className: 'fs-evidence__sections' },
      photos.perDay.map(function (day) {
        return React.createElement('div', { key: day.date, className: 'fs-evidence__section' },
          React.createElement('div', { className: 'fs-evidence__section-header' },
            React.createElement('span', { className: 'fs-evidence__section-date' },
              fmtDate(day.date)),
            React.createElement('span', { className: 'fs-evidence__section-count' },
              day.photos.length + ' '
                + (day.photos.length === 1 ? 'photo' : 'photos')),
          ),
          React.createElement(PhotoGrid, {
            photos:          day.photos.map(function (p) { return p.filename; }),
            userDisplayName: day.user_name,
            date:            day.date,
          }),
        );
      }),
    );
  }

  /* ---------- Section: Recordings (select + delete) -------------------- */

  /* Deleting recordings. The unit is the recording/session, not evidence:
     EMIT_EVIDENCE is false on PROD so `topics.evidence` is NULL for every prod
     topic and there would be nothing to select (backend spec §5).

     What the backend does is a reversible, audited redaction — nothing is
     erased. The copy here deliberately says "deleted" instead; that is a
     product decision taken 2026-08-14 for internal testing. The mechanism is
     documented in scripts/api/recording-deletion.js so a later reader is not
     misled by the wording on screen. */
  function DeletableMediaTab(props) {
    var Component = props.component;
    var ctx = React.useContext(EvidenceContext);
    var rd  = window.FS.recordingDeletion;
    var Modal = window.FieldSight.RecordingDeleteModal;
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
    var callerCtx = { role: caller.role, folder: callerFolder() };

    var refSel = React.useState({});          /* key → row */
    var selected    = refSel[0];
    var setSelected = refSel[1];
    var refBusy = React.useState(false);
    var busy    = refBusy[0];
    var setBusy = refBusy[1];
    var refConfirm = React.useState(false);
    var confirming    = refConfirm[0];
    var setConfirming = refConfirm[1];
    var refResult = React.useState(null);
    var result    = refResult[0];
    var setResult = refResult[1];
    /* Read once per render pass rather than held in state: the window closes
       on wall-clock time, and state would keep offering an expired entry until
       something else happened to re-render. */
    var refLedgerTick = React.useState(0);
    var setLedgerTick = refLedgerTick[1];

    var recs = ctx.recordings;
    /* Load-order guard. A missing api/recording-deletion.js would otherwise
       throw from inside the row map with a stack that points at this file and
       not at the script tag — the failure mode CLAUDE.md warns about, where a
       green `node --test` says nothing about whether a module is reachable. */
    if (!rd || !Modal) {
      return React.createElement('div', { className: 'fs-evidence__empty' },
        'Recording deletion did not load. Check the script tags for '
        + 'api/recording-deletion.js and composites/recording-delete-modal.js.');
    }
    if (recs.status === 'idle' || recs.status === 'loading') {
      return React.createElement('div', { className: 'fs-evidence__loading' },
        'Loading recordings…');
    }
    if (recs.status === 'error') {
      return React.createElement('div', { className: 'fs-evidence__empty' },
        'Could not load recordings.');
    }

    var now = Date.now();
    var batches = rd.activeBatches(now);

    function keyOf(r) { return r.folder + '|' + r.date + '|' + r.sessionBase; }
    var selectedRows = Object.keys(selected).map(function (k) { return selected[k]; });

    function toggle(row) {
      var k = keyOf(row);
      setSelected(function (prev) {
        var next = Object.assign({}, prev);
        if (next[k]) delete next[k]; else next[k] = row;
        return next;
      });
    }

    function runDelete() {
      setBusy(true);
      setResult(null);
      window.FS.api.org.deleteRecordings(rd.toRequest(selectedRows))
        .then(function (res) {
          if (res && res._notAvailable) {
            setResult({ error: 'Deleting is not available in this environment.' });
            return;
          }
          if (res && (res._accessDenied || res._notFound)) {
            setResult({ error: (res.error || 'You do not have permission to delete these.') });
            return;
          }
          var summary = rd.summariseResult(res, selectedRows);
          if (summary.batchId) {
            rd.appendBatch({
              batchId: summary.batchId,
              count: summary.deleted,
              topicsHidden: summary.topicsHidden,
              labels: selectedRows.map(function (r) { return r.date + ' ' + (r.label || ''); }),
            }, now);
          }
          setResult({ summary: summary });
          setSelected({});
          ctx.reloadRecordings();
        })
        .catch(function () { setResult({ error: 'The delete request failed.' }); })
        .then(function () { setBusy(false); setConfirming(false); });
    }

    /* `restored` is the count of redaction ROWS the batch reverted — one
       tombstone per recording PLUS one per hidden topic. It is deliberately
       not relabelled "topics": that is a different number and printing this
       one under that word would be a quiet lie. Shown against what the delete
       recorded, because the spec's own acceptance is "one revert restores
       exactly what one delete hid, counted the same way". */
    function runRestore(batch) {
      setBusy(true);
      var expected = (batch.count || 0) + (batch.topicsHidden || 0);
      window.FS.api.org.undeleteRecordings(batch.batchId).then(function (res) {
        if (res && (res._notAvailable || res._accessDenied || res._notFound)) {
          setResult({ error: 'Could not restore that batch.' });
          return;
        }
        rd.removeBatch(batch.batchId);
        setLedgerTick(function (n) { return n + 1; });
        setResult({ restored: (res && res.restored) || 0, expected: expected });
        ctx.reloadRecordings();
      }).catch(function () {
        setResult({ error: 'The restore request failed.' });
      }).then(function () { setBusy(false); });
    }

    var anyRows = recs.perDay.some(function (d) { return d.rows.length; });

    return React.createElement('div', { className: 'fs-evidence__sections' },

      result
        ? React.createElement('div', {
            className: 'fs-rec-result' + (result.error ? ' fs-rec-result--error' : ''),
          },
            result.error ? result.error
              : result.restored != null
                ? (result.restored === result.expected
                    ? ('Restored · ' + result.restored + ' entries put back, '
                       + 'matching what the delete removed')
                    /* A mismatch is shown, not smoothed over. It means part of
                       the batch had already been reverted, or something else
                       touched those rows — either way the user should know the
                       counts did not line up. */
                    : ('Restored · ' + result.restored + ' entries put back, '
                       + 'but the delete recorded ' + result.expected
                       + ' — check the recordings below'))
                : rd.summaryLine(result.summary),
            /* The rows that hid nothing and the rows that were refused are
               named, not folded into the count. A delete that matched nothing
               and read as success is the failure this whole surface is
               shaped to avoid. */
            (result.summary && result.summary.nothingHidden.length)
              ? React.createElement('div', { className: 'fs-rec-result__detail' },
                  'Nothing to remove: ' + result.summary.nothingHidden.join(', '))
              : null,
            (result.summary && result.summary.failed.length)
              ? React.createElement('div', { className: 'fs-rec-result__detail' },
                  result.summary.failed.map(function (f, i) {
                    return React.createElement('div', { key: i },
                      f.label + ' — ' + f.error);
                  }))
              : null,
          )
        : null,

      batches.length
        ? React.createElement('div', { className: 'fs-rec-restore' },
            React.createElement('div', { className: 'fs-rec-restore__title' },
              'Recent deletions'),
            batches.map(function (b) {
              return React.createElement('div', {
                key: b.batchId, className: 'fs-rec-restore__row',
              },
                React.createElement('span', null,
                  b.count + ' recording' + (b.count === 1 ? '' : 's')
                    + ' · ' + b.topicsHidden + ' topic'
                    + (b.topicsHidden === 1 ? '' : 's')
                    + ' · ' + rd.hoursLeft(b, now) + 'h left to restore'),
                React.createElement('button', {
                  type: 'button', className: 'fs-btn fs-btn--tertiary fs-btn--sm',
                  disabled: busy,
                  onClick: function () { runRestore(b); },
                }, 'Restore'),
              );
            }),
          )
        : null,

      !anyRows
        ? React.createElement('div', { className: 'fs-evidence__empty' },
            'No recordings in the selected range.')
        : recs.perDay.map(function (day) {
            return React.createElement('div', {
              key: day.date, className: 'fs-evidence__section',
            },
              React.createElement('div', { className: 'fs-evidence__section-header' },
                React.createElement('span', { className: 'fs-evidence__section-date' },
                  fmtDate(day.date)),
                React.createElement('span', { className: 'fs-evidence__section-count' },
                  day.rows.length + ' recording' + (day.rows.length === 1 ? '' : 's')),
              ),
              /* One block per recording. A recording IS a contiguous time
                 block — one press-record → stop — so the block heading is its
                 span, and the media inside it is that span's media.

                 The SELECTABLE unit is the whole block. Individual clips are
                 not offered a checkbox, because the endpoint cannot address a
                 time range inside a recording (there is no such arm, and a
                 topic's only time field is LLM free text that the pipeline
                 forbids using to decide membership). Offering a control that
                 must then refuse is the failure mode this codebase keeps
                 hitting; a separate spec covers doing it for real. */
              day.rows.map(function (r, i) {
                var deletable = rd.canDelete(r, callerCtx);
                var k = keyOf(r);
                var win = rd.sessionWindow(r, day.rows[i + 1]);
                return React.createElement('div', {
                  key: k,
                  className: 'fs-rec-block' + (selected[k] ? ' fs-rec-block--selected' : ''),
                },
                  React.createElement('label', {
                    className: 'fs-rec-row' + (deletable ? '' : ' fs-rec-row--locked'),
                  },
                    deletable
                      ? React.createElement('input', {
                          type: 'checkbox',
                          className: 'fs-rec-row__check',
                          checked: !!selected[k],
                          onChange: function () { toggle(r); },
                        })
                      : React.createElement('span', { className: 'fs-rec-row__check-spacer' }),
                    React.createElement('span', { className: 'fs-rec-row__label' },
                      r.label),
                    React.createElement('span', { className: 'fs-rec-row__meta' },
                      r.sessionBase
                        ? (r.topicCount + ' topic' + (r.topicCount === 1 ? '' : 's')
                           /* `ended_at` is cosmetic and can be absent. When we
                              fall back to the next recording's start, say so —
                              it decides which clips appear under which heading,
                              never what gets deleted (that is addressed by
                              sessionBase, which is exact). */
                           + (win.inferredEnd ? ' · end time not recorded' : ''))
                        /* A report-sourced day is one S3 key for the whole day —
                           there is no per-recording granularity in the data, so
                           we do not invent a boundary the user could select. */
                        : 'Whole day — no separate recordings'),
                  ),
                  React.createElement('div', { className: 'fs-rec-block__media' },
                    React.createElement(Component, {
                      date: r.date, user: r.folder,
                      start: win.start, end: win.end,
                    }),
                  ),
                );
              }),
            );
          }),

      selectedRows.length
        ? React.createElement('div', { className: 'fs-rec-bulkbar' },
            React.createElement('span', null,
              selectedRows.length + ' selected'),
            React.createElement('button', {
              type: 'button', className: 'fs-btn fs-btn--tertiary fs-btn--sm',
              onClick: function () { setSelected({}); },
            }, 'Clear'),
            React.createElement('button', {
              type: 'button', className: 'fs-btn fs-btn--danger fs-btn--sm',
              disabled: busy,
              onClick: function () { setConfirming(true); },
            }, 'Delete'),
          )
        : null,

      React.createElement(Modal, {
        open: confirming,
        rows: selectedRows,
        busy: busy,
        onConfirm: runDelete,
        onCancel: function () { setConfirming(false); },
      }),
    );
  }

  /* ---------- Section: Audio / Video / Transcripts (composite per-day)
     Each underlying composite fetches its own data on mount. */

  function MediaPerDayTab(props) {
    var ctx = React.useContext(EvidenceContext);
    if (ctx.state.status !== 'ok') {
      return React.createElement('div', { className: 'fs-evidence__loading' },
        'Loading…');
    }
    var dates = ctx.state.dates || [];
    var user  = ctx.state.user;

    if (dates.length === 0) {
      return React.createElement('div', { className: 'fs-evidence__empty' },
        'No reports in the selected range.');
    }

    var Component = props.component;

    return React.createElement('div', { className: 'fs-evidence__sections' },
      dates.map(function (d) {
        return React.createElement('div', { key: d, className: 'fs-evidence__section' },
          React.createElement('div', { className: 'fs-evidence__section-header' },
            React.createElement('span', { className: 'fs-evidence__section-date' },
              fmtDate(d)),
          ),
          React.createElement(Component, Object.assign({
            date: d, user: user,
          }, props.extraProps || {})),
        );
      }),
    );
  }

  /* ---------- EvidenceMiddleColumn ------------------------------------ */

  function EvidenceMiddleColumn(props) {
    var fs              = window.FieldSight;
    var EvidenceTabs    = fs.EvidenceTabs;
    var Button          = fs.Button;
    var RangeToolbar    = fs.RangeToolbar;

    var ctx = React.useContext(EvidenceContext);
    if (!ctx) {
      console.warn('[EvidenceMiddleColumn] EvidenceContext missing');
      return null;
    }
    var state = ctx.state;

    var header = React.createElement('div', { className: 'fs-evidence__header' },
      React.createElement('h2', { className: 'fs-evidence__title' }, 'Evidence'));
    var toolbar = RangeToolbar
      ? React.createElement(RangeToolbar, {
          value:      ctx.view,
          onChange:   ctx.setView,
          presets:    ['today', '7d', '30d', 'all', 'custom'],
          storageKey: 'fs.settings.evidenceView',
        })
      : null;

    if (state.status === 'loading') {
      return React.createElement('div', { className: 'fs-evidence' },
        header, toolbar,
        React.createElement('div', { className: 'fs-evidence__loading' },
          'Loading evidence…'),
      );
    }
    if (state.status === 'error') {
      var ErrorBanner = window.FieldSight.ErrorBanner;
      return React.createElement('div', { className: 'fs-evidence' },
        header, toolbar,
        ErrorBanner
          ? React.createElement(ErrorBanner, {
              message:   (state.error && state.error.message) || 'Could not load evidence',
              retryable: true,
              onRetry:   state.retry,
            })
          : React.createElement('div', { className: 'fs-evidence__empty' },
              (state.error && state.error.message) || 'Could not load evidence'),
      );
    }
    if (state.status === 'access_denied') {
      var AccessDenied = fs.AccessDenied;
      return React.createElement('div', { className: 'fs-evidence' },
        header,
        AccessDenied
          ? React.createElement(AccessDenied, {
              scope:   'this evidence library',
              message: state.message,
            })
          : React.createElement('div', null, 'Access denied.'),
      );
    }

    var dates = state.dates || [];

    var tabs = [
      { key: 'photos',
        label: 'Photos',
        count: ctx.photos.status === 'ok' ? ctx.photos.totalCount : null },
      { key: 'audio',       label: 'Audio' },
      { key: 'video',       label: 'Video' },
      { key: 'transcripts', label: 'Transcripts' },
    ];

    var body;
    switch (ctx.activeTab) {
      /* Audio and Video group the day into per-recording blocks and carry the
         delete controls. Transcripts stays a plain per-day list: deleting from
         a transcript would read as removing a passage, and the endpoint's unit
         is the whole recording. */
      case 'audio':
        body = React.createElement(DeletableMediaTab, {
          component: fs.AudioPlaylist,
        });
        break;
      case 'video':
        body = React.createElement(DeletableMediaTab, {
          component: fs.VideoPlayer,
        });
        break;
      case 'transcripts':
        body = React.createElement(MediaPerDayTab, {
          component: fs.TranscriptList,
        });
        break;
      case 'photos':
      default:
        body = React.createElement(PhotosTab, null);
    }

    return React.createElement('div', { className: 'fs-evidence' },

      /* Header */
      React.createElement('div', { className: 'fs-evidence__header' },
        React.createElement('h2', { className: 'fs-evidence__title' }, 'Evidence'),
        React.createElement('div', { className: 'fs-evidence__subtitle' },
          dates.length + ' ' + (dates.length === 1 ? 'day' : 'days')
            + ' with reports in this range'
            + (ctx.view.preset === 'all' ? '' : ' · showing up to ' + ctx.daysToLoad + ' at a time')),
      ),
      toolbar,

      /* Tabs */
      React.createElement(EvidenceTabs, {
        tabs:     tabs,
        active:   ctx.activeTab,
        onChange: ctx.setActiveTab,
      }),

      /* Body */
      dates.length === 0
        ? React.createElement('div', { className: 'fs-evidence__empty' },
            'No reports in the selected range.')
        : body,

      /* Load more — hidden for the 'all' preset since every in-range day
         is already rendered; there's nothing left to page in. */
      (ctx.view.preset !== 'all' && dates.length >= ctx.daysToLoad)
        ? React.createElement('div', { className: 'fs-evidence__load-more' },
            React.createElement(Button, {
              variant: 'secondary', size: 'sm',
              onClick: ctx.loadMore,
            }, 'Load more (+' + LOAD_STEP + ' days)'),
          )
        : null,
    );
  }

  /* ---------- EvidenceRightDetail ------------------------------------- */

  function EvidenceRightDetail(props) {
    var fs  = window.FieldSight;
    var ctx = React.useContext(EvidenceContext);
    if (!ctx) return null;
    var state = ctx.state;

    if (state.status !== 'ok') {
      return React.createElement('div', { className: 'fs-evidence-detail__placeholder' },
        React.createElement('div', { className: 'fs-evidence-detail__placeholder-title' },
          'Evidence library'),
        React.createElement('div', { className: 'fs-evidence-detail__placeholder-body' },
          'Browse media across recent reports — photos, audio, video, transcripts.'),
      );
    }

    var dates = state.dates || [];
    var firstDate = dates[dates.length - 1];
    var lastDate  = dates[0];

    var tabBlurbs = {
      photos:      'Field photos taken on the day, indexed by topic.',
      audio:       'PTT audio chunks (VAD-segmented). Click ▶ to play.',
      video:       'H264 preview clips only — originals stay device-side.',
      transcripts: 'Diarised speaker turns from each day’s recordings.',
    };

    var counts = ctx.photos.status === 'ok' && ctx.activeTab === 'photos'
      ? ctx.photos.totalCount + ' ' + (ctx.photos.totalCount === 1 ? 'photo' : 'photos')
      : null;

    return React.createElement('div', { className: 'fs-evidence-detail' },

      React.createElement('div', { className: 'fs-evidence-detail__header' },
        React.createElement('h2', { className: 'fs-evidence-detail__title' },
          ctx.activeTab.charAt(0).toUpperCase() + ctx.activeTab.slice(1)),
        React.createElement('div', { className: 'fs-evidence-detail__blurb' },
          tabBlurbs[ctx.activeTab] || ''),
      ),

      React.createElement('div', { className: 'fs-evidence-detail__stats' },
        React.createElement(StatRow, {
          label: 'Range',
          value: dates.length
                  ? fmtDate(firstDate) + ' → ' + fmtDate(lastDate)
                  : '—',
        }),
        React.createElement(StatRow, {
          label: 'Days with reports',
          value: dates.length,
        }),
        counts != null
          ? React.createElement(StatRow, { label: 'Found', value: counts })
          : null,
      ),

      React.createElement('div', { className: 'fs-evidence-detail__note' },
        'Click any media item in the centre column to drill in. Photos open in a lightbox; audio plays inline; video uses the previews.'),
    );
  }

  function StatRow(props) {
    return React.createElement('div', { className: 'fs-evidence-detail__stat' },
      React.createElement('div', { className: 'fs-evidence-detail__stat-label' },
        props.label),
      React.createElement('div', { className: 'fs-evidence-detail__stat-value' },
        props.value),
    );
  }

  /* ---------- Register --------------------------------------------------- */

  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.PAGES) window.FieldSight.PAGES = {};
  window.FieldSight.PAGES['/evidence'] = {
    Middle:   EvidenceMiddleColumn,
    Right:    EvidenceRightDetail,
    Provider: EvidenceProvider,
    layout:   'full-width',   /* Sprint 10 A — photo grid needs full width; detail via RightDrawer */
  };

})();
