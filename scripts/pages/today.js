/* ==========================================================================
   FieldSight Today Page — feat/today-rolling-open-items
   --------------------------------------------------------------------------
   Today is a ROLLING open-items list, not a single-day snapshot. Three
   parts, assembled independently and merged into one render-shaped
   object:

     1. Today-scoped extras (morning brief, urgent, on-site) — from
        TODAY's own report, when one exists. Absent otherwise.
     2. Rolling unresolved tasks (the core) — every action item from
        reports in the trailing ROLLING_LOOKBACK_DAYS window that is
        NOT yet checked off, mine + team, tagged with age + a
        no-deadline flag. An item keeps showing every day until it's
        resolved, instead of vanishing when the calendar day changes.
        Checking one off drops it (existing optimistic removeMyTask).
     3. Near-deadline programme — programme tasks whose deadline (end)
        falls within the next PROGRAMME_DEADLINE_DAYS days.

   Pipeline (reused, not reimplemented):
     FS.api.timeline.getTimeline (DailyReport)  ─┐
     FS.api.actions.getActionsRange (audit)     ├─► todayAdapter.adapt
     fixtures.sites (for primary_site lookup)   ─┘   (same pure split
                                                        used by both #1
                                                        and #2 below)

   Sprint 2 task-check-off lands on REAL action items here:
     • TaskCard for an item Jarley owns gets a checkbox
     • Click → optimistic toggle through FS.api.actions.toggleAction,
       keyed by the ITEM'S OWN origin date (rolling items carry mixed
       dates — there is no single page-level "today" to check off
       against any more)
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

  /* feat/today-rolling-open-items — how far back the rolling open-items
     scan looks for unresolved action items, and how far forward the
     near-deadline programme lookahead reaches. Both windows anchor on
     FS.api.todayNZDT() (BUG-19 — never new Date('YYYY-MM-DD')). */
  var ROLLING_LOOKBACK_DAYS   = 30;
  var PROGRAMME_DEADLINE_DAYS = 7;

  /* UTC-safe day diff — mirrors today-programme-adapter.js:diffDays.
     fromISO/toISO are 'YYYY-MM-DD'; parsing via 'T00:00:00Z' avoids the
     NZDT local-midnight drift new Date('YYYY-MM-DD') is prone to
     (BUG-19). Returns toISO - fromISO in whole days. */
  function diffDaysISO(fromISO, toISO) {
    var a = new Date(fromISO + 'T00:00:00Z').getTime();
    var b = new Date(toISO   + 'T00:00:00Z').getTime();
    return Math.round((b - a) / 86400000);
  }

  /* 'Today' / 'Nd ago' — the only age vocabulary this page uses. Overdue
     framing is explicitly out of scope (deadlines are free-text /
     unreliable) — age is the one reliable, read-only signal. */
  function formatAgeLabel(ageDays) {
    if (ageDays == null) return null;
    if (ageDays <= 0) return 'Today';
    return ageDays + 'd ago';
  }

  /* Today's date in NZDT — see BUG-19. We compute "today" via
     FS.api.todayNZDT() (Pacific/Auckland clock). */

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

  /* ---------- TimelineLink — persistent "Open timeline" affordance ------
     fix/today-timeline-and-focus. Rendered at the top of BOTH the
     'empty' and 'ok' branches of TodayMiddleColumn's render, unlike the
     primary "View daily report" CTA (.fs-today__view-report-cta) below
     it, which only shows when a single `effectiveDate` is known (today
     itself has a report) — the rolling open-items list mixes dates and
     has no single date to deep-link to.

     Navigates to /timeline?date=<date>[&user=<user>]&from=today when a
     date is known, or bare /timeline?from=today otherwise. timeline.js's
     own M-2 bootstrap effect self-resolves a dateless visit to the
     latest available date (or an admin project/user picker when
     ambiguous) — see that file's "no date in the URL" effect — so the
     bare link always lands somewhere useful, never a dead page. */
  function TimelineLink(props) {
    var dateOpt = props.date || null;
    var userOpt = props.user || null;
    var label   = props.label || 'Open timeline';

    function onClick() {
      var parts = [];
      if (dateOpt) parts.push('date=' + encodeURIComponent(dateOpt));
      if (dateOpt && userOpt) parts.push('user=' + encodeURIComponent(userOpt));
      parts.push('from=today');
      window.FS.Router.navigate('/timeline?' + parts.join('&'));
    }

    return React.createElement('div', { className: 'fs-today__timeline-link-row' },
      React.createElement('button', {
        type:      'button',
        className: 'fs-today__timeline-link',
        onClick:   onClick,
      },
        React.createElement('span', null, label),
        React.createElement('span', { className: 'fs-today__timeline-link-arrow' }, '→'),
      ),
    );
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

      /* feat/today-rolling-open-items (§D) — widened from "scheduled
         today" to "deadline within the next PROGRAMME_DEADLINE_DAYS
         days" via the new getUpcomingProgrammeTasks adapter function
         (additive sibling of getTodayProgrammeTasks — same row shape,
         so ProgrammeTaskCard + the data.programmeTasks wiring below
         are unchanged). Runs in parallel with the daily-report loads.
         Promise resolves with { rows: [...] } regardless of role /
         fixture state, so we can pass it straight through Promise.all
         without bailout logic. */
      var programmeDeadline = window.FS.api.addDaysISO(today, PROGRAMME_DEADLINE_DAYS);
      var programmePromise = (window.FS.api.todayProgramme && window.FS.api.todayProgramme.getUpcomingProgrammeTasks
        ? window.FS.api.todayProgramme.getUpcomingProgrammeTasks({ from: today, to: programmeDeadline, user: folder })
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
         between loadFor() below and loadRollingOpenItems() further
         down (both need "every accessible folder" for a multi-project
         caller). */
      var adminFoldersPromise = multiProject ? adminUserFolders() : Promise.resolve([]);

      /* Today-scoped extras only (§B) — always called for TODAY itself,
         never a fallback date any more (feat/today-rolling-open-items
         dropped the "latest available" retry; the rolling loader below
         is what covers older dates now). */
      function loadFor(date) {
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
              today:         today,
            };
          });
        });
      }

      /* feat/today-rolling-open-items (§A) — the core replacement for
         loadRecentPerProject/loadPerProjectLatest. Scans the trailing
         ROLLING_LOOKBACK_DAYS window across every accessible folder for
         UNRESOLVED action items (mine + team) — an item keeps showing
         every day until it's checked off, regardless of which calendar
         day it was extracted on. Folder set mirrors the rest of this
         file (CLAUDE.md "Admin permission flow"): admin/gm fan out
         across adminFoldersPromise (already resolved above); everyone
         else is scoped to their own folder only.

         Steps:
           1. Resolve report-dates per folder in [from, today] via
              FS.api.dates.getDates (pooled) — the (date, folder) pairs
              with hasReport true.
           2. ONE FS.api.actions.getActionsRange({from, to}) call for
              the whole window (not cached, but a single request).
           3. Pooled FS.api.timeline.getTimeline per (date, folder) pair
              — cached (PR #53), so repeat visits are cheap; first load
              can issue up to pairs.length requests (pooled at 8).
           4. buildTodayFromReport (SAME adapter call as loadFor above)
              per report, using that report's OWN date's audit slice —
              so status/checked state is correct for THAT date, not
              today's. Items whose audit key is checked are dropped
              (todayAdapter.adapt keeps checked items with status
              'Done' rather than dropping them — see today-adapter.js
              — so this filter is load-bearing, not a safety net).
           5. Each surviving item is stamped with its origin date (also
              carried by the adapter itself now — today-adapter.js §
              feat/today-rolling-open-items), ageDays (diffDaysISO vs
              today), and noDeadline (from the adapter's raw `deadline`
              field, distinct from the always-populated `dueTime`).
           6. Merge across dates: the SAME logical action (folder +
              topic_id + actionIndex — exactly today-adapter.js's `id`
              when idPrefix=folder, which this always passes) can be
              re-extracted on a later report date. Dedupe keyed by
              item.id, keeping the OLDEST occurrence (largest ageDays)
              so the card reads as "carried over N days", not reset.

         Returns { myTasks, teamTasks } — no effectiveDate (mixed
         dates); check-off is per-item (§C) via each item's own .date. */
      function loadRollingOpenItems() {
        var from = window.FS.api.addDaysISO(today, -ROLLING_LOOKBACK_DAYS);
        var EMPTY = { myTasks: [], teamTasks: [] };

        var foldersPromise = multiProject ? adminFoldersPromise : Promise.resolve([folder]);

        return Promise.all([foldersPromise, siteSlugMapPromise]).then(function (results) {
          if (cancelled) return EMPTY;
          var folders     = (results[0] || []).filter(Boolean);
          var siteSlugMap = results[1];
          if (folders.length === 0) return EMPTY;

          /* 1) (date, folder) pairs with a real report in the window. */
          var dateThunks = folders.map(function (f) {
            return function () {
              return window.FS.api.dates.getDates({
                months: window.FS.api.window.MONTHS_LOOKBACK,
                user:   f,
              }).then(function (res) {
                var dmap = (res && res.dates) || {};
                return Object.keys(dmap)
                  .filter(function (d) { return dmap[d] && dmap[d].hasReport && d >= from && d <= today; })
                  .map(function (d) { return { date: d, folder: f }; });
              }).catch(function () { return []; });
            };
          });

          return window.FS.api.pooledAll(dateThunks, 8).then(function (perFolder) {
            if (cancelled) return EMPTY;
            var pairs = [];
            (perFolder || []).forEach(function (list) { if (list) pairs = pairs.concat(list); });
            if (pairs.length === 0) return EMPTY;

            /* 2) One audit fan-out for the whole window. */
            return window.FS.api.actions.getActionsRange({ from: from, to: today }).then(function (auditRange) {
              if (cancelled) return EMPTY;
              /* Partial data beats a dead page — the today-scoped
                 brief/urgent/onSite load (loadFor above) succeeds
                 independently of this leg. */
              if (auditRange && auditRange._accessDenied) return EMPTY;
              var byDate = auditRange.byDate || {};

              /* 3) Pooled report fan-out. */
              var reportThunks = pairs.map(function (p) {
                return function () {
                  return window.FS.api.timeline.getTimeline({ date: p.date, user: p.folder })
                    .then(function (report) { return { date: p.date, folder: p.folder, report: report }; })
                    .catch(function () { return null; });
                };
              });

              return window.FS.api.pooledAll(reportThunks, 8).then(function (fanned) {
                if (cancelled) return EMPTY;

                var myById   = {};
                var teamById = {};

                function keep(list, bucket, actionState, date) {
                  (list || []).forEach(function (item) {
                    var auditKey = item.topic_id + '_' + item.actionIndex;
                    var resolved = !!(actionState[auditKey] && actionState[auditKey].checked);
                    if (resolved) return; /* checked off — drop */

                    item.date       = item.date || date;
                    item.ageDays    = diffDaysISO(item.date, today);
                    item.noDeadline = !item.deadline;

                    var existing = bucket[item.id];
                    if (!existing || item.ageDays > existing.ageDays) {
                      bucket[item.id] = item;
                    }
                  });
                }

                (fanned || []).forEach(function (x) {
                  if (!x || !x.report) return;
                  var report = x.report;
                  if (report._notFound || report.available_users || report._accessDenied) return;

                  var actionState = byDate[x.date] || {};
                  var data = buildTodayFromReport(report, actionState, caller, x.date, siteSlugMap, x.folder);

                  keep(data.myTasks,   myById,   actionState, x.date);
                  keep(data.teamTasks, teamById, actionState, x.date);
                });

                return {
                  myTasks:   Object.keys(myById).map(function (k) { return myById[k]; }),
                  teamTasks: Object.keys(teamById).map(function (k) { return teamById[k]; }),
                };
              });
            });
          });
        });
      }

      Promise.all([loadFor(today), loadRollingOpenItems(), programmePromise])
        .then(function (results) {
          if (cancelled) return;
          var todayResult   = results[0];
          var rolling       = results[1] || { myTasks: [], teamTasks: [] };
          var programmeRows = results[2] || [];

          if (!todayResult) return;
          if (todayResult.accessDenied) {
            setState({ status: 'access_denied', message: todayResult.message, today: today });
            return;
          }

          /* §B — today-scoped extras (brief/urgent/onSite) only when
             today itself has a report; simply absent otherwise (no
             latest-available fallback — the rolling list is the
             substance now). */
          var baseData = todayResult.ok ? todayResult.data : {
            date:         null,
            site:         null,
            site_slug:    null,
            morningBrief: { generatedAt: '—', bullets: [] },
            urgent:       [],
            onSite:       [],
          };

          var data = Object.assign({}, baseData, {
            myTasks:        rolling.myTasks,
            teamTasks:      rolling.teamTasks,
            programmeTasks: programmeRows,
          });

          /* "View daily report" CTA + check-off default only make sense
             when TODAY itself has a report. */
          var effectiveDate = todayResult.ok ? today : null;

          var hasContent = !!effectiveDate
            || (data.urgent && data.urgent.length > 0)
            || (data.myTasks && data.myTasks.length > 0)
            || (data.teamTasks && data.teamTasks.length > 0)
            || (data.programmeTasks && data.programmeTasks.length > 0);

          if (!hasContent) {
            setState({ status: 'empty', today: today, folder: folder });
            return;
          }

          setState({ status: 'ok', data: data, effectiveDate: effectiveDate, today: today });
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

    /* feat/today-rolling-open-items (§E) — empty state now means "no
       report today AND nothing unresolved in the rolling window AND
       nothing due soon", not "no report for today specifically". The
       old per-project "recent activity" fallback banner/CTA is gone —
       there's nothing to fall back TO any more, the rolling list IS
       the substance. TimelineLink stays so /timeline is always
       reachable even from a genuinely quiet Today. */
    if (state.status === 'empty') {
      return React.createElement('div', { className: 'fs-page fs-page--today' },
        React.createElement(TimelineLink, { user: state.folder }),
        React.createElement('div', {
          style: {
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            textAlign: 'center', gap: '6px', padding: '40px 24px',
          },
        },
          React.createElement('div', {
            style: { fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)' },
          }, "No open items — you're all caught up"),
          React.createElement('div', {
            style: { fontSize: '13px', color: 'var(--text-tertiary)' },
          }, 'Nothing unresolved in the last ' + ROLLING_LOOKBACK_DAYS + ' days, and nothing due in the next ' + PROGRAMME_DEADLINE_DAYS + ' days.'),
        ),
      );
    }

    var data              = state.data;
    var effectiveDate     = state.effectiveDate;

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


    return React.createElement('div', {
      style: { display: 'flex', flexDirection: 'column', gap: 0 },
      className: 'fs-page fs-page--today',
    },

      /* fix/today-timeline-and-focus — always-present header action,
         NOT gated on effectiveDate (unlike the "View daily report" CTA
         below). */
      React.createElement(TimelineLink, null),

      /* "View daily report" CTA — full-width banner above the brief.
         Lifted out of MorningBriefCard so the action stands on its
         own (post-merge review feedback). Navigates to the canonical
         /timeline view scoped to the brief's (date, user). The
         &from=today flag tells TimelineMiddleColumn to render a
         "← Back to today" link in its header (Sprint 4.5). Only shown
         when TODAY itself has a report (effectiveDate === today) —
         feat/today-rolling-open-items dropped the "latest available"
         fallback, so there's no other date this could deep-link to. */
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

      /* MORNING BRIEF — §B: today-scoped, only when TODAY itself has a
         report (effectiveDate truthy). Otherwise simply absent, rather
         than rendering an empty "Morning Brief" card with no bullets. */
      effectiveDate ? React.createElement(fs.MorningBriefCard, { brief: data.morningBrief }) : null,

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

      /* TASKS — feat/today-rolling-open-items mixes two sources:
         (1) near-deadline programme tasks (deadline within
             PROGRAMME_DEADLINE_DAYS — FS.api.todayProgramme.
             getUpcomingProgrammeTasks),
         (2) rolling unresolved action items from the trailing
             ROLLING_LOOKBACK_DAYS days (loadRollingOpenItems above).
         Same parent SectionLabel, two visually distinct sub-groups so
         the user reads them as ONE list with provenance, not two lists. */
      React.createElement(SectionLabel, null, 'Tasks'),

      /* Sub-group 1 — Programme tasks (rendered FIRST since the
         programme work is the structural context for the day; action
         items are reactive details inside it). */
      data.programmeTasks && data.programmeTasks.length > 0
        ? React.createElement(React.Fragment, null,
            React.createElement(SubsectionLabel, null,
              'Due within ' + PROGRAMME_DEADLINE_DAYS + ' days · ' + data.programmeTasks.length),
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

      /* Sub-group 2 — rolling unresolved action items (§C — per-item
         check-off). Each task carries its OWN origin date (stamped by
         today-adapter.js / loadRollingOpenItems) since the list mixes
         dates — there is no single page-level effectiveDate to check
         off against any more. */
      data.myTasks && data.myTasks.length > 0
        ? React.createElement(React.Fragment, null,
            React.createElement(SubsectionLabel, null,
              'Open items · ' + data.myTasks.length),
            renderMaybeGrouped(data.myTasks, isMultiProject, function (task) {
              return React.createElement(fs.TaskCard, {
                key:           task.id,
                task:          task,
                onSelect:      onSelect,
                isMine:        true,
                selected:      selectedId === task.id,
                checkable:     task.topic_id != null && task.actionIndex != null && !!task.date,
                date:          task.date,
                onCheckedOff:  onCheckedOff,
                /* Part B — single-project caller gets a subtle project
                   chip per card instead of group headers (reuses the
                   "SiteName · date" label pattern from search-palette.js
                   / ask-chat.js, here just the site half). */
                site:          !isMultiProject ? task.site_name : null,
                /* §E — age + no-deadline read-only signals. */
                ageLabel:      formatAgeLabel(task.ageDays),
                noDeadline:    !!task.noDeadline,
              });
            }),
          )
        : null,

      data.teamTasks && data.teamTasks.length > 0 ? React.createElement(React.Fragment, null,
        React.createElement(SubsectionLabel, null,
          'Team · ' + data.teamTasks.length),
        renderMaybeGrouped(data.teamTasks, isMultiProject, function (task) {
          return React.createElement(fs.TaskCard, {
            key:        task.id,
            task:       task,
            onSelect:   onSelect,
            isMine:     false,
            selected:   selectedId === task.id,
            site:       !isMultiProject ? task.site_name : null,
            ageLabel:   formatAgeLabel(task.ageDays),
            noDeadline: !!task.noDeadline,
          });
        }),
      ) : null,

      /* (Sprint 3, P-02) Recent activity removed — the same topics are
         now reachable on /timeline as the canonical surface. Today
         stays a quick dashboard: brief → urgent → tasks → on-site. */

      /* ON SITE — §B: today-scoped, only when TODAY itself has a report.
         Derived from the report's own site, so with no report there's
         no reliable "who's on site" answer to show — a bare "0 on
         site" would read as "nobody's here" rather than "unknown". */
      effectiveDate ? React.createElement(React.Fragment, null,
        React.createElement(SectionLabel, null, 'On site now'),
        React.createElement(fs.OnSiteCard, { people: data.onSite }),
      ) : null,

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
       Surface only when the item is a task that carries the action key.
       feat/today-rolling-open-items (§C) — gated on the ITEM's OWN
       .date (stamped by today-adapter.js), not a page-level
       effectiveDate: the rolling list mixes origin dates, so there is
       no single date to fall back to any more. */
    var canCheckOff = item.kind === 'task'
                    && item.topic_id   != null
                    && item.actionIndex != null
                    && !!item.date;

    function onMarkComplete() {
      if (!canCheckOff) return;
      var api = window.FS && window.FS.api && window.FS.api.actions;
      if (!api) return;
      api.toggleAction({
        date:         item.date,
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
      /* §E — age + no-deadline read-only signals, mirrored here for the
         right-detail view (the card list already surfaces them). */
      if (item.ageDays != null) rows.push(['Open since', formatAgeLabel(item.ageDays)]);
      if (item.noDeadline) rows.push(['Deadline', 'None set']);
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
