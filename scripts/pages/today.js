/* ==========================================================================
   FieldSight Today Page — feat/today-rolling-open-items,
                            feat/today-leftover-grouping
   --------------------------------------------------------------------------
   Today is a ROLLING open-items list, not a single-day snapshot. Three
   parts, assembled independently and merged into one render-shaped
   object:

     1. Today-scoped extras (morning brief, urgent, on-site) — from
        TODAY's own report, when one exists. Absent otherwise.
     2. Rolling unresolved tasks (the core) — every action item from
        every report in the FULL report span (feat/today-leftover-
        grouping widened this from a fixed trailing 30d window — verified
        against live data, ALL unresolved items were 90-180d old, so a
        30d floor showed nothing) that is NOT yet checked off, mine +
        team, tagged with age + a no-deadline flag. An item keeps
        showing until it's resolved, instead of vanishing when the
        calendar day changes. At render time the merged list is split
        into a Recent group (ageDays <= LEFTOVER_THRESHOLD_DAYS, front-
        and-center, existing My/Team/Programme treatment) and a
        collapsible Leftover group (ageDays > LEFTOVER_THRESHOLD_DAYS,
        default collapsed, grouped by project). Checking one off drops
        it (existing optimistic removeMyTask, now scans both buckets).
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

  /* feat/today-rolling-open-items — how far forward the near-deadline
     programme lookahead reaches, anchored on FS.api.todayNZDT() (BUG-19
     — never new Date('YYYY-MM-DD')). The rolling open-items scan itself
     no longer has a fixed lookback const — it scans the FULL report span
     (see loadRollingOpenItems' use of FS.api.window.getSpan()). */
  var PROGRAMME_DEADLINE_DAYS = 7;

  /* feat/today-leftover-grouping — an open item is "Recent" (front-and-
     center, existing My/Team treatment) when its ageDays is at most
     this; older items are "Leftover" (collapsible, grouped by project,
     collapsed by default). Tunable. */
  var LEFTOVER_THRESHOLD_DAYS = 90;

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

  /* fix/today-onsite-live — the caller's own accessible/membership site,
     used as the FALLBACK for resolveOnSiteSlug() below when a report's
     own site name can't be resolved to a slug. Previously this fell
     back to the hardcoded literal 'sb1108-ellesmere' whenever
     caller.name matched none of the sb1108-ellesmere fixture's 4 users
     — which every LIVE caller not named one of those four hit, quietly
     mis-scoping "on site now" to sb1108 regardless of the caller's REAL
     site (e.g. Ben_UCPK on UC PK still saw sb1108's JT/DB/BL/SC).
     caller.site is the caller's real membership site_id in live mode
     (scripts/auth/session-bridge.js bridges FS.session.user.sites[0]
     onto AuthMock.currentUser.site at sign-in); mock mode still prefers
     a fixture name-match first (existing dev-role-switcher personas all
     resolve here, unchanged behaviour). */
  function resolveCallerPrimarySite(caller) {
    var sitesFx = (window.FieldSight && window.FieldSight.fixtures && window.FieldSight.fixtures.sites) || { users: [] };
    var match = (sitesFx.users || []).filter(function (u) { return u.name === (caller && caller.name); })[0];
    return match ? match.primary_site : ((caller && caller.site) || null);
  }

  /* fix/today-onsite-live — which site slug "On site now" should query
     for a given report: the report's OWN site (resolved via
     siteSlugByName, built once per load — see getSiteSlugMap below),
     falling back to the caller's own membership site
     (resolveCallerPrimarySite above) only on a lookup miss. Mirrors
     today-adapter.js's old (now removed) onSiteLookupSlug logic — moved
     here because the live members fetch has to happen BEFORE adapt()
     runs (adapt() is pure/sync, can't await). */
  function resolveOnSiteSlug(report, siteSlugMap, primarySite) {
    var siteName = (report && report.site) || '';
    var siteSlug = (siteName && siteSlugMap[siteName]) || null;
    return siteSlug || primarySite || null;
  }

  /* fix/today-onsite-live — LIVE per-site members for the "On site now"
     widget, replacing today-adapter.js's old static fixture scan.
     Reuses FS.api.sites.getSiteUsers — the same live/mock + ACL-
     fallback wrapper every other page (timeline.js, sites.js, team.js,
     evidence.js) already calls for "who's on this site"; it delegates
     to FS.api.org.getSiteMembers (Aurora GET /sites/{id}/members) when
     live. No slug / failure -> [] (never blocks the page — matches
     every other defensive fetch in this file; never falls back to a
     fixture). */
  function getOnSiteMembers(siteSlug) {
    var sitesApi = window.FS.api.sites;
    if (!siteSlug || !sitesApi || !sitesApi.getSiteUsers) return Promise.resolve([]);
    return sitesApi.getSiteUsers(siteSlug).then(function (res) {
      if (!res || res._accessDenied || res._notFound) return [];
      return res.users || [];
    }).catch(function () { return []; });
  }

  function buildTodayFromReport(report, actions, caller, date, siteSlugMap, idPrefix, onSiteMembers, siteIdMap) {
    return window.FS.api.todayAdapter.adapt(report, {
      currentUserName: caller && caller.name,
      actionState:     actions || {},
      date:            date,
      siteSlugByName:  siteSlugMap || {},
      idPrefix:        idPrefix || null,
      onSiteMembers:   onSiteMembers || [],
      /* feat/editable-tasks-ui — org SITE UUID map, see getOrgSiteIdMap()
         doc above. */
      siteIdByName:    siteIdMap || {},
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

  /* feat/editable-tasks-ui — org SITE UUID counterpart of getSiteSlugMap()
     above, built the SAME way (one-shot name→id map, name-matched against
     report.site since a report never carries an id directly) but sourced
     from org.getOrgSites() (Aurora-accessible sites, {sites:[{site_id,
     name, ...}]} via _toPageSite) instead of the legacy report-gateway
     /api/sites list — a DIFFERENT id space (see programme.js's "CRITICAL"
     doc: org.getOrgSites()'s site_id is the ORG SITE UUID space, never the
     report-side site_id). org.getSiteMembers(siteId) — the task-detail
     assignee picker's source — expects THIS UUID space specifically (GET
     /api/org/sites/{id}/members); passing the legacy report-side id there
     would 404/empty. Same defensive posture as getSiteSlugMap(): any
     error collapses to an empty map, so a lookup miss just yields
     task.siteId: null (today-adapter.js), never blocks the page. Mock
     mode: org.getOrgSites() itself falls back to fixtures.sites (see
     org.js orgLive()), so this still resolves something in the demo. */
  async function getOrgSiteIdMap() {
    try {
      var res = await window.FS.api.org.getOrgSites();
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
    /* #4 — project is ALWAYS a high-level group header (even single-project),
       so a section reads "SB1108 Ellesmere College" with that project's items
       nested under it. Replaces the removed per-card site chip: the chip is
       gone from the cards and this group header carries the project instead.
       (isMultiProject is now vestigial — kept in the signature so the call
       sites don't have to change.) */
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
      /* feat/editable-tasks-ui — org SITE UUID counterpart, fetched once
         alongside siteSlugMapPromise for the same reason (cheap, shared
         across every fanned-out report and the rolling loader below). */
      var siteIdMapPromise     = getOrgSiteIdMap();
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
            window.FS.api.timeline.getTimeline({ date: date }),
            window.FS.api.actions.getActions(date),
            siteSlugMapPromise,
            siteIdMapPromise,
          ]).then(function (results) {
            if (cancelled) return null;
            var report     = results[0];
            var actions    = results[1].actions || {};
            var siteSlugMap = results[2];
            var siteIdMap    = results[3];
            /* Non-admin path: getTimeline() above is called with no
               `user`, so the backend already force-scopes to the
               caller's own identity (aurora shim forces user=self;
               legacy fallback resolves worker/site_manager to their
               own data first) — a non-admin must never be hard-banned
               from their own Today. Treat a stray _accessDenied the
               same as _notFound: an empty/no-report state, not the
               page-level AccessDenied composite. (Admin fan-out below
               still surfaces _accessDenied — that's a real per-user
               permission boundary there.) */
            if (!report || report._notFound || report.available_users || report._accessDenied) {
              return { ok: false, report: report };
            }
            /* fix/today-onsite-live — resolve + fetch the LIVE site
               members for "On site now" BEFORE calling
               buildTodayFromReport (adapt() is pure/sync — see
               resolveOnSiteSlug/getOnSiteMembers above). */
            var onSiteSlug = resolveOnSiteSlug(report, siteSlugMap, resolveCallerPrimarySite(caller));
            return getOnSiteMembers(onSiteSlug).then(function (onSiteMembers) {
              if (cancelled) return null;
              var data = buildTodayFromReport(report, actions, caller, date, siteSlugMap, null, onSiteMembers, siteIdMap);
              return {
                ok:            true,
                data:          data,
                actions:       actions,
                effectiveDate: date,
                today:         today,
              };
            });
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
          siteIdMapPromise,
        ]).then(function (results) {
          if (cancelled) return null;
          var folders     = results[0];
          var siteSlugMap = results[1];
          var actionsRes  = results[2];
          var siteIdMap    = results[3];
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

            /* fix/today-onsite-live — one members fetch per DISTINCT
               resolved site slug across the fanned reports (not one
               per report), pooled like every other fan-out in this
               file. primarySite is the same caller-membership fallback
               resolveOnSiteSlug uses on the single-project path above. */
            var primarySite  = resolveCallerPrimarySite(caller);
            var slugByFolder = {};
            var uniqueSlugs  = {};
            valid.forEach(function (x) {
              var slug = resolveOnSiteSlug(x.report, siteSlugMap, primarySite);
              slugByFolder[x.folder] = slug;
              if (slug) uniqueSlugs[slug] = true;
            });
            var slugThunks = Object.keys(uniqueSlugs).map(function (slug) {
              return function () {
                return getOnSiteMembers(slug).then(function (members) {
                  return { slug: slug, members: members };
                });
              };
            });

            return window.FS.api.pooledAll(slugThunks, 8).then(function (memberResults) {
              if (cancelled) return null;
              var membersBySlug = {};
              (memberResults || []).forEach(function (r) { if (r) membersBySlug[r.slug] = r.members; });

              var entries = valid.map(function (x) {
                var slug = slugByFolder[x.folder];
                var onSiteMembers = slug ? (membersBySlug[slug] || []) : [];
                return {
                  folder: x.folder,
                  data:   buildTodayFromReport(x.report, actions, caller, date, siteSlugMap, x.folder, onSiteMembers, siteIdMap),
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
        });
      }

      /* feat/today-rolling-open-items (§A), widened by
         feat/today-leftover-grouping — the core replacement for
         loadRecentPerProject/loadPerProjectLatest. Scans the FULL report
         span (every hasReport date up to today, not a fixed trailing
         window — live data showed ALL unresolved items are 90-180d old,
         so a 30d floor found nothing) across every accessible folder for
         UNRESOLVED action items (mine + team) — an item keeps showing
         every day until it's checked off, regardless of which calendar
         day it was extracted on. Folder set mirrors the rest of this
         file (CLAUDE.md "Admin permission flow"): admin/gm fan out
         across adminFoldersPromise (already resolved above); everyone
         else is scoped to their own folder only.

         Steps:
           0. Resolve the scan floor via FS.api.window.getSpan() —
              span.earliest is the smallest hasReport date across its
              24-month lookback. Falls back to a generous 400d floor if
              the span is empty (fresh install, no reports yet at all).
           1. Resolve report-dates per folder in [from, today] via
              FS.api.dates.getDates (pooled) — the (date, folder) pairs
              with hasReport true.
           2. ONE FS.api.actions.getActionsRange({from, to}) call for
              the whole span (not cached, but a single request).
           3. Pooled FS.api.timeline.getTimeline per (date, folder) pair
              — cached (PR #53), so repeat visits are cheap; first load
              can issue up to pairs.length requests (pooled at 8) — now
              larger than before since the span covers every report
              date, not just a trailing 30d slice.
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
           6. Merge across dates: each report's action items are
              independent (topic_id restarts at 0 per report), so there is
              NO cross-date "same logical action" to dedupe — every
              (date, topic_id, actionIndex) is a distinct item. Because
              today-adapter.js's id (folder + topic_id + index) is
              date-independent and thus collides across dates, keep() makes
              the id date-unique (date + '__' + id) so distinct leftover
              actions are never false-merged.

         Returns { myTasks, teamTasks } — the FULL merged lists (no
         Recent/Leftover split here; that split is computed at RENDER
         TIME in TodayMiddleColumn from these same lists, so the
         existing removeMyTask-by-id optimistic-removal path and
         findItemById lookups keep working unchanged regardless of which
         group an item renders in). No effectiveDate (mixed dates);
         check-off is per-item (§C) via each item's own .date. */
      function loadRollingOpenItems() {
        var EMPTY = { myTasks: [], teamTasks: [] };

        var foldersPromise = multiProject ? adminFoldersPromise : Promise.resolve([folder]);

        return Promise.all([foldersPromise, siteSlugMapPromise, window.FS.api.window.getSpan(), siteIdMapPromise])
          .then(function (results) {
          if (cancelled) return EMPTY;
          var folders     = (results[0] || []).filter(Boolean);
          var siteSlugMap = results[1];
          var span        = results[2] || {};
          var siteIdMap    = results[3];
          /* feat/today-leftover-grouping — span.earliest (smallest
             hasReport date) replaces the old fixed -30d floor. Empty
             span (no reports at all yet) falls back to a generous 400d
             floor rather than scanning nothing. */
          var from = span.earliest || window.FS.api.addDaysISO(today, -400);
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

            /* 2) One audit fan-out for the whole span. */
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
                    /* feat/user-dim-audit-key (Task 6) — item.folder is
                       the report OWNER's folder, stamped by
                       today-adapter.js. lookupAction tries the
                       composite key first, falls back to the legacy
                       bare key only for true unmigrated records —
                       never a raw actionState[bareKey] lookup
                       (ANTI-REGRESSION IRON RULE). */
                    var auditEntry = window.FS.api.actions.lookupAction(actionState, item.folder, item.topic_id, item.actionIndex);
                    /* feat/editable-tasks-ui (Task 3 reconciliation) — done-ness
                       now lives in TWO places during the overlay-retirement
                       window: the authoritative action_items.status column
                       (a check-off via task-card.js now writes status:'done'
                       through PATCH, NOT the DynamoDB overlay) AND the legacy
                       overlay boolean (older days / the Timeline ActionItemRow
                       still on toggleAction). Drop on EITHER, or a task
                       completed via the new column path would resurface in this
                       rolling OPEN-items list (badge 'Done') on the next load,
                       since the overlay was never written for it. item.status is
                       today-adapter.js deriveStatus()'s label ('Done' only when
                       the column is done). */
                    var resolved = item.status === 'Done' || !!(auditEntry && auditEntry.checked);
                    if (resolved) return; /* done (column) or checked off (overlay) — drop */

                    item.date       = item.date || date;
                    /* topic_id restarts at 0 in every report, so
                       buildTodayFromReport's date-independent id
                       (folder + '_action_' + topic_id + '_' + index) is NOT
                       unique across dates: two DIFFERENT actions on
                       different dates that happen to share topic_id+index
                       collide. The old bucket-by-id "keep oldest" then
                       false-merged them, hiding ~1/3 of real leftover
                       items. Make the id date-unique. There is no
                       cross-date "same logical action" in this data model
                       (each report's actions are independent), so no dedupe
                       is warranted — every (date, topic, index) is its own
                       item. */
                    item.id         = item.date + '__' + item.id;
                    item.ageDays    = diffDaysISO(item.date, today);
                    item.noDeadline = !item.deadline;

                    bucket[item.id] = item;
                  });
                }

                (fanned || []).forEach(function (x) {
                  if (!x || !x.report) return;
                  var report = x.report;
                  if (report._notFound || report.available_users || report._accessDenied) return;

                  var actionState = byDate[x.date] || {};
                  var data = buildTodayFromReport(report, actionState, caller, x.date, siteSlugMap, x.folder, undefined, siteIdMap);

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
       audit state.

       feat/today-leftover-grouping — the collapsible Leftover section
       (render-time split, see TodayMiddleColumn) merges myTasks +
       teamTasks into one checkable list, so a checked-off id may live
       in either bucket. Filtering both by id keeps this a single call
       site for every checkable card on the page (My, Team-in-Leftover)
       — filtering a bucket that doesn't contain the id is a no-op. */
    /* fix/action-checkoff-sync (Bug 2) — generalized so both the
       existing id-based removal (removeMyTask below) and the new
       bus-driven (date, topic_id, actionIndex)-based removal share one
       setState call site, scanning both buckets exactly once. */
    function removeTasksMatching(predicate) {
      setState(function (s) {
        if (s.status !== 'ok' || !s.data) return s;
        var nextMy   = (s.data.myTasks   || []).filter(function (t) { return !predicate(t); });
        var nextTeam = (s.data.teamTasks || []).filter(function (t) { return !predicate(t); });
        return Object.assign({}, s, {
          data: Object.assign({}, s.data, { myTasks: nextMy, teamTasks: nextTeam }),
        });
      });
    }

    function removeMyTask(taskId) {
      removeTasksMatching(function (t) { return t.id === taskId; });
    }

    /* feat/editable-tasks-ui — optimistic in-place field patch after a
       successful PATCH /api/org/action-items/{id} (TodayRightDetail's
       editors below). Mirrors removeTasksMatching's shape (scan both
       buckets, one setState) but MERGES fields onto the matching item
       instead of dropping it, so both the task-detail panel AND the
       card in the middle-column list reflect the edit immediately —
       no full reload needed.

       F2 — re-bucketing on reassignment: a patch carrying `assignee`
       (commitTaskField only ever sets it from a truthy res.responsible,
       so its presence always means a real reassignment) now MOVES the
       item instead of just relabelling it in place:
         - new assignee === caller.name           → myTasks
         - new assignee !== caller.name AND the
           caller can see team tasks               → teamTasks
         - new assignee !== caller.name AND the
           caller can NOT see team tasks (a worker) → dropped entirely
           (it's no longer theirs, and workers never see anyone else's
           tasks — pushing it into teamTasks would wrongly surface it)
       The "can see team tasks" check mirrors today-adapter.js's own
       gate verbatim (`if (role === 'worker') teamTasks = [];`) rather
       than inventing a new one — `caller` here is the SAME object
       useTodayState(caller) was called with, i.e.
       window.AuthMock.currentUser, matching adapt()'s
       window.AuthMock.currentUser.role read.
       A patch with NO `assignee` key (priority/status/due only) keeps
       the plain in-place merge — no bucket move. */
    function patchTask(taskId, patch) {
      setState(function (s) {
        if (s.status !== 'ok' || !s.data) return s;
        var myList   = s.data.myTasks   || [];
        var teamList = s.data.teamTasks || [];

        var found = myList.filter(function (t) { return t.id === taskId; })[0]
                 || teamList.filter(function (t) { return t.id === taskId; })[0];
        if (!found) return s;

        var merged = Object.assign({}, found, patch);

        if (patch.assignee === undefined) {
          /* No assignee change — merge in place in whichever bucket
             already holds it, no move. */
          function applyPatch(list) {
            return list.map(function (t) { return t.id === taskId ? merged : t; });
          }
          return Object.assign({}, s, {
            data: Object.assign({}, s.data, {
              myTasks:   applyPatch(myList),
              teamTasks: applyPatch(teamList),
            }),
          });
        }

        var nextMy   = myList.filter(function (t) { return t.id !== taskId; });
        var nextTeam = teamList.filter(function (t) { return t.id !== taskId; });

        var isMine = !!(caller && caller.name) && merged.assignee === caller.name;
        /* Mirrors today-adapter.js adapt()'s exact worker gate:
           `if (role === 'worker') teamTasks = [];` */
        var canSeeTeamTasks = !(caller && caller.role === 'worker');

        if (isMine) {
          nextMy.push(merged);
        } else if (canSeeTeamTasks) {
          nextTeam.push(merged);
        }
        /* else: reassigned away from a worker caller — drop entirely. */

        return Object.assign({}, s, {
          data: Object.assign({}, s.data, { myTasks: nextMy, teamTasks: nextTeam }),
        });
      });
    }

    /* fix/action-checkoff-sync (Bug 2) — Today previously had ZERO
       actionsBus subscriptions, so a check-off made on /timeline (either
       panel) was invisible here until a full remount. Match on
       (date, topic_id, actionIndex) — the fields the bus payload
       actually carries (today-adapter.js stamps these onto every
       rolling item; see loadRollingOpenItems' keep() above) — rather
       than the composed `.id`, which the bus event doesn't carry.

       Ambiguity note (feat/user-dim-audit-key, Task 6 — RESOLVED): the
       bus payload now carries `user_folder` and rolling items carry
       `.folder` (today-adapter.js's ownerFolder, stamped in keep()
       above), so the folder check below disambiguates two different
       owners' unresolved topic 0 / action 0 on the same date — the
       date+topic+index match alone used to be ambiguous there. The
       folder check stays LENIENT when either side lacks a folder
       (legacy items/payloads), so it never regresses clearing genuine
       legacy Leftover items — see the plan's anti-regression note.

       Un-checking (checked === false) is intentionally left alone —
       re-adding a Leftover item needs its full adapter-shaped row data
       (title, assignee, deadline, …), which the bus event doesn't
       carry; a full remount restores it. */
    React.useEffect(function () {
      var bus = window.FS && window.FS.actionsBus;
      if (!bus) return undefined;
      return bus.subscribe(function (payload) {
        if (!payload || !payload.checked) return;
        removeTasksMatching(function (t) {
          if (t.date !== payload.date
              || t.topic_id !== payload.topic_id
              || t.actionIndex !== payload.action_index) return false;
          /* Both sides present and differ → not this owner, don't
             remove. Either side missing (legacy item/payload has no
             folder) → fall through to the looser date+topic+index
             match above — intentionally NOT made stricter than that. */
          if (payload.user_folder && t.folder && t.folder !== payload.user_folder) return false;
          return true;
        });
      });
    }, []);

    return { state: state, removeMyTask: removeMyTask, patchTask: patchTask };
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

  /* ---------- Shared detail-row builder (feat/related-quicklook-popup) -
     Extracted from TodayRightDetail's inline rows switch so BOTH the
     main right-detail panel and the Related quick-look popup render the
     identical row shape for a given item: 'task' -> Assignee/Due/Status/
     Priority (+ Open since / Due: None set when present), 'urgent'
     -> Severity/Triggered by/Detail, 'activity' -> Speaker/When/Source/
     Channel. Pure — no React, just [label, value] pairs. */
  function buildDetailRows(item) {
    var rows = [];
    if (item.kind === 'task') {
      rows = [
        ['Assignee', item.assignee],
        ['Due',      item.dueTime || 'None set'],
        ['Status',   item.status],
        ['Priority', item.priority || 'Medium'],
      ];
      /* §E — age + no-deadline read-only signals, mirrored here for the
         right-detail view (the card list already surfaces them). */
      if (item.ageDays != null) rows.push(['Open since', formatAgeLabel(item.ageDays)]);
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
    return rows;
  }

  /* Renders a [label, value][] rows array in the same label-column /
     value-column layout TodayRightDetail has always used. Shared by the
     main detail panel and the Related quick-look popup. */
  function renderDetailRows(rows) {
    return React.createElement('div', {
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
    );
  }

  /* =====================================================================
     feat/editable-tasks-ui — task-detail editors (priority/status/due/
     assignee), wired to PATCH /api/org/action-items/{id}.
     ---------------------------------------------------------------------
     Kept separate from buildDetailRows/renderDetailRows above on purpose:
     those two are SHARED between the main detail panel and the read-only
     Related quick-look popup (TodayRightDetail's previewRows) — editors
     must never leak into that popup. TodayRightDetail below builds its
     OWN task-row array (editable when permitted) and still hands it to
     the same renderDetailRows() shell for identical visual layout; the
     popup keeps calling buildDetailRows() untouched.
     ===================================================================== */

  var PRIORITY_OPTIONS = [
    { value: 'low',    label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high',   label: 'High' },
  ];
  var STATUS_OPTIONS = [
    { value: 'open',        label: 'Open' },
    { value: 'in_progress', label: 'In progress' },
    { value: 'blocked',     label: 'Blocked' },
    { value: 'done',        label: 'Done' },
  ];

  /* Reverse today-adapter.js deriveStatus()'s label formatting so the
     <select>'s controlled `value` (a raw enum) can be seeded from the
     item's already-derived display label — item.status/.priority only
     ever carry the LABEL, never the raw column value. Deterministic
     because deriveStatus's label rule is exactly
     `s === 'in_progress' ? 'In progress' : capitalize(s)`; keep in
     lockstep with that function if its label rule ever changes. */
  function statusLabelToValue(label) {
    if (!label) return 'open';
    if (label === 'In progress') return 'in_progress';
    return label.toLowerCase();
  }
  function priorityLabelToValue(label) {
    return (label || 'medium').toLowerCase();
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
    var ctx = { state: ts.state, removeMyTask: ts.removeMyTask, patchTask: ts.patchTask };
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

    /* feat/today-leftover-grouping — collapsible Leftover section expand
       state, declared unconditionally (before any early return below)
       per rules-of-hooks. Default collapsed — the substance triage
       happens on demand, not shoved in the user's face every visit. */
    var leftoverRef          = React.useState(false);
    var leftoverExpanded     = leftoverRef[0];
    var setLeftoverExpanded  = leftoverRef[1];

    /* Guards the "Resolve N" button against double-submit while the
       pooled toggleAction batch is in flight. */
    var resolvingRef         = React.useState(false);
    var bulkResolving        = resolvingRef[0];
    var setBulkResolving     = resolvingRef[1];

    var ctx      = React.useContext(TodayContext);
    var state    = ctx && ctx.state;
    var removeMy = ctx && ctx.removeMyTask;

    /* feat/leftover-batch-select (T1) / T4 DRY extraction — leftoverItems
       has to be known BEFORE the useMultiSelect() hook call just below
       (its `items` param drives Shift-range selection), and hook calls
       must stay unconditional per rules-of-hooks — so this is computed
       defensively here (state may not be 'ok' yet, e.g. still loading)
       rather than after the status early-returns further down, which is
       where the equivalent myRecent/teamRecent split used to live.
       Reused verbatim below once state.status === 'ok' is confirmed —
       not recomputed. */
    var earlyData = (state && state.status === 'ok') ? state.data : null;
    var myRecent = [], myLeftover = [], teamRecent = [], teamLeftover = [];
    if (earlyData) {
      (earlyData.myTasks || []).forEach(function (t) {
        (t.ageDays > LEFTOVER_THRESHOLD_DAYS ? myLeftover : myRecent).push(t);
      });
      (earlyData.teamTasks || []).forEach(function (t) {
        (t.ageDays > LEFTOVER_THRESHOLD_DAYS ? teamLeftover : teamRecent).push(t);
      });
    }
    var leftoverItems = myLeftover.concat(teamLeftover);

    /* F2 — leftoverIsMultiProject (and the flattened render order it
       drives) has to be known BEFORE useMultiSelect() below, same
       rules-of-hooks constraint as leftoverItems above. Moved up from
       further down the component (see the old comment near the
       state.status early-returns) since it only depends on leftoverItems,
       already computed just above. Leftover section computes its OWN
       multi-project flag off just the leftover items (reusing
       distinctProjects' pool-scanning shape) — it can legitimately
       differ from the page-level isMultiProject computed later (e.g.
       recent items are all one project but leftovers span three). */
    var leftoverProjects       = distinctProjects({ myTasks: leftoverItems, teamTasks: [], urgent: [], programmeTasks: [] });
    var leftoverIsMultiProject = leftoverProjects.length > 1;

    /* F2 — when multi-project, the middle column renders leftovers
       grouped by project (renderMaybeGrouped → groupByProject below),
       NOT in leftoverItems' raw myLeftover-then-teamLeftover concat
       order. Shift-range selection has to walk the SAME order the user
       sees, so flatten groupByProject's own output here and pass THAT
       to useMultiSelect — not leftoverItems — so a Shift+Click between
       two visually-adjacent cards can't reach into a different group. */
    /* #4 — the Leftover body now ALWAYS renders project-grouped (see
       renderMaybeGrouped), so Shift-range selection must walk the grouped
       order unconditionally — not just when multi-project. */
    var leftoverRenderItems = groupByProject(leftoverItems)
      .reduce(function (acc, g) { return acc.concat(g.rows); }, []);

    /* T4 — batchMode/anchor/Shift-Ctrl selection state + dispatch, now
       the ONE shared implementation (scripts/composites/multi-select-
       list.js) also consumed by /safety and /quality. Behavior is
       byte-identical to the T1 inline version it replaces: batchMode
       OFF (default) leaves each Leftover TaskCard's round selector on
       the single-resolve path (task-card.js startCheckOff, unchanged);
       ON, the SAME round selectors become multi-select toggles
       (multiSelect.onItemClick, wired below) and nothing resolves until
       "Resolve N" is pressed (bulkResolveLeftover(), unchanged, still
       the sole audited write). */
    var multiSelect = window.FieldSight.useMultiSelect({
      items: leftoverRenderItems,
      getId: function (t) { return t.id; },
    });

    if (!ctx) {
      console.warn('[TodayMiddleColumn] TodayContext missing — was the page Provider mounted?');
      return null;
    }

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
          }, 'Nothing unresolved in any report, and nothing due in the next ' + PROGRAMME_DEADLINE_DAYS + ' days.'),
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

    /* feat/today-leftover-grouping — Recent vs Leftover split, computed
       at render time from the full data.myTasks/data.teamTasks (the
       loader/state never splits — see loadRollingOpenItems), so
       removeMyTask (id-based, both buckets) and findItemById keep
       working unchanged no matter which group an item is currently
       rendered in. Recent = ageDays <= LEFTOVER_THRESHOLD_DAYS (existing
       My/Team treatment); Leftover = older, combined across My + Team
       into one collapsible, project-grouped list (ownership matters
       less for old-item triage). myIds is used only to paint the
       existing `isMine` accent border on leftover cards that originated
       from myTasks.

       T4 DRY extraction — myRecent/myLeftover/teamRecent/teamLeftover/
       leftoverItems themselves were already computed EARLIER in this
       component (before the useMultiSelect() hook call near the top —
       see that T4 comment), since useMultiSelect's `items` param must be
       known before any early return per rules-of-hooks. Reused verbatim
       here, not recomputed. */
    var myIds = {};
    (data.myTasks || []).forEach(function (t) { myIds[t.id] = true; });

    /* F2 — leftoverProjects/leftoverIsMultiProject moved up (see the T4
       useMultiSelect comment near the top of this component); reused
       verbatim here, not recomputed. */

    /* T4 — selectedLeftoverItems/selectedCount now come straight off
       multiSelect.selectedItems, which does the exact same
       selectedIds-intersect-items derivation the old inline code did
       here: a stale id — e.g. an item someone else resolved via the
       actionsBus subscription above, or one that aged back under the
       threshold on a refresh — silently drops out instead of over-
       counting or crashing a lookup. Only LEFTOVER items are ever
       selectable (leftoverRenderItems — leftoverItems, or its flattened
       project-grouped order when multi-project — is what was passed as
       `items` to useMultiSelect above), so this is still the single
       source of truth "N selected" reads from. */
    var selectedLeftoverItems = multiSelect.selectedItems;
    var selectedCount         = selectedLeftoverItems.length;

    /* Bulk resolve — pooled-toggle every selected item, EACH carrying
       ITS OWN date/folder/topic_id/actionIndex (leftover items span
       many dates and owners; there is no single "today" to check off
       against — same reasoning as the per-item checkable path above).
       user_folder: it.folder is the report OWNER's folder
       (feat/user-dim-audit-key, Task 6) — never the caller/currentUser,
       or the audit write lands on the legacy bare key and silently
       de-syncs from this owner's other entries. Partial failure is
       handled per-item: a failed toggle keeps that item selected (so
       the user can just hit Resolve again) and is reported via toast;
       successes are dropped from both the rendered list (removeMy,
       reusing the SAME optimistic-removal path the single check-off
       circle uses) and the selection. */
    function bulkResolveLeftover() {
      if (bulkResolving || selectedCount === 0) return;
      var items = selectedLeftoverItems;
      var api   = window.FS && window.FS.api;
      if (!api || !api.actions || !api.pooledAll) return;

      setBulkResolving(true);

      var thunks = items.map(function (it) {
        return function () {
          return api.actions.toggleAction({
            date:         it.date,
            topic_id:     it.topic_id,
            action_index: it.actionIndex,
            checked:      true,
            action_text:  it.title,
            user_folder:  it.folder,
          }).then(function () { return { ok: true, item: it }; })
            .catch(function (err) {
              console.error('[Today leftover] bulk resolve failed for', it.id, err);
              return { ok: false, item: it };
            });
        };
      });

      window.FS.api.pooledAll(thunks, 6).then(function (results) {
        var okIds = {};
        var okCount = 0, failCount = 0;
        (results || []).forEach(function (r) {
          if (r && r.ok) { okIds[r.item.id] = true; okCount++; }
          else { failCount++; }
        });

        Object.keys(okIds).forEach(function (id) { removeMy(id); });

        /* T4 — multiSelect.setSelectedIds is the hook's raw escape-hatch
           setter (beyond the 6-field spec), kept for exactly this case:
           a failed toggle must stay selected for retry, so this can't be
           a blanket multiSelect.clear() — same partial-survivor logic as
           the pre-extraction inline version. */
        multiSelect.setSelectedIds(function (prev) {
          var next = {};
          Object.keys(prev).forEach(function (id) { if (!okIds[id]) next[id] = prev[id]; });
          return next;
        });
        setBulkResolving(false);

        var toast = window.FS && window.FS.toast;
        if (!toast) return;
        if (failCount === 0) {
          toast.show({
            message: 'Resolved ' + okCount + ' item' + (okCount === 1 ? '' : 's'),
            tone:    'success',
          });
        } else if (okCount === 0) {
          toast.show({
            message: 'Could not resolve ' + failCount + ' item' + (failCount === 1 ? '' : 's') + ' — try again',
            tone:    'error',
          });
        } else {
          toast.show({
            message: 'Resolved ' + okCount + ', ' + failCount + ' failed — still selected, try again',
            tone:    'warning',
          });
        }
      });
    }

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
         /timeline view for TODAY. The &from=today flag tells
         TimelineMiddleColumn to render a "← Back to today" link in
         its header (Sprint 4.5). Only shown when TODAY itself has a
         report (effectiveDate === today) — feat/today-rolling-open-
         items dropped the "latest available" fallback, so there's no
         other date this could deep-link to.

         fix/today-cta-403 — deliberately NEVER passes an explicit
         user= param: this is always the CALLER'S OWN report
         (effectiveDate only comes from loadFor(today)'s own-identity
         fast path / admin fan-out above), and get_timeline_compat
         routes an explicit user= onto its single-user EXACT-MATCH
         path, which 403s unless the caller's session literally IS
         that folder ("You don't have access to <folder>'s daily
         report"). data.morningBrief.userFolder was a lossy fixture/
         folder round-trip, not a reliable identity — dropped. Same
         target shape as "Open timeline" (TimelineLink above), which
         never passed user= and has always worked. */
      effectiveDate ? React.createElement('button', {
        type:      'button',
        className: 'fs-today__view-report-cta',
        onClick:   function () {
          var qs = '?date=' + encodeURIComponent(effectiveDate) + '&from=today';
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
         (2) rolling unresolved action items from the FULL report span
             (loadRollingOpenItems above), split at render time into
             Recent (<= LEFTOVER_THRESHOLD_DAYS old, shown here) and
             Leftover (older, collapsible section further down).
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

      /* Sub-group 2 — rolling unresolved action items, RECENT only
         (ageDays <= LEFTOVER_THRESHOLD_DAYS; older items live in the
         collapsible Leftover section below). §C — per-item check-off:
         each task carries its OWN origin date (stamped by
         today-adapter.js / loadRollingOpenItems) since the list mixes
         dates — there is no single page-level effectiveDate to check
         off against any more. */
      myRecent.length > 0
        ? React.createElement(React.Fragment, null,
            React.createElement(SubsectionLabel, null,
              'Open items · ' + myRecent.length),
            renderMaybeGrouped(myRecent, isMultiProject, function (task) {
              return React.createElement(fs.TaskCard, {
                key:           task.id,
                task:          task,
                onSelect:      onSelect,
                isMine:        true,
                selected:      selectedId === task.id,
                checkable:     task.topic_id != null && task.actionIndex != null && !!task.date,
                date:          task.date,
                onCheckedOff:  onCheckedOff,
                /* #4 — no per-card project chip. Project is a HIGH-LEVEL
                   grouping only: multi-project renders project-headed
                   groups (renderMaybeGrouped) and single-project reads its
                   project from the global header selector (#5, now on every
                   page). Never a chip on the card itself. */
                site:          null,
                /* §E — age + no-deadline read-only signals. */
                ageLabel:      formatAgeLabel(task.ageDays),
                noDeadline:    !!task.noDeadline,
                /* §E-time — parent topic's time_range, when present. */
                timeRange:     task.timeRange,
              });
            }),
          )
        : null,

      teamRecent.length > 0 ? React.createElement(React.Fragment, null,
        React.createElement(SubsectionLabel, null,
          'Team · ' + teamRecent.length),
        renderMaybeGrouped(teamRecent, isMultiProject, function (task) {
          return React.createElement(fs.TaskCard, {
            key:        task.id,
            task:       task,
            onSelect:   onSelect,
            isMine:     false,
            selected:   selectedId === task.id,
            site:       null,   /* #4 — project is a group header, not a card chip */
            ageLabel:   formatAgeLabel(task.ageDays),
            noDeadline: !!task.noDeadline,
            timeRange:  task.timeRange,
          });
        }),
      ) : null,

      /* LEFTOVER — feat/today-leftover-grouping. Combined My + Team
         open items older than LEFTOVER_THRESHOLD_DAYS, collapsed by
         default behind a real <button> toggle (aria-expanded + rotating
         chevron, tokens-only, transition-based so the global
         prefers-reduced-motion transition-duration:0.01ms belt in
         tokens.css already neutralises it — same pattern as
         .fs-gantt-tree__chev / .fs-prog-kanban__group-chev). Grouped by
         project when expanded (groupByProject / renderMaybeGrouped,
         >1 leftover project → grouped, else flat). Neutral/warning tone
         — never safety-red / blocked-magenta (CLAUDE.md status-color
         rule) — leftover age is informational, not a blocked/overdue
         signal. */
      leftoverItems.length > 0
        ? React.createElement('div', { className: 'fs-today__leftover' },
            React.createElement('div', { className: 'fs-today__leftover-header' },
              React.createElement('button', {
                type:            'button',
                className:       'fs-today__leftover-toggle',
                onClick:         function () { setLeftoverExpanded(function (v) { return !v; }); },
                'aria-expanded': leftoverExpanded,
              },
                React.createElement('span', {
                  className: 'fs-today__leftover-chev'
                    + (leftoverExpanded ? ' fs-today__leftover-chev--open' : ''),
                  'aria-hidden': true,
                }, '▸'),
                React.createElement('span', { className: 'fs-today__leftover-label' },
                  'Leftover · ' + leftoverItems.length),
                React.createElement('span', { className: 'fs-today__leftover-hint' },
                  '(' + LEFTOVER_THRESHOLD_DAYS + '+ days, unresolved)'),
              ),
              /* feat/leftover-batch-select (T1), extracted T4 — OFF
                 (default): round selectors resolve single items. ON:
                 round selectors become multi-select toggles and the
                 bulk bar below is reachable (including "Select all"
                 from a clean, nothing-selected state). Sibling
                 <button>, not nested, since the expand toggle above is
                 already a <button>. Shared .fs-multi-select__toggle
                 classes (composites.css), same ones /safety + /quality
                 (T4) use for their own Multi-Select toggle. */
              React.createElement('button', {
                type:            'button',
                className:       'fs-multi-select__toggle'
                  + (multiSelect.batchMode ? ' fs-multi-select__toggle--active' : ''),
                onClick:         function () { multiSelect.setBatchMode(function (prev) { return !prev; }); },
                'aria-pressed':  multiSelect.batchMode,
              }, multiSelect.batchMode ? 'Batch Select: On' : 'Batch Select'),
            ),

            /* feat/leftover-batch-select (T1), extracted T4 — bulk
               action bar (shared MultiSelectBulkBar composite), shown
               whenever batchMode is on (not gated on selectedCount > 0
               any more, so "Select all" is reachable immediately after
               turning batch mode on). Lives in the section "header
               area" (between the toggle and the collapsible body) so
               it's visible whether or not the body itself is expanded
               — selection intentionally survives a collapse (the
               underlying selection state lives in the useMultiSelect
               hook now, still not tied to leftoverExpanded), so
               Resolve N stays reachable without re-expanding. */
            multiSelect.batchMode
              ? React.createElement(fs.MultiSelectBulkBar, {
                  count:   selectedCount,
                  actions: [
                    { key: 'select-all', label: 'Select all', onClick: multiSelect.selectAll, disabled: bulkResolving },
                    { key: 'resolve', primary: true, onClick: bulkResolveLeftover,
                      disabled: bulkResolving || selectedCount === 0,
                      label: bulkResolving ? 'Resolving…' : 'Resolve ' + selectedCount },
                    { key: 'clear', label: 'Clear', onClick: multiSelect.clear, disabled: bulkResolving },
                  ],
                })
              : null,

            leftoverExpanded
              ? React.createElement('div', { className: 'fs-today__leftover-body' },
                  renderMaybeGrouped(leftoverItems, leftoverIsMultiProject, function (task) {
                    return React.createElement(fs.TaskCard, {
                      key:            task.id,
                      task:           task,
                      onSelect:       onSelect,
                      isMine:         !!myIds[task.id],
                      selected:       selectedId === task.id,
                      checkable:      task.topic_id != null && task.actionIndex != null && !!task.date,
                      date:           task.date,
                      onCheckedOff:   onCheckedOff,
                      site:           null,   /* #4 — leftover already groups by project; no card chip */
                      ageLabel:       formatAgeLabel(task.ageDays),
                      noDeadline:     !!task.noDeadline,
                      timeRange:      task.timeRange,
                      /* feat/leftover-batch-select (T1), extracted T4 —
                         only Leftover cards pass these; Recent/
                         programme/timeline TaskCard call sites omit
                         them, so their round check button keeps the
                         original single-resolve behavior (checkable
                         without batchMode/onBatchToggle =>
                         startCheckOff, unchanged). multiSelect.onItemClick
                         is the shared hook's dispatcher — same
                         Shift/Ctrl/plain semantics the old inline
                         onBatchToggle had. */
                      batchMode:      multiSelect.batchMode,
                      batchSelected:  !!multiSelect.selectedIds[task.id],
                      onBatchToggle:  multiSelect.onItemClick,
                    });
                  }),
                )
              : null,
          )
        : null,

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
    var Select   = fs.Select;
    var Input    = fs.Input;

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
        /* feat/user-dim-audit-key (Task 6) — report OWNER's folder
           (item.folder, stamped by today-adapter.js), never the
           caller/currentUser. */
        user_folder:  item.folder,
      }).then(function () {
        if (ctx && ctx.removeMyTask) ctx.removeMyTask(item.id);
        if (props.onClose) props.onClose();
      }).catch(function (err) {
        console.error('[Today right] markComplete failed', err);
      });
    }

    /* feat/editable-tasks-ui — priority/status/due/assignee editors.
       Backend is the real authority gate (400/403/404 on the PATCH); this
       FS.can() check is UX only — hides controls a caller's role could
       never actually use, per the existing gated-control convention
       (safety.js/quality.js/team.js/sites.js all check window.FS.can(
       caller, window.FS.P(resource, action)) the same way — there is no
       literal `FS.canDo` anywhere in this codebase). Two separate
       permissions because the role model splits them: e.g. foreman has
       task:assign:crew but not task:edit (no task:manage), so it can
       reassign but not touch priority/status/due. */
    var caller        = (window.AuthMock && window.AuthMock.currentUser) || {};
    var canEditTask   = !!(window.FS && window.FS.can && window.FS.P
                        && window.FS.can(caller, window.FS.P('task', 'edit')));
    var canAssignTask = !!(window.FS && window.FS.can && window.FS.P
                        && window.FS.can(caller, window.FS.P('task', 'assign')));

    /* F1 — the caller's OWN task (they are the current assignee). Mirrors the
       mine-vs-team key today-adapter.js uses (task.assignee === caller.name).
       Backend already authorises the assignee to edit their own item, so the
       UI must not hide the editors on it — any user can correct their own
       task even without a task:edit/assign role permission. Must be computed
       before fieldsEditable/assigneeEditable/rosterSiteId below, all of
       which widen on it. */
    var isOwnTask = item.kind === 'task' && item.assignee && item.assignee !== '—'
                    && item.assignee === (caller && caller.name);

    /* Optimistic per-field overrides (task-card.js's startCheckOff is the
       precedent for this pattern elsewhere in the file: flip locally on
       change, revert on failure) — keyed by the SAME field names the
       PATCH body uses (priority/status/deadline/responsible), holding RAW
       values (enum/ISO), never the derived display label. Reset whenever
       the selected task changes so a previous item's in-flight edit can
       never bleed into the next one. */
    var draftRef = React.useState({});
    var draft    = draftRef[0];
    var setDraft = draftRef[1];
    React.useEffect(function () { setDraft({}); }, [item.id]);

    /* Assignee roster — FS.api.org.getSiteMembers(task.siteId), the SAME
       Aurora call getSiteUsers()/the Sites/Team pages already use (see
       org.js doc). Only fetched when the picker could actually be shown
       (assign-permitted + a resolvable site) — never fired for a plain
       read-only view. task.siteId is threaded from today-adapter.js's
       ctx.siteIdByName (today.js's getOrgSiteIdMap()); a lookup miss
       (siteId: null) is the documented degrade-to-disabled path below,
       same as an empty/errored roster. */
    var rosterRef = React.useState({ status: 'idle', users: [] });
    var roster    = rosterRef[0];
    var setRoster = rosterRef[1];
    var rosterSiteId = (item.kind === 'task' && (canAssignTask || isOwnTask)) ? item.siteId : null;
    React.useEffect(function () {
      if (!rosterSiteId) { setRoster({ status: 'idle', users: [] }); return undefined; }
      var cancelled = false;
      setRoster({ status: 'loading', users: [] });
      var org = window.FS && window.FS.api && window.FS.api.org;
      if (!org || !org.getSiteMembers) { setRoster({ status: 'error', users: [] }); return undefined; }
      org.getSiteMembers(rosterSiteId).then(function (res) {
        if (cancelled) return;
        if (!res || res._accessDenied || res._notFound) { setRoster({ status: 'error', users: [] }); return; }
        setRoster({ status: 'ok', users: (res.users || []).filter(function (u) { return u && u.name; }) });
      }).catch(function () {
        if (!cancelled) setRoster({ status: 'error', users: [] });
      });
      return function () { cancelled = true; };
    }, [rosterSiteId]);

    /* One generic commit path for all 4 fields — PATCH
       /api/org/action-items/{id}, then either fold the FULL updated row
       the backend returns back into the shared TodayContext snapshot
       (ctx.patchTask — updates the list card AND this panel at once) or,
       on _accessDenied/_notFound/thrown error, drop the optimistic
       override (the control's controlled `value` falls back to the
       item's real value — an automatic "revert", nothing else to undo)
       and toast, exactly like actions.js's own real-backend error path. */
    function commitTaskField(fieldKey, value) {
      if (!item.actionItemId) return;
      var api = window.FS && window.FS.api && window.FS.api.actions;
      if (!api || !api.updateAction) return;
      var patch = {};
      patch[fieldKey] = value;
      setDraft(function (d) {
        var next = Object.assign({}, d);
        next[fieldKey] = value;
        return next;
      });
      function clearDraft() {
        setDraft(function (d) {
          var next = Object.assign({}, d);
          delete next[fieldKey];
          return next;
        });
      }
      api.updateAction(item.actionItemId, patch).then(function (res) {
        if (!res || res._accessDenied || res._notFound) {
          clearDraft();
          var toast = window.FS && window.FS.toast;
          if (toast) {
            toast.show({
              message:  (res && res.error) || 'Could not update task',
              tone:     'error',
              duration: 5000,
            });
          }
          return;
        }
        /* Re-derive display fields from the response via the SAME
           helpers today-adapter.js uses during a full adapt() — never
           hand-roll the label/tone/dueTime logic a second time here. */
        var patchOut = {};
        if (res.priority) {
          patchOut.priority = res.priority.charAt(0).toUpperCase() + res.priority.slice(1);
        }
        if (res.status && window.FS.api.deriveStatus) {
          var derived = window.FS.api.deriveStatus(res.status, false);
          patchOut.status     = derived.status;
          patchOut.statusTone = derived.statusTone;
        }
        if (res.deadline !== undefined) {
          patchOut.deadline = res.deadline || null;
          patchOut.dueTime  = window.FS.api.resolveDeadline
            ? window.FS.api.resolveDeadline(res.deadline, item.date).display
            : item.dueTime;
        }
        if (res.responsible) patchOut.assignee = res.responsible;
        if (ctx && ctx.patchTask) ctx.patchTask(item.id, patchOut);
        clearDraft();
      }).catch(function (err) {
        clearDraft();
        var toast = window.FS && window.FS.toast;
        if (toast) {
          toast.show({
            message:  'Could not update task' + ((err && err.message) ? ': ' + err.message : ''),
            tone:     'error',
            duration: 5000,
          });
        }
      });
    }

    var fieldsEditable   = item.kind === 'task' && (canEditTask || isOwnTask) && !!item.actionItemId;
    var assigneeEditable = item.kind === 'task' && (canAssignTask || isOwnTask) && !!item.actionItemId
                          && !!item.siteId && roster.status === 'ok' && roster.users.length > 0;

    var rows;
    if (item.kind === 'task') {
      var priorityValue = draft.priority !== undefined ? draft.priority : priorityLabelToValue(item.priority);
      var statusValue   = draft.status   !== undefined ? draft.status   : statusLabelToValue(item.status);
      var dueValue      = draft.deadline !== undefined ? draft.deadline : (item.deadline || '');
      var currentAssignee = (item.assignee && item.assignee !== '—') ? item.assignee : '';
      var assigneeValue = draft.responsible !== undefined ? draft.responsible : currentAssignee;

      var priorityCell = fieldsEditable ? React.createElement(Select, {
        size: 'sm', fullWidth: true, value: priorityValue, options: PRIORITY_OPTIONS,
        onChange: function (e) { commitTaskField('priority', e.target.value); },
      }) : (item.priority || 'Medium');

      var statusCell = fieldsEditable ? React.createElement(Select, {
        size: 'sm', fullWidth: true, value: statusValue, options: STATUS_OPTIONS,
        onChange: function (e) { commitTaskField('status', e.target.value); },
      }) : item.status;

      /* fix/english-date-field — native <input type="date"> replaced with
         DateField (in-page English, theme-aware picker; the native
         calendar popup renders in the OS locale and can't be forced to
         English via HTML/CSS — see date-field.js header doc). DateField's
         onChange already hands back 'YYYY-MM-DD' | null directly — no
         Date() parse either direction, so there's nothing here to get
         NZDT-wrong. */
      var dueCell = fieldsEditable ? React.createElement(fs.DateField, {
        size: 'sm', value: dueValue || null,
        onChange: function (iso) { commitTaskField('deadline', iso || null); },
      }) : (item.dueTime || 'None set');

      var assigneeCell = assigneeEditable ? React.createElement(Select, {
        size: 'sm', fullWidth: true, value: assigneeValue,
        placeholder: assigneeValue ? undefined : 'Select a member',
        options: roster.users.map(function (u) { return { value: u.name, label: u.name }; }),
        onChange: function (e) { commitTaskField('responsible', e.target.value); },
      }) : item.assignee;

      rows = [
        ['Assignee', assigneeCell],
        ['Due',      dueCell],
      ];
      /* concise-cards — the specific clock time (parent topic's
         time_range, e.g. '14:09 – 14:09') no longer renders on the Today
         card (task-card.js); this is now its only home. item IS the same
         task object today-adapter.js stamped .timeRange onto, so no extra
         plumbing is needed. Optional; omitted/falsy → row omitted. */
      if (item.timeRange) rows.push(['Time', item.timeRange]);
      rows.push(['Status',   statusCell]);
      rows.push(['Priority', priorityCell]);
      if (item.ageDays != null) rows.push(['Open since', formatAgeLabel(item.ageDays)]);
    } else {
      rows = buildDetailRows(item);
    }

    var related  = getRelated(data, item);
    var timeline = getTimeline(item);

    /* feat/related-quicklook-popup — id of the Related card currently
       previewed in the quick-look popup; null = closed. Opening/closing
       this is a purely local, inline overlay — it never touches
       AppShell's selectedItem or the URL, so it can never be confused
       with navigation. Only one id at a time, so only one popup can be
       open. Declared here (not hoisted above the `!sel` early return
       above) to match this component's existing hook placement — `ctx`
       (React.useContext) just above is already past that early return. */
    var previewRef   = React.useState(null);
    var previewId    = previewRef[0];
    var setPreviewId = previewRef[1];

    function openRelatedPreview(id) { setPreviewId(id); }
    function closeRelatedPreview()  { setPreviewId(null); }

    /* Look up the previewed item's FULL data the same way the main panel
       itself does — findItemById against the same TodayContext snapshot
       `related` was built from — so the popup renders the identical row
       shape (via buildDetailRows/renderDetailRows) as the main detail.
       Falls back to the Related card's own {title, subtitle} if the item
       has since dropped out of every pool (e.g. checked off elsewhere
       while the popup was closed) rather than rendering a blank popup. */
    var previewCard = previewId
      ? (related.filter(function (r) { return r.id === previewId; })[0] || null)
      : null;
    var previewItem = previewId ? findItemById(data, previewId) : null;
    var previewRows = previewItem ? buildDetailRows(previewItem) : [];
    var previewTitle = (previewItem && (previewItem.title || previewItem.snippet))
      || (previewCard && previewCard.title)
      || '(item)';

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
            /* feat/editable-tasks-ui — full text, no clamp: the card title
               (task-card.js .fs-task-card__title) is the 1-line scannable
               summary; this detail panel is the full-text home. */
            wordBreak: 'break-word',
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

      renderDetailRows(rows),

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
          /* feat/related-quicklook-popup — Related cards are now
             clickable: onClick opens an inline quick-look popup showing
             that item's full detail (findItemById lookup above), NOT a
             navigation — AppShell's selectedItem and the URL are both
             untouched. Passing onClick makes Card render a real
             <button> (see components/card.js), which picks up
             .fs-card--clickable (cursor/hover/:focus-visible, reduced-
             motion aware) and native Enter/Space activation for free —
             no separate role/tabIndex/keydown wiring needed. */
          related.map(function (r, i) {
            return React.createElement(Card, {
              key: i, padding: 'sm', variant: 'ghost',
              onClick: function () { openRelatedPreview(r.id); },
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

      /* feat/related-quicklook-popup — reuses the existing ModalOverlay
         composite (title + body + onClose): ESC and backdrop-click both
         close it, focus moves into the panel on open and returns to the
         trigger card on close, it's portaled to document.body (so it
         isn't clipped by this panel's own overflow:auto), and its CSS
         already has a prefers-reduced-motion override (composites.css
         ~4689). Always mounted with `open` toggling visibility, so the
         ESC/backdrop wiring stays live without a remount on every click.
         Purely additive: never reads or writes AppShell's selectedItem,
         never navigates. */
      fs.ModalOverlay ? React.createElement(fs.ModalOverlay, {
        open:    !!previewId,
        onClose: closeRelatedPreview,
        title:   previewTitle,
        size:    'sm',
      },
        (previewItem && previewRows.length > 0)
          ? renderDetailRows(previewRows)
          : React.createElement('div', {
              style: { fontSize: '13px', color: 'var(--text-tertiary)' },
            }, (previewCard && previewCard.subtitle) || 'Details unavailable.'),
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
