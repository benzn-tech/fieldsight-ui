/* ==========================================================================
   FieldSight Today Page — Sprint 2.4 (PLAN.md Phase D)
   --------------------------------------------------------------------------
   Today is now a DERIVED view over the latest DailyReport for the
   current user — no more bespoke mock-data shim. The same composites
   (TaskCard / UrgentCard / ActivityCard / MorningBriefCard / OnSiteCard)
   render unchanged; only the data source moved.

   Pipeline:
     FS.api.timeline.getTimeline (DailyReport)  ─┐
     FS.api.actions.getActions  (audit state)   ├─► todayAdapter.adapt
     fixtures.sites (for primary_site lookup)   ─┘            │
                                                              ▼
                                          { morningBrief, urgent, my/team
                                            tasks, activity, onSite }

   Sprint 2 task-check-off lands on REAL action items here:
     • TaskCard for an item Jarley owns gets a checkbox
     • Click → optimistic toggle through FS.api.actions.toggleAction
     • Animation: border pulse + line-through + fade-out (CSS, respects
       prefers-reduced-motion via tokens.css media query)
     • On animation end the row drops out of myTasks locally; full
       refresh on next mount picks up the persisted state

   Two exports: a Middle column component and a Right detail component.
   Both registered into window.FieldSight.PAGES under the '/today' key.
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  /* Today's date in NZDT — see BUG-19. We compute "today" via
     FS.api.todayNZDT() (Pacific/Auckland clock). If no report exists
     for that date, fall back to the latest available date from
     /api/dates so the prototype keeps rendering meaningfully when run
     on any calendar day. (P-06.) */

  /* ---------- SectionLabel (small uppercase heading) --------------------- */
  function SectionLabel(props) {
    var color = props.color || 'var(--text-tertiary)';
    return React.createElement('div', {
      style: {
        fontSize: '10px',
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: color,
        margin: '20px 0 8px',
        padding: '0 4px',
      },
    }, props.children);
  }

  function SubsectionLabel(props) {
    return React.createElement('div', {
      style: {
        fontSize: '11px',
        fontWeight: 600,
        color: 'var(--text-secondary)',
        margin: '8px 0 4px',
        padding: '0 4px',
        letterSpacing: '0.02em',
      },
    }, props.children);
  }

  /* ---------- Helper: derive Today from a backend report --------------- */

  function buildTodayFromReport(report, actions, caller, date, siteSlugMap, idPrefix) {
    var sitesFx = (window.FieldSight && window.FieldSight.fixtures && window.FieldSight.fixtures.sites) || { users: [] };
    var match = (sitesFx.users || []).filter(function (u) { return u.name === (caller && caller.name); })[0];
    var primarySite = match ? match.primary_site : 'sb1108-ellesmere';

    return window.FS.api.todayAdapter.adapt(report, {
      currentUserName: caller && caller.name,
      primarySite:     primarySite,
      actionState:     actions || {},
      date:            date,
      siteSlugByName:  siteSlugMap || {},
      idPrefix:        idPrefix || null,
    });
  }

  /* ---------- Cross-project fan-out helpers (feat/today-by-project) ----
     Today has no site selector by design — it's meant to be "everything
     due today across ALL your projects". An admin/gm caller's own folder
     has no single report of its own (getTimeline(date, user=null) for
     admin returns the `available_users` disambiguation envelope, per
     CLAUDE.md "Admin permission flow" — never data), so the single-report
     fast path silently showed nothing (or a stray single report) for
     that caller. isMultiProjectCaller() gates the real fan-out below.

     adminUserFolders() / isMultiProjectCaller() intentionally mirror the
     PRIVATE (non-exported) helpers of the same name in
     tasks-aggregator.js / compliance-aggregator.js rather than importing
     them — that's the existing convention in this codebase (each
     aggregator keeps its own copy; there's no shared export to reuse). */
  function isMultiProjectCaller(caller) {
    caller = caller || {};
    return caller.role === 'admin' || caller.role === 'gm' || !!caller.isAdmin;
  }

  function deriveFolderFromUser(u) {
    return u.folder_name || (u.name ? u.name.replace(/ /g, '_') : '');
  }

  /* Sourced from GET /api/users (report identity) — live = pass-through
     of /api/users, mock = fixtures.sites.users. Falls back to a direct
     fixtures read on any /api/users error. Copy of
     tasks-aggregator.js:adminUserFolders() / compliance-aggregator.js:
     adminUserFolders() — same source, same fallback, intentional parity. */
  async function adminUserFolders() {
    try {
      var usersRes = await window.FS.api.sites.getUsers();
      return ((usersRes && usersRes.users) || []).map(deriveFolderFromUser).filter(Boolean);
    } catch (e) {
      return ((window.FieldSight && window.FieldSight.fixtures
          && window.FieldSight.fixtures.sites && window.FieldSight.fixtures.sites.users) || [])
          .map(deriveFolderFromUser).filter(Boolean);
    }
  }

  /* report.site is a DISPLAY NAME only ('SB1108 Ellesmere College') — no
     slug travels with a report. FS.api.sites.getSites() (report-side site
     list, BACKEND-CONTEXT §4.2 GET /api/sites) is the source of truth for
     name → site_id; built once per load, reused across every fanned-out
     report. Defensive: an error collapses to an empty map, so every item
     just carries site_slug: null (never blocks the page). */
  async function getSiteSlugMap() {
    try {
      var res = await window.FS.api.sites.getSites();
      var map = {};
      ((res && res.sites) || []).forEach(function (s) {
        if (s && s.name) map[s.name] = s.site_id;
      });
      return map;
    } catch (e) {
      return {};
    }
  }

  /* Merge N adapt()-shaped envelopes (one per fanned-out report) into a
     single Today data object. Concatenates the list fields (every item
     already carries its own site_name/site_slug from today-adapter.js),
     unions onSite by device id, and picks the caller's OWN report's
     morningBrief when their folder is among the fanned-out set (falls
     back to the first report's brief otherwise — a merged view has no
     single "my brief" by construction). */
  function mergeTodayData(entries, ownFolder) {
    var urgent = [], myTasks = [], teamTasks = [], activity = [];
    var onSiteById = {};
    var brief = null;
    var newestDate = null;

    entries.forEach(function (e) {
      var d = e.data;
      if (!d) return;
      urgent    = urgent.concat(d.urgent || []);
      myTasks   = myTasks.concat(d.myTasks || []);
      teamTasks = teamTasks.concat(d.teamTasks || []);
      activity  = activity.concat(d.activity || []);
      (d.onSite || []).forEach(function (p) { onSiteById[p.id] = p; });
      if (!newestDate) newestDate = d.date;
      if (!brief || e.folder === ownFolder) brief = d.morningBrief;
    });

    return {
      date:         newestDate,
      site:         null,       /* merged view has no single site */
      site_slug:    null,
      morningBrief: brief || { generatedAt: '—', bullets: [] },
      urgent:       urgent,
      myTasks:      myTasks,
      teamTasks:    teamTasks,
      activity:     activity,
      onSite:       Object.keys(onSiteById).map(function (k) { return onSiteById[k]; }),
    };
  }

  /* Distinct {slug, name} projects represented across the rendered item
     lists — the render layer's single source of truth for "how many
     projects am I looking at" (rather than trusting a separately-tracked
     counter that could drift from what's actually on screen). Items
     without a resolvable site are ignored for this count. */
  function distinctProjects(data) {
    var seen = {};
    var list = [];
    var pools = [data.urgent, data.myTasks, data.teamTasks, data.programmeTasks];
    pools.forEach(function (pool) {
      (pool || []).forEach(function (item) {
        var slug = item.site_slug || item.site_name;
        if (!slug || seen[slug]) return;
        seen[slug] = true;
        list.push({ slug: slug, name: item.site_name || slug });
      });
    });
    return list;
  }

  /* Groups items by project (site_slug, falling back to site_name),
     preserving first-seen order. Mirrors the date-grouping template in
     safety.js (~344-393) — same shape, grouped by project instead of
     date. */
  function groupByProject(items) {
    var order = [];
    var map = {};
    (items || []).forEach(function (item) {
      var slug = item.site_slug || item.site_name || '__unknown__';
      if (!map[slug]) {
        map[slug] = { slug: slug, name: item.site_name || 'Other', rows: [] };
        order.push(slug);
      }
      map[slug].rows.push(item);
    });
    return order.map(function (slug) { return map[slug]; });
  }

  /* Renders `items` either flat (single-project — unchanged layout) or
     grouped into project-headed sections (multi-project). `renderItem`
     is the existing per-row renderer each call site already has. */
  function renderMaybeGrouped(items, isMultiProject, renderItem) {
    if (!isMultiProject) {
      return React.createElement('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '6px' },
      }, (items || []).map(renderItem));
    }
    var groups = groupByProject(items);
    return React.createElement('div', { className: 'fs-today__project-groups' },
      groups.map(function (g) {
        return React.createElement('div', { key: g.slug, className: 'fs-today__project-group' },
          React.createElement('div', { className: 'fs-today__project-group-header' },
            React.createElement('span', { className: 'fs-today__project-group-label' }, g.name),
            React.createElement('span', { className: 'fs-today__project-group-count' }, g.rows.length),
          ),
          React.createElement('div', { className: 'fs-today__project-group-rows' },
            g.rows.map(renderItem)
          ),
        );
      })
    );
  }

  /* ---------- TodayContext (Sprint 3, P-07) ---------------------------- */
  /* TodayMiddleColumn loads the report; TodayRightDetail needs the same
     snapshot to render `findItemById` lookups for the selected item.
     Phase D used a `window.FieldSight._todayCache` slot for this — fast
     to ship but invisible to React DevTools and broken under multiple
     instances. P-07 replaces it with a proper Context provided at the
     page level via the new `Provider` slot in the page registry; the
     AppShell wraps both Middle + Right in that Provider so they share
     state. */
  var TodayContext = React.createContext(null);

  /* ---------- TodayState hook ------------------------------------------ */
  /* Encapsulates the async fetch + optimistic-removal semantics for
     check-off. Returns { state, removeMyTask }. */
  function useTodayState(caller) {
    var refState = React.useState({ status: 'loading' });
    var state    = refState[0];
    var setState = refState[1];

    var retryRef   = React.useState(0);
    var retryCount = retryRef[0];
    var setRetry   = retryRef[1];

    /* Re-key the effect on the caller name+role: dev role switcher
       changes role → teamTasks visibility flips; reload to recompute. */
    var depKey = (caller && caller.name) + '|' + (caller && caller.role) + '|' + (caller && caller.isAdmin);

    React.useEffect(function () {
      var cancelled = false;
      setState({ status: 'loading' });

      var today    = window.FS.api.todayNZDT();
      var folder   = window.FS.api.folderName(caller.name);

      /* Sprint 4.10.3 — Programme tasks for today run in parallel
         with the daily-report load. They live under data.programmeTasks
         so the My Tasks renderer can split them into a sub-group and
         render the ProgrammeTaskCard variant. Promise resolves with
         { rows: [...] } regardless of role / fixture state, so we
         can pass it straight through Promise.all without bailout
         logic. */
      var programmePromise = (window.FS.api.todayProgramme
        ? window.FS.api.todayProgramme.getTodayProgrammeTasks({ today: today, user: folder })
        : Promise.resolve({ rows: [] })
      ).then(function (r) { return (r && r.rows) || []; })
       .catch(function () { return []; });

      var multiProject = isMultiProjectCaller(caller);

      /* Single-project fast path — UNCHANGED behaviour (still exactly
         one getTimeline call), just also stamps site_name/site_slug onto
         every derived item so TaskCard can show its project chip (Part
         B). siteSlugMapPromise is fetched either way but is cheap (one
         extra /api/sites call) and shared across a fallback-date retry
         via the closure below. */
      var siteSlugMapPromise   = getSiteSlugMap();
      /* Hoisted alongside siteSlugMapPromise — the folder list doesn't
         depend on `date`, so fetch it once per effect run and share it
         across both the primary-date and fallback-date loadFor() calls
         below, instead of re-fetching on the fallback retry. */
      var adminFoldersPromise = multiProject ? adminUserFolders() : Promise.resolve([]);

      function loadFor(date, isFallback) {
        if (!multiProject) {
          return Promise.all([
            window.FS.api.timeline.getTimeline({ date: date, user: folder }),
            window.FS.api.actions.getActions(date),
            siteSlugMapPromise,
          ]).then(function (results) {
            if (cancelled) return null;
            var report     = results[0];
            var actions    = results[1].actions || {};
            var siteSlugMap = results[2];
            /* P-12: 403 from the timeline endpoint surfaces as a
               page-level access-denied state. Worker / site-manager
               querying another user's report hits this. */
            if (report && report._accessDenied) {
              return { accessDenied: true, message: report.error };
            }
            if (!report || report._notFound || report.available_users) {
              return { ok: false, report: report };
            }
            var data = buildTodayFromReport(report, actions, caller, date, siteSlugMap);
            return {
              ok:            true,
              data:          data,
              actions:       actions,
              effectiveDate: date,
              isFallback:    !!isFallback,
              today:         today,
            };
          });
        }

        /* Admin / multi-project fan-out — CLAUDE.md "Admin permission
           flow": getTimeline(date, user=null) for admin returns the
           available_users disambiguation envelope, NOT data, so we
           resolve the user list ourselves (adminUserFolders(), same
           source as tasks-aggregator.js / compliance-aggregator.js) and
           fan out (date × every known user), pooled via FS.api.pooledAll
           — same bounded-concurrency helper the other aggregators use so
           an org with many users doesn't trip API Gateway throttling. A
           failing folder's fetch → null → filtered (partial data beats a
           dead page), matching the pooledAll contract everywhere else. */
        return Promise.all([
          adminFoldersPromise,
          siteSlugMapPromise,
          window.FS.api.actions.getActions(date),
        ]).then(function (results) {
          if (cancelled) return null;
          var folders     = results[0];
          var siteSlugMap = results[1];
          var actionsRes  = results[2];
          if (actionsRes && actionsRes._accessDenied) {
            return { accessDenied: true, message: actionsRes.error };
          }
          var actions = actionsRes.actions || {};

          var thunks = folders.map(function (f) {
            return function () {
              return window.FS.api.timeline.getTimeline({ date: date, user: f })
                .then(function (r) { return { folder: f, report: r }; });
            };
          });
          return window.FS.api.pooledAll(thunks, 8).then(function (fanned) {
            if (cancelled) return null;
            var valid = fanned.filter(function (x) {
              return x && x.report && !x.report._notFound
                && !x.report.available_users && !x.report._accessDenied;
            });
            if (valid.length === 0) {
              return { ok: false, report: {} };
            }
            var entries = valid.map(function (x) {
              return {
                folder: x.folder,
                data:   buildTodayFromReport(x.report, actions, caller, date, siteSlugMap, x.folder),
              };
            });
            var merged = mergeTodayData(entries, folder);
            return {
              ok:            true,
              data:          merged,
              actions:       actions,
              effectiveDate: date,
              isFallback:    !!isFallback,
              today:         today,
            };
          });
        });
      }

      /* Helper — merges the programme rows into the data envelope so
         every setState site below can compose the same shape without
         repeating the await. */
      function withProgramme(envelope, programmeRows) {
        if (!envelope || !envelope.data) return envelope;
        return Object.assign({}, envelope, {
          data: Object.assign({}, envelope.data, {
            programmeTasks: programmeRows || [],
          }),
        });
      }

      /* feat/today-fallback-per-project — multi-project fallback.
         Reports are sparse and land on a DIFFERENT date per project, so
         the single global `latest` date from getSpan() almost always
         belongs to only ONE project — loadFor(latest, true) would
         silently show just that project's todos with no grouping ever
         visible. Instead: resolve EACH accessible folder's OWN latest
         hasReport date (pooled FS.api.dates.getDates per folder), fetch
         that folder's own-latest report (pooled getTimeline), and merge
         via the SAME mergeTodayData the primary fan-out path uses — so
         the result is per-project-tagged and renderMaybeGrouped groups
         it exactly like the "today has data" multi-project case.

         Worst case API calls: N folders × getDates (pooled, limit 8)
         + up to N folders × getTimeline (pooled, limit 8) — bounded
         concurrency the same way the primary fan-out already is.

         Actions/check-off overlay: SKIPPED here (empty actions map).
         Each folder resolves a DIFFERENT date, so overlaying check-off
         state correctly would need one getActions() call per distinct
         resolved date on top of the two fan-outs above; this is a
         read-only "latest activity per project" view, not today's live
         checklist, so the simpler-and-correct choice is no overlay
         (chose "pass an empty actions map" per spec, not the merged-
         per-date getActions fan-out). */
      function loadPerProjectLatest() {
        return Promise.all([adminFoldersPromise, siteSlugMapPromise]).then(function (results) {
          if (cancelled) return null;
          var folders     = results[0];
          var siteSlugMap = results[1];

          var dateThunks = folders.map(function (f) {
            return function () {
              return window.FS.api.dates.getDates({
                months: window.FS.api.window.MONTHS_LOOKBACK,
                user:   f,
              }).then(function (res) {
                var dmap = (res && res.dates) || {};
                var reportDays = Object.keys(dmap).filter(function (k) {
                  return dmap[k] && dmap[k].hasReport;
                }).sort();
                return { folder: f, latest: reportDays.length ? reportDays[reportDays.length - 1] : null };
              });
            };
          });

          return window.FS.api.pooledAll(dateThunks, 8).then(function (resolved) {
            if (cancelled) return null;
            var withLatest = (resolved || []).filter(function (x) { return x && x.latest; });
            if (withLatest.length === 0) {
              return { ok: false, report: {} };
            }

            var reportThunks = withLatest.map(function (x) {
              return function () {
                return window.FS.api.timeline.getTimeline({ date: x.latest, user: x.folder })
                  .then(function (r) { return { folder: x.folder, date: x.latest, report: r }; });
              };
            });

            return window.FS.api.pooledAll(reportThunks, 8).then(function (fanned) {
              if (cancelled) return null;
              var valid = (fanned || []).filter(function (x) {
                return x && x.report && !x.report._notFound
                  && !x.report.available_users && !x.report._accessDenied;
              });
              if (valid.length === 0) {
                return { ok: false, report: {} };
              }

              var entries = valid.map(function (x) {
                return {
                  folder: x.folder,
                  data:   buildTodayFromReport(x.report, {}, caller, x.date, siteSlugMap, x.folder),
                };
              });
              var merged = mergeTodayData(entries, folder);

              return {
                ok:               true,
                data:             merged,
                actions:          {},
                /* Mixed folder-dates — no single date to show. The
                   render layer keys its "LATEST AVAILABLE <date>"
                   banner off effectiveDate; perProjectLatest below
                   tells it to swap to the "each project" copy instead. */
                effectiveDate:    null,
                isFallback:       true,
                perProjectLatest: true,
                today:            today,
              };
            });
          });
        });
      }

      Promise.all([loadFor(today, false), programmePromise])
        .then(function (results) {
          if (cancelled) return;
          var first          = results[0];
          var programmeRows  = results[1];

          if (!first) return;
          if (first.accessDenied) {
            setState({ status: 'access_denied', message: first.message, today: today });
            return;
          }
          if (first.ok) {
            setState(Object.assign({ status: 'ok' }, withProgramme(first, programmeRows)));
            return;
          }
          /* No report for today — try the latest available. Widened
             discovery (Task C) via FS.api.window.getSpan() so the
             fallback reaches historic report months instead of the
             trailing 3-month window (data is Feb/Mar while "today"
             runs months ahead of it). */
          return window.FS.api.window.getSpan().then(function (span) {
            if (cancelled) return;
            var latest = span && span.latest;

            if (multiProject) {
              /* Multi-project fallback = per-folder latest (see
                 loadPerProjectLatest above), NOT loadFor(latest, true)
                 — the single global `latest` almost always belongs to
                 only one project. `latest` (possibly null) still
                 threads through to the empty-state CTA below when NO
                 folder resolves a report of its own. */
              return loadPerProjectLatest().then(function (result) {
                if (cancelled || !result) return;
                if (result.accessDenied) {
                  setState({ status: 'access_denied', message: result.message, today: today });
                  return;
                }
                if (result.ok) {
                  setState(Object.assign({ status: 'ok' }, withProgramme(result, programmeRows)));
                } else {
                  setState({
                    status:         'empty',
                    report:         result.report,
                    today:          today,
                    programmeTasks: programmeRows,
                    latest:         latest,
                    folder:         folder,
                  });
                }
              });
            }

            if (!latest || latest === today) {
              /* Empty-state still shows today's programme tasks if any —
                 the programme is not gated on a daily report existing.
                 `latest` (possibly null) threads through so the render
                 branch can offer a "View latest report" CTA when one
                 exists. */
              setState({
                status:         'empty',
                report:         first.report,
                today:          today,
                programmeTasks: programmeRows,
                latest:         latest,
                folder:         folder,
              });
              return;
            }
            return loadFor(latest, true).then(function (second) {
              if (cancelled || !second) return;
              if (second.accessDenied) {
                setState({ status: 'access_denied', message: second.message, today: today });
                return;
              }
              if (second.ok) {
                setState(Object.assign({ status: 'ok' }, withProgramme(second, programmeRows)));
              } else {
                setState({
                  status:         'empty',
                  report:         second.report,
                  today:          today,
                  programmeTasks: programmeRows,
                  latest:         latest,
                  folder:         folder,
                });
              }
            });
          });
        }).catch(function (err) {
          if (cancelled) return;
          setState({ status: 'error', error: { code: (err && err.status) || 0, message: (err && err.message) || 'Could not load today', retryable: true }, retry: function () { setRetry(function (n) { return n + 1; }); }, today: today });
        });

      return function () { cancelled = true; };
    }, [depKey, retryCount]);

    /* Local optimistic removal — used after the check-off animation
       finishes to drop a task out of the rendered list without a
       network round-trip. The next mount re-fetches the persisted
       audit state. */
    function removeMyTask(taskId) {
      setState(function (s) {
        if (s.status !== 'ok' || !s.data) return s;
        var nextMy = (s.data.myTasks || []).filter(function (t) { return t.id !== taskId; });
        return Object.assign({}, s, {
          data: Object.assign({}, s.data, { myTasks: nextMy }),
        });
      });
    }

    return { state: state, removeMyTask: removeMyTask };
  }

  /* ---------- In-page lookups (replace old MockData helpers) ----------- */

  function findItemById(data, id) {
    if (!id || !data) return null;
    var pools = [
      data.urgent || [], data.myTasks || [],
      data.teamTasks || [], data.activity || [],
    ];
    for (var i = 0; i < pools.length; i++) {
      for (var j = 0; j < pools[i].length; j++) {
        if (pools[i][j].id === id) return pools[i][j];
      }
    }
    return null;
  }

  function getRelated(data, item) {
    if (!item || !data) return [];

    if (item.kind === 'task') {
      var allTasks = (data.myTasks || []).concat(data.teamTasks || []);
      return allTasks
        .filter(function (t) { return t.id !== item.id && t.assignee === item.assignee; })
        .slice(0, 3)
        .map(function (t) {
          return { id: t.id, title: t.title,
                   subtitle: t.status + ' · due ' + t.dueTime };
        });
    }

    if (item.kind === 'activity') {
      return (data.activity || [])
        .filter(function (a) { return a.id !== item.id && a.speaker === item.speaker; })
        .slice(0, 3)
        .map(function (a) {
          return { id: a.id, title: a.snippet,
                   subtitle: a.timeAgo + ' · ' + a.channel };
        });
    }

    if (item.kind === 'urgent') {
      return (data.urgent || [])
        .filter(function (u) { return u.id !== item.id; })
        .slice(0, 3)
        .map(function (u) {
          return { id: u.id, title: u.title, subtitle: u.badgeLabel };
        });
    }

    return [];
  }

  function getTimeline(item) {
    if (!item) return [];

    if (item.kind === 'task') {
      return [
        { label: 'Captured in topic',          actor: 'AI · transcript',  time: 'Today' },
        { label: 'Assigned to ' + item.assignee, actor: 'Report generator', time: 'Today' },
        { label: 'Status: ' + item.status,     actor: item.assignee,      time: 'Today' },
      ];
    }
    if (item.kind === 'urgent') {
      return [
        { label: 'Flagged urgent',                                   actor: 'System', time: 'Today' },
        { label: 'Triggered by · ' + (item.triggeredBy || 'manual'), actor: 'System', time: 'Today' },
      ];
    }
    if (item.kind === 'activity') {
      return [
        { label: 'Captured',                            actor: item.speaker,      time: item.timeAgo },
        { label: 'Transcribed',                         actor: 'AWS Transcribe',  time: 'just after capture' },
        { label: 'Tagged · ' + (item.channel || 'General'), actor: 'AI',          time: 'just after capture' },
      ];
    }
    return [];
  }

  /* =====================================================================
     TodayProvider — owns the page state and exposes it via TodayContext.
     AppShell wraps Middle + Right in this so both columns see the same
     snapshot. (P-07)
     ===================================================================== */
  function TodayProvider(props) {
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
    var ts     = useTodayState(caller);
    /* Stable-ish value object — not memoised because the TodayState
       hook already re-keys its effect on caller identity, and the
       consumers below read .state every render anyway. */
    var ctx = { state: ts.state, removeMyTask: ts.removeMyTask };
    return React.createElement(TodayContext.Provider, { value: ctx },
      props.children);
  }

  /* =====================================================================
     Sprint 11 C.2 · WeeklyCompletionKpi
     ─────────────────────────────────────────────────────────────────────
     Mini KPI tile shown above the Urgent block on /today. Calls
     `tasks.getCrossDayAudit` for [Mon..today] (Q-S11-1 default) and
     reports closed/total + a 7-day SparkLine of daily-closed counts.

     Hidden when both totals are zero (demo dataset edge case + first-
     boot avoid).
     ===================================================================== */

  function WeeklyCompletionKpi() {
    var fs        = window.FieldSight;
    var SparkLine = fs.SparkLine;

    var dataRef = React.useState({ status: 'loading' });
    var data    = dataRef[0]; var setData = dataRef[1];

    React.useEffect(function () {
      var cancelled = false;
      var today = window.FS.api.todayNZDT();
      /* Q-S11-1 default: calendar week Mon→today. Day-of-week
         is computed from Date.UTC parse of the ISO string to dodge
         BUG-19 (NZDT timezone drift). */
      function mondayOf(iso) {
        var p = iso.split('-').map(Number);
        var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
        var dow = d.getUTCDay();          /* 0 = Sun, 1 = Mon, ... */
        var offset = dow === 0 ? -6 : 1 - dow;
        return window.FS.api.addDaysISO(iso, offset);
      }
      var weekStart = mondayOf(today);

      window.FS.api.tasks.getCrossDayAudit({
        from: weekStart, to: today,
      }).then(function (res) {
        if (cancelled) return;
        if (!res || res._accessDenied) {
          setData({ status: 'hidden' });
          return;
        }
        var entries = res.entries || [];
        var total   = entries.length;
        var closed  = entries.filter(function (e) { return e.checked; }).length;
        if (total === 0) { setData({ status: 'hidden' }); return; }

        /* Daily closed-count for the SparkLine — fill missing days
           with zero so the curve always shows the full week. */
        var byDay = {};
        var d = weekStart;
        while (d && d <= today) {
          byDay[d] = 0;
          d = window.FS.api.addDaysISO(d, 1);
        }
        entries.forEach(function (e) {
          if (e.checked && byDay[e.date] != null) byDay[e.date] += 1;
        });
        var trend = Object.keys(byDay).sort().map(function (date) {
          return { date: date, value: byDay[date] };
        });

        setData({
          status: 'ok', total: total, closed: closed, trend: trend,
          weekStart: weekStart, today: today,
        });
      }).catch(function () {
        if (!cancelled) setData({ status: 'hidden' });
      });

      return function () { cancelled = true; };
    }, []);

    if (data.status !== 'ok') return null;

    var pct = data.total > 0 ? Math.round((data.closed / data.total) * 100) : 0;

    return React.createElement('div', { className: 'fs-today__week-kpi' },
      React.createElement('div', { className: 'fs-today__week-kpi-text' },
        React.createElement('div', { className: 'fs-today__week-kpi-headline' },
          data.closed + ' / ' + data.total + ' actions resolved this week'),
        React.createElement('div', { className: 'fs-today__week-kpi-sub' },
          pct + '% complete · since Mon ' + (data.weekStart.split('-')[2] || '')),
      ),
      SparkLine ? React.createElement(SparkLine, {
        points: data.trend, tone: 'success', width: 140, height: 32,
      }) : null,
    );
  }

  /* =====================================================================
     Today Middle Column
     ===================================================================== */
  function TodayMiddleColumn(props) {
    var fs       = window.FieldSight;
    var onSelect = props.onSelect || function () {};
    /* Sprint 7 follow-up — track current selection so cards can paint
       a --selected modifier. AppShell holds the canonical selectedItem
       and passes it through; we only read the id for matching. */
    var selectedId = props.selectedItem && props.selectedItem.id;

    var ctx = React.useContext(TodayContext);
    if (!ctx) {
      console.warn('[TodayMiddleColumn] TodayContext missing — was the page Provider mounted?');
      return null;
    }
    var state    = ctx.state;
    var removeMy = ctx.removeMyTask;

    if (state.status === 'loading') {
      return React.createElement('div', { className: 'fs-page fs-page--today' },
        React.createElement('div', { style: { padding: '24px', color: 'var(--text-tertiary)', fontSize: '13px' } },
          'Loading today…'),
      );
    }

    if (state.status === 'error') {
      var ErrorBanner = fs.ErrorBanner;
      return React.createElement('div', { className: 'fs-page fs-page--today' },
        ErrorBanner
          ? React.createElement(ErrorBanner, {
              message:   (state.error && state.error.message) || 'Could not load today',
              retryable: true,
              onRetry:   state.retry,
            })
          : React.createElement('div', { style: { padding: '24px', color: 'var(--text-tertiary)', fontSize: '13px' } },
              (state.error && state.error.message) || 'Could not load today'),
      );
    }

    /* P-12 — empathetic 403. The api/_fetch helper marks 403 responses
       with `_accessDenied: true`; today.js relays that to the
       AccessDenied composite (BACKEND-CONTEXT §8.4). */
    if (state.status === 'access_denied') {
      var AccessDenied = fs.AccessDenied;
      return React.createElement('div', { className: 'fs-page fs-page--today' },
        AccessDenied
          ? React.createElement(AccessDenied, {
              scope:   "today's report",
              message: state.message,
            })
          : React.createElement('div', null, 'Access denied.'),
      );
    }

    if (state.status === 'empty') {
      var report = state.report || {};
      var msg = (report.available_users && 'Pick a user from /timeline to view a daily report.')
              || report.message
              || 'No report yet for today.';
      var emptyLatest = state.latest;
      return React.createElement('div', { className: 'fs-page fs-page--today' },
        React.createElement('div', { style: { padding: '24px', color: 'var(--text-tertiary)', fontSize: '13px' } },
          msg),

        /* Task C — when the widened data-window discovery (:198 above)
           found a report on some earlier date but couldn't use it as a
           fallback here (e.g. it's today itself, or the same-user load
           still came back empty), offer a direct deep-link instead of
           leaving the page a dead end. Reuses the OK-branch CTA markup
           below (fs-today__view-report-cta). Guarded on latest existing. */
        emptyLatest
          ? React.createElement('button', {
              type:      'button',
              className: 'fs-today__view-report-cta',
              onClick:   function () {
                var qs = '?date=' + encodeURIComponent(emptyLatest);
                if (state.folder) qs += '&user=' + encodeURIComponent(state.folder);
                qs += '&from=today';
                window.FS.Router.navigate('/timeline' + qs);
              },
            },
              React.createElement('span', { className: 'fs-today__view-report-cta-text' },
                'View latest report (' + fmtDate(emptyLatest) + ')'),
              React.createElement('span', { className: 'fs-today__view-report-cta-arrow' },
                '→'),
            )
          : null,
      );
    }

    var data              = state.data;
    var effectiveDate     = state.effectiveDate;
    var isFallback        = !!state.isFallback;
    /* feat/today-fallback-per-project — set by loadPerProjectLatest()
       when today has no report AND the caller is multi-project: each
       accessible project fanned out to ITS OWN latest report date
       (mixed dates, so effectiveDate above is null). Swaps the fallback
       banner copy below; renderMaybeGrouped groups the merged list by
       project unchanged. */
    var perProjectLatest  = !!state.perProjectLatest;

    /* Part B — group-by-project vs. per-card chip. Computed straight off
       the item lists actually being rendered (not a separately-tracked
       counter) so it can never drift from what's on screen. Multiple
       projects → project-headed groups per section; exactly one (or
       zero — nothing resolvable) → flat lists with a chip on each
       TaskCard instead (see renderMaybeGrouped / TaskCard `site` prop). */
    var projects       = distinctProjects(data);
    var isMultiProject = projects.length > 1;

    /* When the check-off anim finishes, drop the task locally. The
       optimistic toggle inside TaskCard already persisted via
       FS.api.actions.toggleAction. */
    function onCheckedOff(task) {
      removeMy(task.id);
    }

    /* Format the effective date for the fallback banner. */
    function fmtDate(yyyymmdd) {
      var p = (yyyymmdd || '').split('-').map(Number);
      if (p.length !== 3) return yyyymmdd || '';
      var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
      var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return d.getUTCDate() + ' ' + months[d.getUTCMonth()] + ' ' + p[0];
    }

    return React.createElement('div', {
      style: { display: 'flex', flexDirection: 'column', gap: 0 },
      className: 'fs-page fs-page--today',
    },

      /* Fallback banner — shown when today has no report yet and we're
         displaying the latest available one instead. perProjectLatest
         swaps the single-date copy for the "each project" copy, since
         effectiveDate is null (mixed folder-dates) — same wrapper +
         label/note classes, no new visual style. */
      isFallback ? React.createElement('div', { className: 'fs-today__fallback-banner' },
        perProjectLatest
          ? React.createElement(React.Fragment, null,
              React.createElement('span', { className: 'fs-today__fallback-label' },
                'No reports today'),
              React.createElement('span', { className: 'fs-today__fallback-note' },
                '— showing the latest from each project'),
            )
          : React.createElement(React.Fragment, null,
              React.createElement('span', { className: 'fs-today__fallback-label' },
                'Latest available'),
              React.createElement('span', { className: 'fs-today__fallback-date' },
                fmtDate(effectiveDate)),
              React.createElement('span', { className: 'fs-today__fallback-note' },
                '· no report yet for today (' + fmtDate(state.today) + ')'),
            ),
      ) : null,

      /* "View daily report" CTA — full-width banner above the brief.
         Lifted out of MorningBriefCard so the action stands on its
         own (post-merge review feedback). Navigates to the canonical
         /timeline view scoped to the brief's (date, user). The
         &from=today flag tells TimelineMiddleColumn to render a
         "← Back to today" link in its header (Sprint 4.5). Hidden in
         perProjectLatest mode — effectiveDate is null there (mixed
         folder-dates), so there's no single report to deep-link to;
         each project's own group is reached via its own cards instead. */
      effectiveDate ? React.createElement('button', {
        type:      'button',
        className: 'fs-today__view-report-cta',
        onClick:   function () {
          var qs = '?date=' + encodeURIComponent(effectiveDate);
          var u  = data.morningBrief && data.morningBrief.userFolder;
          if (u) qs += '&user=' + encodeURIComponent(u);
          qs += '&from=today';
          window.FS.Router.navigate('/timeline' + qs);
        },
      },
        React.createElement('span', { className: 'fs-today__view-report-cta-text' },
          'View daily report'),
        React.createElement('span', { className: 'fs-today__view-report-cta-arrow' },
          '→'),
      ) : null,

      /* MORNING BRIEF */
      React.createElement(fs.MorningBriefCard, { brief: data.morningBrief }),

      /* Sprint 11 C.2 — Weekly completion KPI tile.
         Hidden when nothing closed/open in the current week (avoids
         a "0 / 0" empty state on a fresh demo install). */
      React.createElement(WeeklyCompletionKpi, null),

      /* URGENT */
      data.urgent && data.urgent.length > 0
        ? React.createElement(React.Fragment, null,
            React.createElement(SectionLabel, { color: 'var(--color-danger-700)' }, 'Urgent now'),
            renderMaybeGrouped(data.urgent, isMultiProject, function (item) {
              return React.createElement(fs.UrgentCard, {
                key:      item.id,
                item:     item,
                onSelect: onSelect,
                selected: selectedId === item.id,
              });
            }),
          )
        : null,

      /* TASKS — Sprint 4.10: My-tasks list now mixes two sources:
         (1) programme tasks scheduled on today (from FS.api.todayProgramme),
         (2) action items derived from yesterday's daily report.
         Same parent SectionLabel, two visually distinct sub-groups so the
         user reads them as ONE list with provenance, not two lists. */
      React.createElement(SectionLabel, null, 'Tasks today'),

      /* Sub-group 1 — Programme tasks (rendered FIRST since the
         programme work is the structural context for the day; action
         items are reactive details inside it). */
      data.programmeTasks && data.programmeTasks.length > 0
        ? React.createElement(React.Fragment, null,
            React.createElement(SubsectionLabel, null,
              'From your programme · ' + data.programmeTasks.length),
            renderMaybeGrouped(data.programmeTasks, isMultiProject, function (row) {
              return React.createElement(fs.ProgrammeTaskCard, {
                /* Sprint T-004 style task_id is only unique WITHIN one
                   site's programme — the today-programme-adapter.js
                   fan-out (feat/today-by-project) can now return the
                   same task_id from two different sites, so the React
                   key must include site_slug too. */
                key:      (row.site_slug || '') + '_' + row.task_id,
                row:      row,
                onSelect: function () {
                  /* 4.10.6 — navigate to /programme with deep-link
                     so the right drawer opens on the same task. */
                  window.FS.Router.navigate(
                    '/programme?task=' + encodeURIComponent(row.task_id)
                      + '&from=today');
                },
              });
            }),
          )
        : null,

      /* Sub-group 2 — Action items from the daily report. */
      data.myTasks && data.myTasks.length > 0
        ? React.createElement(React.Fragment, null,
            React.createElement(SubsectionLabel, null,
              'From recent reports · ' + data.myTasks.length),
            renderMaybeGrouped(data.myTasks, isMultiProject, function (task) {
              return React.createElement(fs.TaskCard, {
                key:           task.id,
                task:          task,
                onSelect:      onSelect,
                isMine:        true,
                selected:      selectedId === task.id,
                /* perProjectLatest has no single effectiveDate (mixed
                   folder-dates) — toggling would persist against a null
                   date, so check-off is disabled there; it's a read-only
                   "latest per project" view, not today's live checklist. */
                checkable:     task.topic_id != null && task.actionIndex != null && !!effectiveDate,
                date:          effectiveDate,
                onCheckedOff:  onCheckedOff,
                /* Part B — single-project caller gets a subtle project
                   chip per card instead of group headers (reuses the
                   "SiteName · date" label pattern from search-palette.js
                   / ask-chat.js, here just the site half). */
                site:          !isMultiProject ? task.site_name : null,
              });
            }),
          )
        : null,

      data.teamTasks && data.teamTasks.length > 0 ? React.createElement(React.Fragment, null,
        React.createElement(SubsectionLabel, null,
          'Team · ' + data.teamTasks.length),
        renderMaybeGrouped(data.teamTasks, isMultiProject, function (task) {
          return React.createElement(fs.TaskCard, {
            key:      task.id,
            task:     task,
            onSelect: onSelect,
            isMine:   false,
            selected: selectedId === task.id,
            site:     !isMultiProject ? task.site_name : null,
          });
        }),
      ) : null,

      /* (Sprint 3, P-02) Recent activity removed — the same topics are
         now reachable on /timeline as the canonical surface. Today
         stays a quick dashboard: brief → urgent → tasks → on-site. */

      /* ON SITE */
      React.createElement(SectionLabel, null, 'On site now'),
      React.createElement(fs.OnSiteCard, { people: data.onSite }),

    );
  }

  /* =====================================================================
     Today Right Detail
     ===================================================================== */
  function TodayRightDetail(props) {
    var fs       = window.FieldSight;
    var Card     = fs.Card;
    var Badge    = fs.Badge;
    var Button   = fs.Button;
    var IconBtn  = fs.IconButton;
    var Timeline = fs.Timeline;

    var sel = props.selectedItem;

    /* Empty state */
    if (!sel) {
      return React.createElement('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          padding: '32px',
          gap: '12px',
          color: 'var(--text-tertiary)',
        },
      },
        React.createElement('div', {
          style: { fontSize: '14px', fontWeight: 500, color: 'var(--text-secondary)' },
        }, 'Select an item'),
        React.createElement('div', { style: { fontSize: '13px' } },
          'Choose from the list to view details'),
      );
    }

    /* P-07 — the Middle column owns the snapshot via TodayProvider;
       we read it through TodayContext. If a row was check-off-removed
       between click and render, fall back to the selectedItem itself. */
    var ctx  = React.useContext(TodayContext);
    var data = ctx && ctx.state.status === 'ok' ? ctx.state.data : null;
    var item = findItemById(data, sel.id) || sel;

    /* M-4 — wire "Mark complete" to the same persistence path TaskCard
       uses: toggle the action via /api/actions, then drop the task
       optimistically from the page snapshot and close the right detail.
       Surface only when the item is a task that carries the action key. */
    var effectiveDate = (ctx && ctx.state && ctx.state.effectiveDate) || null;
    var canCheckOff   = item.kind === 'task'
                     && item.topic_id   != null
                     && item.actionIndex != null
                     && !!effectiveDate;

    function onMarkComplete() {
      if (!canCheckOff) return;
      var api = window.FS && window.FS.api && window.FS.api.actions;
      if (!api) return;
      api.toggleAction({
        date:         effectiveDate,
        topic_id:     item.topic_id,
        action_index: item.actionIndex,
        checked:      true,
        action_text:  item.title,
      }).then(function () {
        if (ctx && ctx.removeMyTask) ctx.removeMyTask(item.id);
        if (props.onClose) props.onClose();
      }).catch(function (err) {
        console.error('[Today right] markComplete failed', err);
      });
    }

    var rows = [];
    if (item.kind === 'task') {
      rows = [
        ['Assignee', item.assignee],
        ['Due',      item.dueTime],
        ['Status',   item.status],
        ['Priority', item.priority || 'Medium'],
      ];
    } else if (item.kind === 'urgent') {
      rows = [
        ['Severity',     item.badgeLabel],
        ['Triggered by', item.triggeredBy || 'Manual flag'],
        ['Detail',       item.body],
      ];
    } else if (item.kind === 'activity') {
      rows = [
        ['Speaker',  item.speaker],
        ['When',     item.timeAgo],
        ['Source',   'PTT transcript'],
        ['Channel',  item.channel || 'General'],
      ];
    }

    var related  = getRelated(data, item);
    var timeline = getTimeline(item);

    return React.createElement('div', {
      style: {
        padding: '24px',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
        overflowY: 'auto',
        boxSizing: 'border-box',
      },
    },

      React.createElement('div', {
        style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' },
      },
        React.createElement('h2', {
          style: {
            margin: 0, fontSize: '18px', fontWeight: 600,
            color: 'var(--text-primary)', lineHeight: 1.3,
            flex: 1, minWidth: 0,
            display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 3,
            overflow: 'hidden', wordBreak: 'break-word',
          },
        }, item.title || item.snippet || '(item)'),
        React.createElement(IconBtn, {
          icon: 'x', ariaLabel: 'Close detail', size: 'sm',
          onClick: function () { if (props.onClose) props.onClose(); },
        }),
      ),

      item.kind === 'urgent' ? React.createElement('div', {
        style: { display: 'flex', gap: '6px' },
      },
        React.createElement(Badge, {
          tone: item.badgeTone, size: 'sm', prefixDot: true,
        }, item.badgeLabel),
      ) : null,

      item.kind === 'task' ? React.createElement('div', {
        style: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
      },
        React.createElement(Badge, { tone: item.statusTone, size: 'sm' }, item.status),
        item.priority ? React.createElement(Badge, {
          tone: item.priority === 'High' ? 'danger' : item.priority === 'Low' ? 'neutral' : 'warning',
          size: 'sm', variant: 'outline',
        }, item.priority) : null,
      ) : null,

      React.createElement('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 0 },
      },
        rows.map(function (r, i) {
          return React.createElement('div', {
            key: i,
            style: {
              display: 'flex', gap: '12px', padding: '10px 0',
              borderBottom: i < rows.length - 1 ? '1px solid var(--border-subtle)' : 'none',
            },
          },
            React.createElement('div', {
              style: {
                fontSize: '11px', color: 'var(--text-tertiary)', fontWeight: 600,
                width: '88px', flexShrink: 0,
                textTransform: 'uppercase', letterSpacing: '0.06em', paddingTop: '2px',
              },
            }, r[0]),
            React.createElement('div', {
              style: { fontSize: '14px', color: 'var(--text-primary)', flex: 1, lineHeight: 1.45 },
            }, r[1]),
          );
        })
      ),

      related.length > 0 ? React.createElement(React.Fragment, null,
        React.createElement('div', {
          style: {
            fontSize: '11px', fontWeight: 600,
            color: 'var(--text-tertiary)',
            textTransform: 'uppercase', letterSpacing: '0.06em',
            marginTop: '4px',
          },
        }, 'Related'),
        React.createElement('div', {
          style: { display: 'flex', flexDirection: 'column', gap: '6px' },
        },
          /* M-4 — Related rows are informational; clicking did nothing
             but log a stub. Right detail can't currently change the
             middle's selectedItem (that lives in AppShell), so surface
             these as static cards rather than fake-interactive ones. */
          related.map(function (r, i) {
            return React.createElement(Card, {
              key: i, padding: 'sm', variant: 'ghost',
            },
              React.createElement(Card.Body, null,
                React.createElement('div', {
                  style: { fontSize: '13px', color: 'var(--text-primary)', fontWeight: 500 },
                }, r.title),
                React.createElement('div', {
                  style: { fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' },
                }, r.subtitle),
              ),
            );
          })
        ),
      ) : null,

      timeline.length > 0 ? React.createElement(React.Fragment, null,
        React.createElement('div', {
          style: {
            fontSize: '11px', fontWeight: 600,
            color: 'var(--text-tertiary)',
            textTransform: 'uppercase', letterSpacing: '0.06em',
            marginTop: '4px',
          },
        }, 'Timeline'),
        React.createElement(Timeline, { events: timeline }),
      ) : null,

      /* M-4 — only render the action footer when there's an action to
         take. Today the only persistable action from the right detail
         is marking a task complete (Reassign + Acknowledge had no API
         to back them and were stubs). */
      canCheckOff ? React.createElement('div', {
        style: {
          marginTop: 'auto', display: 'flex', gap: '8px',
          justifyContent: 'flex-end',
          paddingTop: '16px', borderTop: '1px solid var(--border-subtle)',
        },
      },
        React.createElement(Button, {
          size: 'sm', leftIcon: 'check',
          onClick: onMarkComplete,
        }, 'Mark complete'),
      ) : null,

    );
  }

  /* ---------- Register --------------------------------------------------- */
  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.PAGES) window.FieldSight.PAGES = {};
  window.FieldSight.PAGES['/today'] = {
    Middle:   TodayMiddleColumn,
    Right:    TodayRightDetail,
    /* P-07 — page-level Provider; AppShell wraps Middle + Right in this
       so they share TodayContext. Pages without page-level state simply
       omit this and AppShell falls back to React.Fragment. */
    Provider: TodayProvider,
    /* Sprint 10 follow-up — reverted full-width 2-panel back to 3-panel
       per UX feedback: morning brief + KPIs + tasks + recent activity
       all want a quiet detail rail rather than a slide-in drawer.
       Activity / Settings / Evidence keep their 2-panel layout. */
  };

})();
