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
      case 'audio':
        body = React.createElement(MediaPerDayTab, {
          component: fs.AudioPlaylist,
        });
        break;
      case 'video':
        body = React.createElement(MediaPerDayTab, {
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
