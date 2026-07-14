/* ==========================================================================
   FieldSight Programme Page — Sprint 4.4 (Programme MVP)
   --------------------------------------------------------------------------
   /programme — read-only Gantt view + Jira-style TO-DO toggle +
   linked-action navigation. The single biggest sub-sprint of
   Sprint 4 — see the Sprint 4 plan in /root/.claude/plans/ for full
   scope and the deliberately-deferred Sprint 5 follow-ups (imports,
   native edit, cascade engine).

   Middle column:
     • Header: programme name + range + view toggle (Gantt / TO-DO)
     • Tier toggle (Day / Week / Month) when on Gantt
     • Gantt: left WBS tree (sticky) + scrollable timeline
     • Board (Sprint 4.8): ProgrammeKanbanBoard — 4-column status
       grid (Not started / In progress / Blocked or Delayed / Done)
       with rows = WBS group; replaces the older bucketed
       This-Week / Next-Week / Later list from 4.4

   Right detail:
     • Selected task: WBS, name, status, dates, baseline, progress,
       assignees, resource pool, dependencies, tags
     • "Linked actions" section — clickable rows that navigate to
       /timeline?date=…&user=…

   Architecture:
     • ProgrammeProvider owns programme + selection state + view +
       tier + collapsed-groups set
     • Worker rule applied in scripts/api/programme.js
     • Critical-path rendering = task is in programme.critical_path[]

   Registers as window.FieldSight.PAGES['/programme']
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var TIER_PIXELS = { day: 24, week: 6, month: 2 };

  /* ---------- Helpers --------------------------------------------------- */

  /* Sprint 5.2 — auto-mint a task_id that's never been used.
     Scans numeric suffixes so deletes never cause id reuse. */
  function mintTaskId(leaves) {
    var max = 0;
    leaves.forEach(function (t) {
      var m = t.task_id && t.task_id.match(/^T-(\d+)$/);
      if (m) {
        var n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    });
    var next = String(max + 1);
    while (next.length < 3) next = '0' + next;
    return 'T-' + next;
  }

  /* Sprint 5.2 — auto-mint a WBS code as "{parentPrefix}.{N+1}"
     where N = max existing fractional suffix among the parent's children. */
  function mintWbs(parent, leaves) {
    var prefix = parent.wbs.split('.')[0];
    var siblings = leaves.filter(function (t) { return t.parent_id === parent.task_id; });
    var maxSuffix = 0;
    siblings.forEach(function (t) {
      var parts = t.wbs ? t.wbs.split('.') : [];
      if (parts.length >= 2) {
        var n = parseInt(parts[1], 10);
        if (!isNaN(n) && n > maxSuffix) maxSuffix = n;
      }
    });
    return prefix + '.' + (maxSuffix + 1);
  }

  function fmtDate(yyyymmdd) {
    if (!yyyymmdd) return '';
    var p = String(yyyymmdd).split('-').map(Number);
    if (p.length !== 3) return yyyymmdd;
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return p[2] + ' ' + months[p[1] - 1] + ' ' + p[0];
  }

  function diffDays(a, b) {
    var ms = new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime();
    return Math.round(ms / 86400000);
  }

  /* F4 (UI batch 2026-07-08) — derive a programme-level date range from
     its leaves, for the moments (fresh import, bootstrap-from-empty)
     where there's no persisted top-level start_date/end_date yet to
     trust. Falls back to the given bounds when there are no leaves. */
  function deriveDateRange(leaves, fallbackStart, fallbackEnd) {
    if (!leaves || !leaves.length) {
      return { start_date: fallbackStart, end_date: fallbackEnd };
    }
    var start = leaves.reduce(function (m, t) { return (!m || t.start < m) ? t.start : m; }, null);
    var end   = leaves.reduce(function (m, t) { return (!m || t.end   > m) ? t.end   : m; }, null);
    return { start_date: start, end_date: end };
  }

  /* F4 — the page's OWN project picker (Option B), sourced from
     org.getOrgSites() — the ORG SITE UUID space, never the report-side
     slug. Reused for both the full-screen "select a project" prompt and
     the compact in-header picker once a programme is loaded. */
  function renderSitePicker(ctx, extraStyle) {
    var sites = (ctx.orgSitesState && ctx.orgSitesState.sites) || [];
    if (!sites.length) return null;
    return React.createElement('select', {
      className:    'fs-settings__select',
      style:        Object.assign({ maxWidth: '220px' }, extraStyle || {}),
      value:        ctx.orgSiteId || '',
      onChange:     function (e) { ctx.setOrgSiteId(e.target.value || null); },
      'aria-label': 'Programme project',
    },
      [React.createElement('option', { key: '__none', value: '' }, '— Select a project —')]
        .concat(sites.map(function (s) {
          return React.createElement('option', { key: s.site_id, value: s.site_id }, s.name);
        })),
    );
  }

  /* Roll up child date range + progress for a group row. Used to
     render summary bars in the Gantt without backend support. */
  function rollupGroup(parent, leaves) {
    var children = leaves.filter(function (t) { return t.parent_id === parent.task_id; });
    if (!children.length) return { start: null, end: null, progress: 0 };
    var start = children.reduce(function (m, t) { return !m || t.start < m ? t.start : m; }, null);
    var end   = children.reduce(function (m, t) { return !m || t.end   > m ? t.end   : m; }, null);
    var totalDays = children.reduce(function (s, t) { return s + (t.duration_days || 0); }, 0);
    var doneDays  = children.reduce(function (s, t) {
      return s + ((t.duration_days || 0) * (t.progress_pct || 0) / 100);
    }, 0);
    var progress = totalDays > 0 ? Math.round(doneDays / totalDays * 100) : 0;
    return { start: start, end: end, progress: progress };
  }

  /* ---------- ProgrammeContext ---------------------------------------- */

  var ProgrammeContext = React.createContext(null);

  function ProgrammeProvider(props) {
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
    var depKey = (caller.name || '') + '|' + (caller.role || '') + '|' + (caller.isAdmin ? 'admin' : '');

    var refState  = React.useState({ status: 'loading' });
    var state     = refState[0];
    var setState  = refState[1];

    var retryRef   = React.useState(0);
    var retryCount = retryRef[0];
    var setRetry   = retryRef[1];

    /* Sprint 8.4.2 — default to Board on mobile (Gantt needs width to breathe).
       We check once at mount; user can still switch to Gantt via the toggle. */
    var isMobileInit = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(max-width: 47.9375rem)').matches
      : false;
    var refView   = React.useState(isMobileInit ? 'todo' : 'gantt');
    var view      = refView[0];
    var setView   = refView[1];

    var refTier   = React.useState('day');
    var tier      = refTier[0];
    var setTier   = refTier[1];

    /* Sprint 8.3.1 — "Show float" toggle */
    var refShowFloat = React.useState(false);
    var showFloat    = refShowFloat[0];
    var setShowFloat = refShowFloat[1];

    /* Sprint 8.3.2 — Over-allocation dismissal flag (per session) */
    var refOverAllocDismissed = React.useState(false);
    var overAllocDismissed    = refOverAllocDismissed[0];
    var setOverAllocDismissed = refOverAllocDismissed[1];

    /* Sprint 8.3.3 — "Compare baseline" toggle + loaded baseline data */
    var refShowBaseline  = React.useState(false);
    var showBaseline     = refShowBaseline[0];
    var setShowBaseline  = refShowBaseline[1];

    var refBaselineData  = React.useState(null); /* { saved_at, tasks[] } | null */
    var baselineData     = refBaselineData[0];
    var setBaselineData  = refBaselineData[1];

    /* Set of task_ids whose group is collapsed (children hidden). */
    var refCollapsed = React.useState(new Set());
    var collapsed    = refCollapsed[0];
    var setCollapsed = refCollapsed[1];

    /* ---- F4 (UI batch 2026-07-08) — org site resolution, Option B -----
       The org-api /programme endpoint is keyed by the ORG SITE UUID
       (org.js getOrgSites()'s site_id, i.e. _toPageSite's s.id) — a
       different id space from FS.siteContext, which holds the
       report-side site slug from api/sites.js. scripts/pages/sites.js
       (~line 575) documents that the slug↔UUID bridge is unreliable and
       was deliberately parked rather than "fixed" with a name match.
       So this page owns its OWN site picker sourced straight from
       org.getOrgSites() (source of truth for the UUID space) — the
       globally active site is only ever used as a best-effort
       PRE-SELECTION hint (matched by name), never as the identity
       passed to the backend. This is the one and only place an
       orgSiteId gets minted for the page; every getProgramme/
       saveProgramme call below uses it, never a slug. */
    var refOrgSites = React.useState({ status: 'loading', sites: [] });
    var orgSitesState    = refOrgSites[0];
    var setOrgSitesState = refOrgSites[1];

    var refOrgSiteId    = React.useState(null);
    var orgSiteId       = refOrgSiteId[0];
    var setOrgSiteIdRaw = refOrgSiteId[1];

    var refOrgSitesRetry = React.useState(0);
    var orgSitesRetry    = refOrgSitesRetry[0];
    var setOrgSitesRetry = refOrgSitesRetry[1];

    var didPreselect = React.useRef(false);

    /* Sprint 11 (Task 6) — the report-side sites list (getSites()) is
       already fetched below for the one-time preselect; stash it in a
       ref (not state — it doesn't need to trigger a re-render on its
       own) so resolveReportSlug() can reuse it for every subsequent
       lookup, not just the first mount. */
    var reportSitesRef = React.useRef([]);

    /* Public setter — a manual pick always outranks the auto-match hint,
       even if it hasn't run yet. */
    function setOrgSiteId(id) {
      didPreselect.current = true;
      setOrgSiteIdRaw(id || null);
    }

    React.useEffect(function () {
      var cancelled = false;
      setOrgSitesState({ status: 'loading', sites: [] });
      Promise.all([
        window.FS.api.org.getOrgSites(),
        window.FS.api.sites.getSites().catch(function () { return { sites: [] }; }),
      ]).then(function (res) {
        if (cancelled) return;
        var orgRes    = res[0];
        var reportRes = res[1];
        if (orgRes && orgRes._accessDenied) {
          setOrgSitesState({ status: 'access_denied', sites: [], message: orgRes.error });
          return;
        }
        var orgSites = (orgRes && orgRes.sites) || [];
        setOrgSitesState({ status: 'ok', sites: orgSites });
        reportSitesRef.current = (reportRes && reportRes.sites) || [];

        if (!didPreselect.current) {
          didPreselect.current = true;
          var activeSlug   = window.FS.siteContext ? window.FS.siteContext.get() : null;
          var reportSites  = reportSitesRef.current;
          var activeReportSite = activeSlug
            ? reportSites.filter(function (s) { return s.site_id === activeSlug; })[0]
            : null;
          var match = activeReportSite
            ? orgSites.filter(function (s) { return s.name === activeReportSite.name; })[0]
            : null;
          /* Sole-site deployments don't need a name match to be sure. */
          if (!match && orgSites.length === 1) match = orgSites[0];
          if (match) setOrgSiteIdRaw(match.site_id);
        }
      }).catch(function () {
        if (cancelled) return;
        setOrgSitesState({ status: 'error', sites: [] });
      });
      return function () { cancelled = true; };
    }, [depKey, orgSitesRetry]);

    /* Sprint 11 (Task 6) — best-effort ORG SITE UUID -> report-side site
       slug bridge, needed ONLY for SuggestionReview's evidence deep-link
       (/timeline?...&site=<slug>). There is no reliable UUID<->slug
       bridge anywhere in this codebase today — scripts/pages/sites.js
       (~line 575) documents the same gap as deliberately parked ("don't
       'fix' this without a folder/UUID bridge like org.js's
       folderName()"). This reuses the identical name-match heuristic
       the org-site preselect above already relies on as a
       best-effort hint, so it inherits the same failure mode: silent
       null on multi-site orgs whose names don't line up 1:1 between the
       org and report site lists. Callers must treat a null return as
       "omit &site=", never as "site is global" — see suggestion-review
       .js's openEvidence(). */
    function resolveReportSlug(uuid) {
      if (!uuid) return null;
      var orgSite = (orgSitesState.sites || []).filter(function (s) { return s.site_id === uuid; })[0];
      if (!orgSite) return null;
      var reportSite = (reportSitesRef.current || [])
        .filter(function (s) { return s.name === orgSite.name; })[0];
      return reportSite ? reportSite.site_id : null;
    }

    /* Sprint 11 (Task 6) — programme suggestion review queue. Lives on
       ProgrammeProvider (not inside SuggestionReview itself) so the
       toolbar's pending-count badge and the right-pane review list read
       one shared fetch instead of duplicating the network call. Only
       runs when the org backend is actually live — the backend for this
       feature has no useMocks=false-but-not-live middle state to design
       for (F4's "Don't ship UI write actions before the matching
       backend exists" lesson: the block itself is also live-gated at
       render time in ProgrammeMiddleColumn/ProgrammeRightDetail below). */
    function orgApiLive() {
      return !!(window.FS && window.FS.api && !window.FS.api.useMocks && window.FS.api.orgBaseUrl);
    }

    var refSuggestions = React.useState({ status: 'idle', rows: [] });
    var suggestionsState    = refSuggestions[0];
    var setSuggestionsState = refSuggestions[1];

    var refSuggestionsRetry = React.useState(0);
    var suggestionsRetry    = refSuggestionsRetry[0];
    var setSuggestionsRetry = refSuggestionsRetry[1];

    React.useEffect(function () {
      if (!orgApiLive() || !orgSiteId) {
        setSuggestionsState({ status: 'idle', rows: [] });
        return undefined;
      }
      var cancelled = false;
      setSuggestionsState(function (prev) { return { status: 'loading', rows: prev.rows }; });
      window.FS.api.programme.getSuggestions({ site: orgSiteId, state: 'pending' }).then(function (res) {
        if (cancelled) return;
        if (res && (res._accessDenied || res._notFound)) {
          setSuggestionsState({ status: 'error', rows: [] });
          return;
        }
        setSuggestionsState({ status: 'ok', rows: (res && res.suggestions) || [] });
      }).catch(function () {
        if (cancelled) return;
        setSuggestionsState({ status: 'error', rows: [] });
      });
      return function () { cancelled = true; };
    }, [depKey, orgSiteId, suggestionsRetry]);

    /* Optimistic local removal after a successful confirm/reject —
       avoids a full refetch round trip for both the badge count and the
       review list. */
    function removeSuggestion(id) {
      setSuggestionsState(function (prev) {
        return Object.assign({}, prev, {
          rows: (prev.rows || []).filter(function (r) { return r.id !== id; }),
        });
      });
    }

    /* ---- Dirty / save state (Sprint F4 — explicit Save, not autosave) */
    var refDirty  = React.useState(false);
    var dirty     = refDirty[0];
    var setDirty  = refDirty[1];
    var refSaving = React.useState(false);
    var saving    = refSaving[0];
    var setSaving = refSaving[1];

    React.useEffect(function () {
      if (!orgSiteId) {
        setState({ status: 'no_site' });
        return undefined;
      }
      var cancelled = false;
      setState({ status: 'loading' });
      setDirty(false);

      window.FS.api.programme.getProgramme(orgSiteId).then(function (res) {
        if (cancelled) return;
        if (res && res._accessDenied) {
          setState({ status: 'access_denied', message: res.error });
          return;
        }
        if (res && res._notFound) {
          setState({
            status: 'error',
            error:  { message: 'Programme endpoint unavailable.', retryable: true },
            retry:  function () { setRetry(function (n) { return n + 1; }); },
          });
          return;
        }
        var doc = res && res.programme;
        if (!doc) {
          /* Contract: { programme: null } = no programme uploaded for
             this site yet. Distinct from _notFound (endpoint broken). */
          setState({ status: 'empty' });
          return;
        }
        var leaves  = (doc.leaves  || []).slice();
        var parents = (doc.parents || []).slice();
        /* Sprint 5.6 — recompute the critical path from the dependency
           graph on every load; the engine result is the authority, not
           whatever the doc happens to carry. */
        var sched = window.FieldSight && window.FieldSight.programmeSchedule;
        var critIds = sched ? sched.computeCriticalPath(leaves, doc.start_date) : [];
        setState({
          status:   'ok',
          programme: {
            site_id:      orgSiteId,
            programme_id: orgSiteId,   /* 1:1 per site now — also keys baseline localStorage below */
            name:         doc.name || 'Programme',
            start_date:   doc.start_date,
            end_date:     doc.end_date,
            updated_at:   doc.updated_at || null,
          },
          leaves:   leaves,
          parents:  parents,
          critical: new Set(critIds),
          today:    window.FS.api.todayNZDT(),
        });
        /* Sprint 8.3.3 — restore saved baseline from localStorage */
        var saved = window.FS.api.programme.getBaseline(orgSiteId);
        if (saved) setBaselineData(saved);
      }).catch(function (err) {
        if (cancelled) return;
        setState({ status: 'error', error: { code: (err && err.status) || 0, message: (err && err.message) || 'Could not load programme', retryable: true }, retry: function () { setRetry(function (n) { return n + 1; }); } });
      });

      return function () { cancelled = true; };
    }, [depKey, retryCount, orgSiteId]);

    function toggleGroup(groupId) {
      setCollapsed(function (prev) {
        var next = new Set(prev);
        if (next.has(groupId)) next.delete(groupId);
        else next.add(groupId);
        return next;
      });
    }

    /* Sprint 4.9 — drag in Gantt commits through this. Mock-only;
       the real backend equivalent would be PATCH /api/programmes/
       :id/tasks/:task_id with { start, end }. We mutate the
       in-memory leaves[] (already a deep-copy from the api module)
       and re-publish the state object so React re-renders. The
       page snapshot stays consistent until reload — refresh
       resets to fixture defaults, which is the prototype's known
       limitation for any optimistic action (toggleAction works
       the same way). */
    /* Sprint 5.6 — single mutation pipeline used by both updateTask
       (drag) and editTask (form). Steps:
         1. find the matching leaf (oldTask) so we can compute the
            end-date delta
         2. apply the patch to produce nextLeaves[]
         3. cascade transitive dependents by deltaDays via the engine
         4. recompute critical_path[] from the new graph
         5. publish the new state

       Cascade trigger = end-date shift only. If end didn't move (e.g.
       editor changed only progress + assignees) we skip cascade but
       still recompute the critical path defensively, since duration
       changes alone could re-rank the longest chain. */
    function applyTaskMutation(s, taskId, patcher) {
      if (s.status !== 'ok') return s;
      var oldTask = s.leaves.filter(function (t) { return t.task_id === taskId; })[0];
      if (!oldTask) return s;

      var nextLeaves = s.leaves.map(function (t) {
        return t.task_id === taskId ? patcher(t) : t;
      });
      var newTask = nextLeaves.filter(function (t) { return t.task_id === taskId; })[0];

      var sched = window.FieldSight && window.FieldSight.programmeSchedule;
      if (sched) {
        var deltaDays = sched.diffDaysISO(oldTask.end, newTask.end);
        if (deltaDays) {
          nextLeaves = sched.cascadeFromTask(nextLeaves, taskId, deltaDays);
        }
        var critIds = sched.computeCriticalPath(nextLeaves, s.programme.start_date);
        return Object.assign({}, s, {
          leaves:   nextLeaves,
          critical: new Set(critIds),
        });
      }
      return Object.assign({}, s, { leaves: nextLeaves });
    }

    function updateTask(opts) {
      opts = opts || {};
      var task_id = opts.task_id;
      var start   = opts.start;
      var end     = opts.end;
      if (!task_id || !start || !end) return;

      setDirty(true);
      setState(function (s) {
        if (s.status !== 'ok') return s;
        /* Clamp to programme bounds — backend would do this server-side. */
        var pStart = s.programme.start_date;
        var pEnd   = s.programme.end_date;
        if (start < pStart) start = pStart;
        if (end   > pEnd)   end   = pEnd;
        if (end < start) end = start;
        return applyTaskMutation(s, task_id, function (t) {
          return Object.assign({}, t, {
            start:         start,
            end:           end,
            duration_days: diffDays(start, end) + 1,
          });
        });
      });
    }

    /* Sprint 5.1 — full-task patch from ProgrammeTaskEditor. Same
       in-memory mutation pattern as updateTask above; a real backend
       call would be PATCH /api/programmes/:id/tasks/:task_id with the
       merged patch object. duration_days is recomputed by the editor's
       validatePatch when start/end are present, so we just spread the
       patch over the matching leaf here. */
    function editTask(opts) {
      opts = opts || {};
      var task_id = opts.task_id;
      var patch   = opts.patch || {};
      if (!task_id) return;
      setDirty(true);
      setState(function (s) {
        return applyTaskMutation(s, task_id, function (t) {
          return Object.assign({}, t, patch);
        });
      });
    }

    /* Sprint 5.3 — delete a leaf task by id.
       Scrubs the id from every other leaf's depends_on[] so dangling
       references can't cause cascade infinite-loops. Recomputes CPM
       over the remaining leaves. */
    function deleteTask(taskId) {
      setDirty(true);
      setState(function (s) {
        if (s.status !== 'ok') return s;
        var nextLeaves = s.leaves
          .filter(function (t) { return t.task_id !== taskId; })
          .map(function (t) {
            if (!t.depends_on || t.depends_on.indexOf(taskId) === -1) return t;
            return Object.assign({}, t, {
              depends_on: t.depends_on.filter(function (id) { return id !== taskId; }),
            });
          });
        var sched = window.FieldSight && window.FieldSight.programmeSchedule;
        var critIds = sched
          ? sched.computeCriticalPath(nextLeaves, s.programme.start_date)
          : Array.from(s.critical).filter(function (id) { return id !== taskId; });
        return Object.assign({}, s, {
          leaves:   nextLeaves,
          critical: new Set(critIds),
        });
      });
    }

    /* Sprint 5.2 — create a new leaf task from editor form data.
       Mints task_id and WBS, appends to leaves[], recomputes CPM.
       No cascade needed (new task has no dependents yet). */
    function addTask(opts) {
      opts = opts || {};
      setDirty(true);
      setState(function (s) {
        if (s.status !== 'ok') return s;
        var parent = (s.parents || []).filter(function (p) {
          return p.task_id === opts.parentId;
        })[0];
        if (!parent) return s;

        var newId    = mintTaskId(s.leaves);
        var newWbs   = mintWbs(parent, s.leaves);
        var start    = opts.start;
        var end      = opts.end;
        var newLeaf  = {
          task_id:             newId,
          wbs:                 newWbs,
          parent_id:           parent.task_id,
          name:                opts.name || 'New task',
          start:               start,
          end:                 end,
          duration_days:       diffDays(start, end) + 1,
          progress_pct:        Number(opts.progress_pct) || 0,
          status:              opts.status || 'not_started',
          depends_on:          (opts.depends_on || []).slice(),
          assignees:           (opts.assignees || []).slice(),
          resource_pool:       [],
          linked_action_items: [],
          tags:                (opts.tags || []).slice(),
          baseline_start:      start,
          baseline_end:        end,
        };

        var nextLeaves = s.leaves.concat([newLeaf]);
        var sched = window.FieldSight && window.FieldSight.programmeSchedule;
        var critIds = sched
          ? sched.computeCriticalPath(nextLeaves, s.programme.start_date)
          : Array.from(s.critical);
        return Object.assign({}, s, {
          leaves:   nextLeaves,
          critical: new Set(critIds),
        });
      });
    }

    /* Sprint 5.4 / F4 — full snapshot replace after CSV/XLSX/MS-Project
       import. Also the entry point for "Upload programme" from the
       empty-state card (status 'empty' → 'ok'), since a fresh import
       IS the programme's first content — there's no prior
       s.programme/s.leaves to preserve in that case. The imported
       leaves are authoritative for the date range too (deriveDateRange)
       so the Gantt lays out correctly immediately, without waiting for
       a save + reload round trip. CPM is recomputed from scratch so the
       import doesn't rely on the file carrying a valid critical-path
       hint. */
    function replaceTasks(nextParents, nextLeaves) {
      setDirty(true);
      setState(function (s) {
        if (s.status !== 'ok' && s.status !== 'empty') return s;
        var today = window.FS.api.todayNZDT();
        var priorStart = s.status === 'ok' ? s.programme.start_date : today;
        var priorEnd   = s.status === 'ok' ? s.programme.end_date   : today;
        var range = deriveDateRange(nextLeaves, priorStart, priorEnd);
        var programme = s.status === 'ok'
          ? Object.assign({}, s.programme, range)
          : {
              site_id: orgSiteId, programme_id: orgSiteId, name: 'Programme',
              start_date: range.start_date, end_date: range.end_date, updated_at: null,
            };
        var sched = window.FieldSight && window.FieldSight.programmeSchedule;
        var critIds = sched
          ? sched.computeCriticalPath(nextLeaves, range.start_date)
          : [];
        return {
          status:    'ok',
          programme: programme,
          parents:   nextParents,
          leaves:    nextLeaves,
          critical:  new Set(critIds),
          today:     s.today || today,
          /* Reset selection — the old selected task may no longer exist */
        };
      });
    }

    /* F4 — "+ Add task" from the empty-state card. There's no WBS group
       to attach a first task to yet (ProgrammeTaskEditor's create mode
       only shows the group picker when parentOptions.length > 0 — see
       composites/programme-task-editor.js), so seed one default group.
       Transitions 'empty' → 'ok' with zero leaves; the caller opens the
       create-task modal right after, which now has somewhere to attach
       to. No-op if a programme is already loaded. */
    function bootstrapProgramme() {
      setState(function (s) {
        if (s.status === 'ok') return s;
        var today = window.FS.api.todayNZDT();
        var defaultParent = { task_id: 'T-100', wbs: '1.0', name: 'Tasks', parent_id: null, status: 'group' };
        return {
          status:    'ok',
          programme: {
            site_id: orgSiteId, programme_id: orgSiteId, name: 'Programme',
            start_date: today, end_date: window.FS.api.addDaysISO(today, 30),
            updated_at: null,
          },
          leaves:   [],
          parents:  [defaultParent],
          critical: new Set(),
          today:    today,
        };
      });
      setDirty(true);
    }

    /* F4 — explicit Save (canWrite-gated button in the header, NOT
       autosave). PUTs { name, start_date, end_date, parents, leaves } —
       the exact shape getProgramme's GET rehydrates state from above, so
       a save + reload round trip is a no-op. */
    function doSaveProgramme() {
      var s = state;
      if (s.status !== 'ok' || !orgSiteId || saving) return;
      var doc = {
        name:       s.programme.name,
        start_date: s.programme.start_date,
        end_date:   s.programme.end_date,
        parents:    s.parents,
        leaves:     s.leaves,
      };
      setSaving(true);
      window.FS.api.programme.saveProgramme(orgSiteId, doc).then(function (res) {
        setSaving(false);
        if (res && res._accessDenied) {
          if (window.FS.toast) window.FS.toast.show({ message: res.error || 'Not allowed to save this programme.', tone: 'error' });
          return;
        }
        if (res && res._notFound) {
          if (window.FS.toast) window.FS.toast.show({ message: 'Could not save — programme endpoint unavailable.', tone: 'error' });
          return;
        }
        setDirty(false);
        if (window.FS.toast) window.FS.toast.show({ message: 'Saved', tone: 'success' });
        var saved = res && res.programme;
        if (saved && saved.updated_at) {
          setState(function (prev) {
            if (prev.status !== 'ok') return prev;
            return Object.assign({}, prev, {
              programme: Object.assign({}, prev.programme, { updated_at: saved.updated_at }),
            });
          });
        }
      }).catch(function () {
        setSaving(false);
        if (window.FS.toast) window.FS.toast.show({ message: 'Could not save programme. Try again.', tone: 'error' });
      });
    }

    /* Sprint 5.7.1 — write permission gate. Only project_manager,
       construction_manager (and above via role hierarchy) and admin
       can mutate the programme. Site managers and below get
       programme:view but not programme:manage, so they see the
       Gantt + can drag-reschedule (since the drag is gated separately
       in scripts/composites/gantt-row.js where applicable) but cannot
       Add or Delete tasks. The button + reducer are both gated to
       keep the contract symmetric. */
    var canWrite = !!(window.FS && window.FS.can
                      && window.FS.can(caller, 'programme:manage'));

    /* Sprint 8.3.3 — save baseline to localStorage + update local state */
    function doSaveBaseline() {
      var s = state;
      if (s.status !== 'ok') return;
      var snapshot = window.FS.api.programme.saveBaseline(
        s.programme.programme_id, s.leaves);
      setBaselineData({ saved_at: new Date().toISOString(), tasks: snapshot });
    }

    var ctx = {
      state:        state,
      /* F4 — org site resolution (Option B) + explicit save */
      orgSitesState:      orgSitesState,
      orgSiteId:          orgSiteId,
      setOrgSiteId:       setOrgSiteId,
      retryOrgSites:      function () { setOrgSitesRetry(function (n) { return n + 1; }); },
      resolveReportSlug:  resolveReportSlug,
      /* Sprint 11 (Task 6) — suggestion review queue */
      orgIsLive:          orgApiLive(),
      suggestionsState:   suggestionsState,
      removeSuggestion:   removeSuggestion,
      retrySuggestions:   function () { setSuggestionsRetry(function (n) { return n + 1; }); },
      dirty:              dirty,
      saving:             saving,
      doSaveProgramme:    doSaveProgramme,
      bootstrapProgramme: bootstrapProgramme,
      view:         view,    setView:    setView,
      tier:         tier,    setTier:    setTier,
      collapsed:    collapsed,
      toggleGroup:  toggleGroup,
      updateTask:   updateTask,
      editTask:     editTask,
      addTask:      addTask,
      deleteTask:   deleteTask,
      replaceTasks: replaceTasks,
      canWrite:     canWrite,
      /* Sprint 8.3.1 */
      showFloat:    showFloat,
      setShowFloat: setShowFloat,
      /* Sprint 8.3.2 */
      overAllocDismissed:    overAllocDismissed,
      setOverAllocDismissed: setOverAllocDismissed,
      /* Sprint 8.3.3 */
      showBaseline:   showBaseline,
      setShowBaseline: setShowBaseline,
      baselineData:    baselineData,
      doSaveBaseline:  doSaveBaseline,
    };
    return React.createElement(ProgrammeContext.Provider, { value: ctx },
      props.children);
  }

  /* ---------- Gantt sub-view ------------------------------------------ */

  function GanttView(props) {
    var fs                   = window.FieldSight;
    var GanttStrip           = fs.GanttStrip;
    var GanttRow             = fs.GanttRow;
    var TaskTreeCell         = fs.TaskTreeCell;
    var OverAllocationBanner = fs.OverAllocationBanner;

    var ctx = React.useContext(ProgrammeContext);
    var s   = ctx.state;
    var prog = s.programme;

    /* Sprint 8.3.1 — compute float map when showFloat is on */
    var floatMap = React.useMemo(function () {
      if (!ctx.showFloat) return {};
      var sched = window.FieldSight && window.FieldSight.programmeSchedule;
      return sched ? sched.computeFloats(s.leaves) : {};
    }, [ctx.showFloat, s.leaves]);

    /* Sprint 8.3.2 — detect over-allocations whenever leaves change */
    var overAllocationMap = React.useMemo(function () {
      var sched = window.FieldSight && window.FieldSight.programmeSchedule;
      return sched ? sched.detectOverAllocations(s.leaves) : {};
    }, [s.leaves]);

    /* Sprint 8.3.3 — build a lookup: task_id → { start, end } from saved baseline */
    var baselineLookup = React.useMemo(function () {
      if (!ctx.baselineData || !ctx.baselineData.tasks) return {};
      var map = {};
      ctx.baselineData.tasks.forEach(function (b) { map[b.task_id] = b; });
      return map;
    }, [ctx.baselineData]);

    /* Build the visible rows in WBS order: each parent followed by its
       leaves (unless collapsed). */
    var rows = [];
    s.parents.forEach(function (parent) {
      var roll = rollupGroup(parent, s.leaves);
      var groupTask = Object.assign({}, parent, {
        start: roll.start, end: roll.end, duration_days: 0,
        progress_pct: roll.progress, status: 'group',
      });
      rows.push({ kind: 'group', task: groupTask, parent: parent, indent: 0 });
      if (!ctx.collapsed.has(parent.task_id)) {
        s.leaves
          .filter(function (t) { return t.parent_id === parent.task_id; })
          .forEach(function (leaf) {
            rows.push({ kind: 'leaf', task: leaf, indent: 1 });
          });
      }
    });

    var ppd        = TIER_PIXELS[ctx.tier] || 24;
    var totalDays  = diffDays(prog.start_date, prog.end_date) + 1;
    var totalWidth = totalDays * ppd;

    /* Today marker offset within the timeline. */
    var todayOffset = null;
    if (s.today >= prog.start_date && s.today <= prog.end_date) {
      todayOffset = diffDays(prog.start_date, s.today) * ppd;
    }

    var selectedId = props.selectedItem && props.selectedItem.kind === 'programme_task'
      ? props.selectedItem.task_id
      : null;

    /* Sprint 8.8.3 — virtual list (only engaged when rows > 50) */
    var ROW_H    = 44;
    var OVERSCAN = 200;
    var DO_VIRT  = rows.length > 50;

    var scrollRef  = React.useRef(null);
    var refSTop    = React.useState(0);
    var sTop       = refSTop[0]; var setSTop = refSTop[1];
    var refVpH     = React.useState(600);
    var vpH        = refVpH[0];  var setVpH  = refVpH[1];

    React.useEffect(function () {
      if (!DO_VIRT) return;
      var el = scrollRef.current;
      if (!el) return;
      setVpH(el.clientHeight || 600);
      function onScroll() { setSTop(el.scrollTop); }
      function onResize() { setVpH(el.clientHeight || 600); }
      el.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onResize);
      return function () {
        el.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onResize);
      };
    }, [DO_VIRT]);

    var first   = DO_VIRT ? Math.max(0, Math.floor((sTop - OVERSCAN) / ROW_H)) : 0;
    var last    = DO_VIRT ? Math.min(rows.length - 1, Math.ceil((sTop + vpH + OVERSCAN) / ROW_H)) : rows.length - 1;
    var vRows   = DO_VIRT ? rows.slice(first, last + 1) : rows;
    var topSpc  = DO_VIRT ? first * ROW_H : 0;
    var botSpc  = DO_VIRT ? Math.max(0, (rows.length - 1 - last) * ROW_H) : 0;

    /* ---- Sprint 4.9 — drag controller --------------------------------
       We hold one in-flight drag at a time. The active drag lives in
       useRef so move handlers see the latest origin without stale
       closures, and a parallel useState forces re-render when the
       preview shifts. */
    var dragRefHook = React.useState({ taskId: null, mode: null,
                                       originX: 0, origStart: '',
                                       origEnd: '', start: '', end: '' });
    var dragState   = dragRefHook[0];
    var setDragState = dragRefHook[1];
    var dragRef     = React.useRef(dragState);
    dragRef.current = dragState;

    function dragStart(task, mode, clientX) {
      var next = {
        taskId:    task.task_id,
        mode:      mode,
        originX:   clientX,
        origStart: task.start,
        origEnd:   task.end,
        start:     task.start,
        end:       task.end,
      };
      setDragState(next);
      document.body.classList.add('fs-gantt-dragging');
      document.body.classList.add('fs-gantt-dragging--' + mode);
    }

    function dragMove(clientX) {
      var d = dragRef.current;
      if (!d.taskId) return;
      var deltaPx   = clientX - d.originX;
      var deltaDays = Math.round(deltaPx / ppd);
      var nextStart = d.origStart;
      var nextEnd   = d.origEnd;

      if (d.mode === 'move') {
        nextStart = window.FS.api.addDaysISO(d.origStart, deltaDays);
        nextEnd   = window.FS.api.addDaysISO(d.origEnd,   deltaDays);
      } else if (d.mode === 'resize-start') {
        nextStart = window.FS.api.addDaysISO(d.origStart, deltaDays);
        if (nextStart > d.origEnd) nextStart = d.origEnd;
      } else if (d.mode === 'resize-end') {
        nextEnd = window.FS.api.addDaysISO(d.origEnd, deltaDays);
        if (nextEnd < d.origStart) nextEnd = d.origStart;
      }

      /* Clamp to programme bounds. */
      if (nextStart < prog.start_date) nextStart = prog.start_date;
      if (nextEnd   > prog.end_date)   nextEnd   = prog.end_date;

      if (nextStart === d.start && nextEnd === d.end) return;
      setDragState(Object.assign({}, d, { start: nextStart, end: nextEnd }));
    }

    function dragEnd() {
      var d = dragRef.current;
      document.body.classList.remove('fs-gantt-dragging');
      document.body.classList.remove('fs-gantt-dragging--move');
      document.body.classList.remove('fs-gantt-dragging--resize-start');
      document.body.classList.remove('fs-gantt-dragging--resize-end');
      if (!d.taskId) return;

      /* Only commit if anything actually changed. */
      if (d.start !== d.origStart || d.end !== d.origEnd) {
        ctx.updateTask({ task_id: d.taskId, start: d.start, end: d.end });
      }
      setDragState({ taskId: null, mode: null, originX: 0,
                     origStart: '', origEnd: '', start: '', end: '' });
    }

    var showOverAllocBanner = ctx.canWrite
      && !ctx.overAllocDismissed
      && Object.keys(overAllocationMap).length > 0;

    return React.createElement('div', { className: 'fs-gantt-wrap' },

      /* Sprint 8.3.2 — Over-allocation banner above Gantt */
      showOverAllocBanner && OverAllocationBanner
        ? React.createElement(OverAllocationBanner, {
            overAllocationMap: overAllocationMap,
            onDismiss:         function () { ctx.setOverAllocDismissed(true); },
          })
        : null,

      React.createElement('div', {
        ref:       DO_VIRT ? scrollRef : null,
        className: 'fs-gantt',
        style:     DO_VIRT ? { maxHeight: '70vh', overflowY: 'auto' } : undefined,
      },

        /* Sticky left tree */
        React.createElement('div', { className: 'fs-gantt__tree' },
          React.createElement('div', {
            className: 'fs-gantt__tree-head',
            style:     DO_VIRT ? { position: 'sticky', top: 0, zIndex: 2 } : undefined,
          }, 'WBS \xb7 Task'),
          DO_VIRT && topSpc > 0
            ? React.createElement('div', { style: { height: topSpc + 'px', flexShrink: 0 } })
            : null,
          vRows.map(function (r) {
            return React.createElement(TaskTreeCell, {
              key:        r.task.task_id,
              task:       r.task,
              isGroup:    r.kind === 'group',
              expanded:   r.kind === 'group' && !ctx.collapsed.has(r.task.task_id),
              indent:     r.indent,
              critical:   r.kind === 'leaf' && s.critical.has(r.task.task_id),
              selected:   selectedId === r.task.task_id,
              onToggle:   function () { ctx.toggleGroup(r.task.task_id); },
              onSelect:   function () {
                if (r.kind === 'group') return;
                props.onSelect({
                  kind:     'programme_task',
                  id:       'task_' + r.task.task_id,
                  task_id:  r.task.task_id,
                  task:     r.task,
                });
              },
            });
          }),
          DO_VIRT && botSpc > 0
            ? React.createElement('div', { style: { height: botSpc + 'px', flexShrink: 0 } })
            : null,
        ),

        /* Right scrollable timeline */
        React.createElement('div', { className: 'fs-gantt__timeline' },
          React.createElement('div', {
            className: 'fs-gantt__timeline-inner',
            style:     { width: totalWidth + 'px' },
          },
            React.createElement(GanttStrip, {
              from: prog.start_date, to: prog.end_date,
              pixelsPerDay: ppd, tier: ctx.tier,
            }),
            DO_VIRT && topSpc > 0
              ? React.createElement('div', { style: { height: topSpc + 'px' } })
              : null,

            vRows.map(function (r) {
              var isDragging = dragState.taskId === r.task.task_id;
              var bLine = (r.kind === 'leaf') ? (baselineLookup[r.task.task_id] || null) : null;
              return React.createElement(GanttRow, {
                key:            r.task.task_id,
                task:           r.task,
                programmeStart: prog.start_date,
                pixelsPerDay:   ppd,
                critical:       r.kind === 'leaf' && s.critical.has(r.task.task_id),
                selected:       selectedId === r.task.task_id,
                dragPreview:    isDragging
                                  ? { start: dragState.start, end: dragState.end }
                                  : null,
                onDragStart:    r.kind === 'leaf' ? dragStart : null,
                onDragMove:     r.kind === 'leaf' ? dragMove  : null,
                onDragEnd:      r.kind === 'leaf' ? dragEnd   : null,
                /* Sprint 8.5.5 — keyboard move commits directly via updateTask */
                onKeyboardMove: r.kind === 'leaf' ? function (opts) { ctx.updateTask(opts); } : null,
                programmeDurationDays: diffDays(prog.start_date, prog.end_date) + 1,
                /* Sprint 8.3.1 — float */
                showFloat:  ctx.showFloat && r.kind === 'leaf',
                floatDays:  ctx.showFloat && r.kind === 'leaf'
                              ? floatMap[r.task.task_id]
                              : undefined,
                /* Sprint 8.3.3 — baseline */
                showBaseline:  ctx.showBaseline && !!bLine,
                baselineStart: bLine ? bLine.start : null,
                baselineEnd:   bLine ? bLine.end   : null,
                onSelect:      function () {
                  if (r.kind === 'group') return;
                  props.onSelect({
                    kind:     'programme_task',
                    id:       'task_' + r.task.task_id,
                    task_id:  r.task.task_id,
                    task:     r.task,
                  });
                },
              });
            }),

            DO_VIRT && botSpc > 0
              ? React.createElement('div', { style: { height: botSpc + 'px' } })
              : null,

            todayOffset != null
              ? React.createElement('div', {
                  className: 'fs-gantt__today',
                  style:     { left: todayOffset + 'px' },
                  title:     'Today: ' + s.today,
                })
              : null,
          ),
        ),
      ),
    );
  }

  /* ---------- ProgrammeMiddleColumn ----------------------------------- */

  function ProgrammeMiddleColumn(props) {
    var fs                    = window.FieldSight;
    /* Sprint 4.8 — Jira-style 4-column kanban board replaces the
       This-Week / Next-Week / Later bucket list from 4.4. */
    var ProgrammeKanbanBoard  = fs.ProgrammeKanbanBoard;
    var Button                = fs.Button;
    var Badge                 = fs.Badge;
    var Editor                = fs.ProgrammeTaskEditor;
    var ImportModal           = fs.ProgrammeImportModal;
    var onSelect              = props.onSelect || function () {};

    /* Sprint 5.2 — "+ Add task" modal open state. */
    var refAdding = React.useState(false);
    var adding    = refAdding[0];
    var setAdding = refAdding[1];

    /* Sprint 5.4 — CSV import modal open state. */
    var refImporting = React.useState(false);
    var importing    = refImporting[0];
    var setImporting = refImporting[1];

    var ctx = React.useContext(ProgrammeContext);
    if (!ctx) {
      console.warn('[ProgrammeMiddleColumn] ProgrammeContext missing');
      return null;
    }
    var s = ctx.state;

    /* Sprint 4.10.1 — URL deep-link.
       When the page mounts (or programme finishes loading) and the URL
       carries `?task=T-XXX`, automatically select that task so the
       RightDrawer slides in. Used by the Today → Programme click-through
       (4.10.6). Only fires if the caller hasn't already manually
       selected something else, and only once per (state.status, task_id)
       transition. */
    var deepLinkRouteRef = React.useRef(null);
    React.useEffect(function () {
      if (s.status !== 'ok') return;
      var route = window.FS && window.FS.Router && window.FS.Router.getCurrentRoute();
      var params = (route && route.params) || {};
      var taskId = params.task;
      if (!taskId) return;

      /* Avoid re-firing on every re-render — only when the URL value
         actually changes. */
      if (deepLinkRouteRef.current === taskId) return;
      deepLinkRouteRef.current = taskId;

      var task = (s.leaves || []).filter(function (t) { return t.task_id === taskId; })[0];
      if (!task) return;
      onSelect({
        kind:     'programme_task',
        id:       'task_' + task.task_id,
        task_id:  task.task_id,
        task:     task,
      });
    }, [s.status, s.leaves]);

    /* F4 — org-site gating precedes programme data entirely: nothing in
       ctx.state is meaningful until an ORG SITE UUID has been chosen
       (see ProgrammeProvider's org-site-resolution effect). */
    if (ctx.orgSitesState.status === 'loading') {
      return React.createElement('div', { className: 'fs-programme' },
        React.createElement('div', { className: 'fs-programme__loading' },
          'Loading projects…'),
      );
    }
    if (ctx.orgSitesState.status === 'access_denied') {
      var AccessDeniedSites = fs.AccessDenied;
      return React.createElement('div', { className: 'fs-programme' },
        AccessDeniedSites
          ? React.createElement(AccessDeniedSites, {
              scope:   'projects',
              message: ctx.orgSitesState.message,
            })
          : React.createElement('div', null, 'Access denied.'),
      );
    }
    if (ctx.orgSitesState.status === 'error') {
      var ErrorBannerSites = fs.ErrorBanner;
      return React.createElement('div', { className: 'fs-programme' },
        ErrorBannerSites
          ? React.createElement(ErrorBannerSites, {
              message:   'Could not load projects',
              retryable: true,
              onRetry:   ctx.retryOrgSites,
            })
          : React.createElement('div', { className: 'fs-programme__empty' },
              'Could not load projects.'),
      );
    }
    if (!ctx.orgSitesState.sites.length) {
      return React.createElement('div', { className: 'fs-programme' },
        React.createElement('div', { className: 'fs-programme__empty' },
          'No projects available.'),
      );
    }
    if (!ctx.orgSiteId) {
      return React.createElement('div', { className: 'fs-programme' },
        React.createElement('div', { className: 'fs-programme__empty-card' },
          React.createElement('div', { className: 'fs-programme__empty-card-title' },
            'Select a project'),
          React.createElement('div', { className: 'fs-programme__empty-card-body' },
            'Choose a project to view its Programme.'),
          renderSitePicker(ctx, { marginTop: '14px' }),
        ),
      );
    }

    if (s.status === 'loading' || s.status === 'no_site') {
      return React.createElement('div', { className: 'fs-programme' },
        React.createElement('div', { className: 'fs-programme__loading' },
          'Loading programme…'),
      );
    }
    if (s.status === 'error') {
      var ErrorBanner = fs.ErrorBanner;
      return React.createElement('div', { className: 'fs-programme' },
        ErrorBanner
          ? React.createElement(ErrorBanner, {
              message:   (s.error && s.error.message) || 'Could not load programme',
              retryable: true,
              onRetry:   s.retry,
            })
          : React.createElement('div', { className: 'fs-programme__empty' },
              (s.error && s.error.message) || 'Could not load programme'),
      );
    }
    if (s.status === 'access_denied') {
      var AccessDenied = fs.AccessDenied;
      return React.createElement('div', { className: 'fs-programme' },
        AccessDenied
          ? React.createElement(AccessDenied, {
              scope:   'this programme',
              message: s.message,
            })
          : React.createElement('div', null, 'Access denied.'),
      );
    }

    var isEmpty    = s.status === 'empty';
    var p           = isEmpty ? null : s.programme;
    var selectedId  = (!isEmpty && props.selectedItem && props.selectedItem.kind === 'programme_task')
      ? props.selectedItem.task_id
      : null;

    return React.createElement('div', { className: 'fs-programme' },

      /* Header */
      React.createElement('div', { className: 'fs-programme__header' },
        React.createElement('div', { className: 'fs-programme__header-row' },
          React.createElement('h2', { className: 'fs-programme__title' },
            isEmpty ? 'Programme' : p.name),
          /* Sprint 11 (Task 6) — pending suggestion-review count. Live-gated:
             the backend only exists for the org-live channel, so this button
             (and the matching right-pane block in ProgrammeRightDetail) never
             appear against the mock fixture on the real page — only in
             components-preview.html's standalone composite demo. */
          ctx.orgIsLive && ctx.orgSiteId
            ? React.createElement('button', {
                type:      'button',
                className: 'fs-programme__suggestions-badge'
                  + ((props.selectedItem && props.selectedItem.kind === 'suggestions_panel')
                      ? ' fs-programme__suggestions-badge--active' : ''),
                onClick:   function () { onSelect({ kind: 'suggestions_panel', id: 'suggestions_panel' }); },
                title:     'Review suggested programme updates',
              },
                'Suggested updates',
                Badge ? React.createElement(Badge, {
                  tone:    ctx.suggestionsState.rows.length ? 'info' : 'neutral',
                  variant: ctx.suggestionsState.rows.length ? 'solid' : 'subtle',
                  size:    'sm', pill: true,
                }, String(ctx.suggestionsState.rows.length)) : null,
              )
            : null,
          renderSitePicker(ctx),
        ),
        !isEmpty
          ? React.createElement('div', { className: 'fs-programme__subtitle' },
              fmtDate(p.start_date) + ' → ' + fmtDate(p.end_date)
                + ' · ' + s.leaves.length + ' tasks'
                + ' · ' + (s.critical && s.critical.size) + ' on critical path'
                + (ctx.dirty ? ' · unsaved changes' : ''))
          : null,

        /* View + tier toggles — nothing to toggle until a programme exists */
        !isEmpty ? React.createElement('div', { className: 'fs-programme__toolbar' },
          React.createElement('div', { className: 'fs-programme__view-toggle' },
            React.createElement('button', {
              type:      'button',
              className: 'fs-programme__toggle' + (ctx.view === 'gantt' ? ' fs-programme__toggle--active' : ''),
              onClick:   function () { ctx.setView('gantt'); },
            }, 'Gantt'),
            React.createElement('button', {
              type:      'button',
              className: 'fs-programme__toggle' + (ctx.view === 'todo' ? ' fs-programme__toggle--active' : ''),
              onClick:   function () { ctx.setView('todo'); },
            }, 'Board'),
          ),

          ctx.view === 'gantt'
            ? React.createElement('div', { className: 'fs-programme__tier-toggle' },
                ['day', 'week', 'month'].map(function (k) {
                  return React.createElement('button', {
                    key:       k,
                    type:      'button',
                    className: 'fs-programme__toggle fs-programme__toggle--small'
                                + (ctx.tier === k ? ' fs-programme__toggle--active' : ''),
                    onClick:   function () { ctx.setTier(k); },
                  }, k.charAt(0).toUpperCase() + k.slice(1));
                }),
              )
            : null,

          /* Sprint 8.3.1 — Show float toggle (Gantt only) */
          ctx.view === 'gantt'
            ? React.createElement('label', { className: 'fs-programme__toolbar-check', title: 'Show total float (slack) per task' },
                React.createElement('input', {
                  type:     'checkbox',
                  checked:  ctx.showFloat,
                  onChange: function (e) { ctx.setShowFloat(e.target.checked); },
                }),
                'Show float'
              )
            : null,

          /* Sprint 8.3.3 — Save baseline / Compare baseline (gated: canWrite) */
          ctx.canWrite && ctx.view === 'gantt'
            ? React.createElement(Button || 'button', Object.assign(
                Button ? { variant: 'secondary', size: 'sm' } : { type: 'button' },
                { onClick: ctx.doSaveBaseline, title: 'Save current schedule as baseline' }
              ), 'Save baseline')
            : null,

          ctx.canWrite && ctx.view === 'gantt' && ctx.baselineData
            ? React.createElement('label', { className: 'fs-programme__toolbar-check', title: 'Compare against saved baseline (' + (ctx.baselineData.saved_at ? ctx.baselineData.saved_at.slice(0, 10) : '') + ')' },
                React.createElement('input', {
                  type:     'checkbox',
                  checked:  ctx.showBaseline,
                  onChange: function (e) { ctx.setShowBaseline(e.target.checked); },
                }),
                'Compare baseline'
              )
            : null,

          /* Sprint 5.2 — Add task button (gated 5.7.1: PM / CM / admin) */
          Button && ctx.canWrite
            ? React.createElement(Button, {
                variant: 'primary', size: 'sm',
                onClick:  function () { setAdding(true); },
              }, '+ Add task')
            : null,

          /* Sprint 5.4 — Import CSV/XML/XLSX button (gated 5.7.1: PM / CM / admin) */
          Button && ctx.canWrite
            ? React.createElement(Button, {
                variant: 'secondary', size: 'sm',
                onClick:  function () { setImporting(true); },
              }, 'Import…')
            : null,

          /* F4 — explicit Save (canWrite-gated; NOT autosave). Disabled
             when there's nothing unsaved so it doesn't invite a no-op
             round trip. */
          ctx.canWrite
            ? React.createElement(Button || 'button', Object.assign(
                Button ? { variant: 'primary', size: 'sm', disabled: !ctx.dirty || ctx.saving }
                       : { type: 'button', disabled: !ctx.dirty || ctx.saving },
                { onClick: ctx.doSaveProgramme, title: 'Save programme to server' }
              ), ctx.saving ? 'Saving…' : 'Save')
            : null,
        ) : null,
      ),

      /* Body */
      isEmpty
        ? React.createElement('div', { className: 'fs-programme__empty-card' },
            React.createElement('div', { className: 'fs-programme__empty-card-title' },
              'No programme yet'),
            React.createElement('div', { className: 'fs-programme__empty-card-body' },
              ctx.canWrite
                ? 'Upload a schedule or add tasks to get started.'
                : 'No programme uploaded yet.'),
            ctx.canWrite
              ? React.createElement('div', { className: 'fs-programme__empty-card-actions' },
                  Button ? React.createElement(Button, {
                    variant: 'primary', size: 'md',
                    onClick: function () { setImporting(true); },
                  }, 'Upload programme') : null,
                  Button ? React.createElement(Button, {
                    variant: 'secondary', size: 'md',
                    onClick: function () { ctx.bootstrapProgramme(); setAdding(true); },
                  }, '+ Add task') : null,
                )
              : React.createElement('div', { className: 'fs-programme__empty-card-readonly' },
                  'No programme uploaded yet'),
          )
        : (ctx.view === 'gantt'
            ? React.createElement(GanttView, {
                selectedItem: props.selectedItem,
                onSelect:     onSelect,
              })
            : React.createElement(ProgrammeKanbanBoard, {
                parents:       s.parents,
                leaves:        s.leaves,
                today:         s.today,
                selectedId:    selectedId,
                criticalSet:   s.critical,
                collapsedSet:  ctx.collapsed,
                onToggleGroup: ctx.toggleGroup,
                onSelect:      function (t) {
                  onSelect({
                    kind:    'programme_task',
                    id:      'task_' + t.task_id,
                    task_id: t.task_id,
                    task:    t,
                  });
                },
              })),

      /* Sprint 5.2 — add-task modal (create mode). Also reachable from
         the empty-state "+ Add task" button, which calls
         ctx.bootstrapProgramme() first — by the time onSubmit fires
         (a later user interaction), s.leaves/s.parents are always
         defined, so the || [] fallback here is just defensive. */
      Editor
        ? React.createElement(Editor, {
            open:    adding,
            mode:    'create',
            leaves:  s.leaves  || [],
            parents: s.parents || [],
            onClose: function () { setAdding(false); },
            onSubmit: function (opts) {
              ctx.addTask(opts);
              setAdding(false);
            },
          })
        : null,

      /* Sprint 5.4 — CSV import modal. Also reachable from the
         empty-state "Upload programme" button — ctx.replaceTasks
         handles the 'empty' → 'ok' transition itself. */
      ImportModal
        ? React.createElement(ImportModal, {
            open:     importing,
            onClose:  function () { setImporting(false); },
            onImport: function (parents, leaves) {
              ctx.replaceTasks(parents, leaves);
              setImporting(false);
            },
          })
        : null,
    );
  }

  /* ---------- ProgrammeRightDetail ------------------------------------ */

  function ProgrammeRightDetail(props) {
    var fs       = window.FieldSight;
    var Card     = fs.Card;
    var Badge    = fs.Badge;
    var Button   = fs.Button;
    var IconBtn  = fs.IconButton;
    var Editor   = fs.ProgrammeTaskEditor;
    var SuggestionReview = fs.SuggestionReview;

    var ctx = React.useContext(ProgrammeContext);
    var sel = props.selectedItem;

    /* Sprint 5.1 — Edit modal open state, scoped to this detail panel. */
    var refEdit = React.useState(false);
    var editing  = refEdit[0];
    var setEdit  = refEdit[1];

    /* Linked-action lazy fetch — only when a task is selected and it
       carries linked_action_items. We pull each action's text from
       /api/timeline so the right pane shows the real action wording
       (not just the indices). */
    var refLinks = React.useState({ status: 'idle', items: [] });
    var linksS   = refLinks[0];
    var setLinks = refLinks[1];

    React.useEffect(function () {
      if (!sel || sel.kind !== 'programme_task') {
        setLinks({ status: 'idle', items: [] });
        return undefined;
      }
      var linked = (sel.task && sel.task.linked_action_items) || [];
      if (linked.length === 0) {
        setLinks({ status: 'ok', items: [] });
        return undefined;
      }
      var cancelled = false;
      setLinks({ status: 'loading', items: [] });

      /* Group by date so we issue one getTimeline per unique date. */
      var byDate = {};
      linked.forEach(function (l) {
        (byDate[l.date] = byDate[l.date] || []).push(l);
      });
      var dates = Object.keys(byDate);

      Promise.all(dates.map(function (d) {
        return window.FS.api.timeline.getTimeline({ date: d, user: null })
          .then(function (r) { return { date: d, report: r }; });
      })).then(function (perDate) {
        if (cancelled) return;
        var items = [];
        perDate.forEach(function (x) {
          if (!x.report || x.report._notFound) return;
          /* When user is null and there's only one user, getTimeline
             may return the single report directly OR an
             available_users disambiguation. Try to handle either. */
          var report = x.report.available_users && x.report.available_users.length === 1
            ? null  /* multi-user disambiguation — defer to user picking on /timeline */
            : x.report;

          (byDate[x.date] || []).forEach(function (link) {
            var topic = report && (report.topics || []).filter(function (t) {
              return t.topic_id === link.topic_id;
            })[0];
            if (!topic) {
              items.push({
                date: link.date, topic_id: link.topic_id,
                action_index: link.action_index,
                text: '(action not found in fixture)',
                user_folder: null,
              });
              return;
            }
            var action = (topic.action_items || [])[link.action_index];
            items.push({
              date:         link.date,
              topic_id:     link.topic_id,
              action_index: link.action_index,
              text:         action ? action.action : '(action_index out of range)',
              responsible:  action ? action.responsible : null,
              topic_title:  topic.topic_title,
              user_folder:  report && report.user_name
                              ? window.FS.api.folderName(report.user_name)
                              : null,
            });
          });
        });
        setLinks({ status: 'ok', items: items });
      }).catch(function () {
        if (!cancelled) setLinks({ status: 'error', items: [] });
      });

      return function () { cancelled = true; };
    }, [sel && sel.task && sel.task.task_id]);

    /* Sprint 11 (Task 6) — suggestion review queue. Opened via the
       "Suggested updates (n)" button in ProgrammeMiddleColumn's header
       (onSelect({ kind: 'suggestions_panel' })), sharing the same
       slide-in drawer a selected task uses. Project-scoped, not
       task-scoped — reads ctx.suggestionsState (fetched once by
       ProgrammeProvider, shared with the header's count badge). */
    if (sel && sel.kind === 'suggestions_panel') {
      return React.createElement('div', { className: 'fs-programme-detail' },
        React.createElement('div', { className: 'fs-programme-detail__header' },
          React.createElement('div', { className: 'fs-programme-detail__header-main' },
            React.createElement('h2', { className: 'fs-programme-detail__title' }, 'Suggested updates'),
          ),
          IconBtn ? React.createElement(IconBtn, {
            icon: 'x', ariaLabel: 'Close detail', size: 'sm',
            onClick: function () { if (props.onClose) props.onClose(); },
          }) : null,
        ),
        ctx && ctx.suggestionsState && ctx.suggestionsState.status === 'error'
          ? React.createElement('div', { className: 'fs-programme-detail__empty' },
              'Could not load suggested updates.')
          : SuggestionReview
          ? React.createElement(SuggestionReview, {
              suggestions: (ctx && ctx.suggestionsState && ctx.suggestionsState.rows) || [],
              siteSlug:    ctx && ctx.resolveReportSlug ? ctx.resolveReportSlug(ctx.orgSiteId) : null,
              onResolved:  ctx && ctx.removeSuggestion,
            })
          : null,
      );
    }

    if (!sel || sel.kind !== 'programme_task') {
      return React.createElement('div', { className: 'fs-programme-detail__placeholder' },
        React.createElement('div', { className: 'fs-programme-detail__placeholder-title' },
          'Select a task'),
        React.createElement('div', { className: 'fs-programme-detail__placeholder-body' },
          'Pick any task from the Gantt or the TO-DO list to see its full detail and linked report actions.'),
      );
    }

    var t = sel.task;
    var s = ctx && ctx.state;
    var critical = s && s.critical && s.critical.has(t.task_id);

    var statusTone = ({
      not_started: 'neutral',
      in_progress: 'info',
      completed:   'success',
      blocked:     'danger',
      delayed:     'warning',
    })[t.status] || 'neutral';

    var statusLabel = ({
      not_started: 'Not started',
      in_progress: 'In progress',
      completed:   'Done',
      blocked:     'Blocked',
      delayed:     'Delayed',
    })[t.status] || t.status;

    function openLink(link) {
      if (!link.user_folder) {
        /* Fall back to date-only navigation when reporter ambiguous. */
        window.FS.Router.navigate('/timeline?date=' + encodeURIComponent(link.date));
        return;
      }
      window.FS.Router.navigate(
        '/timeline?date=' + encodeURIComponent(link.date)
          + '&user=' + encodeURIComponent(link.user_folder));
    }

    return React.createElement('div', { className: 'fs-programme-detail' },

      /* Header */
      React.createElement('div', { className: 'fs-programme-detail__header' },
        React.createElement('div', { className: 'fs-programme-detail__header-main' },
          React.createElement('div', { className: 'fs-programme-detail__wbs' },
            'WBS ' + t.wbs),
          React.createElement('h2', { className: 'fs-programme-detail__title' },
            t.name),
          React.createElement('div', { className: 'fs-programme-detail__metaline' },
            React.createElement(Badge, { tone: statusTone, size: 'sm', prefixDot: true },
              statusLabel),
            critical ? React.createElement(Badge, {
              tone: 'danger', size: 'sm', variant: 'subtle',
            }, 'Critical path') : null,
            (t.tags || []).map(function (tag) {
              return React.createElement(Badge, {
                key: tag, tone: 'warning', size: 'sm', variant: 'outline',
              }, tag.replace(/_/g, ' '));
            }),
          ),
        ),
        /* Sprint 5.1 — Edit opens the task editor modal.
           Sprint 5.7.2 — gated on programme:manage (admin/PM/CM only),
           consistent with the Add (5.2) and Delete (5.3) gates. */
        Editor && ctx && ctx.canWrite ? React.createElement(Button, {
          variant: 'ghost', size: 'sm',
          onClick: function () { setEdit(true); },
        }, 'Edit') : null,
        IconBtn ? React.createElement(IconBtn, {
          icon: 'x', ariaLabel: 'Close detail', size: 'sm',
          onClick: function () { if (props.onClose) props.onClose(); },
        }) : null,
      ),

      /* Detail rows */
      React.createElement('div', { className: 'fs-programme-detail__rows' },
        React.createElement(DetailRow, {
          label: 'Dates',
          value: fmtDate(t.start) + ' → ' + fmtDate(t.end)
                  + '   (' + (t.duration_days || 0) + ' days)',
        }),
        React.createElement(DetailRow, {
          label: 'Baseline',
          value: fmtDate(t.baseline_start) + ' → ' + fmtDate(t.baseline_end),
        }),
        React.createElement(DetailRow, {
          label: 'Progress',
          value: (t.progress_pct || 0) + '%',
        }),
        React.createElement(DetailRow, {
          label: 'Assignees',
          value: (t.assignees || []).map(function (a) { return a.replace(/_/g, ' '); }).join(', ') || '—',
        }),
        React.createElement(DetailRow, {
          label: 'Resource pool',
          value: (t.resource_pool || []).join(', ') || '—',
        }),
        React.createElement(DetailRow, {
          label: 'Depends on',
          value: (t.depends_on || []).join(', ') || '—',
        }),
      ),

      /* Linked actions */
      React.createElement('div', { className: 'fs-programme-detail__links' },
        React.createElement('div', { className: 'fs-programme-detail__links-label' },
          'Linked report actions'),
        linksS.status === 'idle' || linksS.status === 'loading'
          ? React.createElement('div', { className: 'fs-programme-detail__empty' },
              'Loading linked actions…')
          : linksS.status === 'error'
          ? React.createElement('div', { className: 'fs-programme-detail__empty' },
              'Could not load linked actions.')
          : linksS.items.length === 0
          ? React.createElement('div', { className: 'fs-programme-detail__empty' },
              'No linked report actions for this task.')
          : React.createElement('div', { className: 'fs-programme-detail__links-list' },
              linksS.items.map(function (link, i) {
                return React.createElement('button', {
                  key:       link.date + '_' + link.topic_id + '_' + link.action_index,
                  type:      'button',
                  className: 'fs-programme-detail__link',
                  onClick:   function () { openLink(link); },
                  title:     'Open on /timeline',
                },
                  React.createElement('div', { className: 'fs-programme-detail__link-text' },
                    link.text),
                  React.createElement('div', { className: 'fs-programme-detail__link-meta' },
                    fmtDate(link.date)
                      + (link.topic_title ? ' · ' + link.topic_title : '')
                      + (link.responsible ? ' · ' + link.responsible : '')),
                );
              }),
            ),
      ),

      /* Sprint 5.1 / 5.3 — task editor modal.
         Sprint 5.7.1 — only PM / CM / admin (canWrite) get the Delete
         button. The editor checks `onDelete` truthiness to render the
         red Delete control in the footer, so passing null hides it
         entirely for read-only roles. */
      Editor ? React.createElement(Editor, {
        open:    editing,
        task:    t,
        leaves:  (s && s.leaves) || [],
        parents: (s && s.parents) || [],
        onClose: function () { setEdit(false); },
        onSubmit: function (opts) {
          ctx.editTask(opts);
          setEdit(false);
        },
        onDelete: ctx.canWrite
          ? function (taskId) {
              ctx.deleteTask(taskId);
              setEdit(false);
              if (props.onClose) props.onClose();
            }
          : null,
      }) : null,
    );
  }

  function DetailRow(props) {
    return React.createElement('div', { className: 'fs-programme-detail__row' },
      React.createElement('div', { className: 'fs-programme-detail__row-label' },
        props.label),
      React.createElement('div', { className: 'fs-programme-detail__row-value' },
        props.value),
    );
  }

  /* ---------- Register --------------------------------------------------- */

  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.PAGES) window.FieldSight.PAGES = {};
  window.FieldSight.PAGES['/programme'] = {
    Middle:   ProgrammeMiddleColumn,
    Right:    ProgrammeRightDetail,
    Provider: ProgrammeProvider,
    /* Sprint 4.7 — Programme uses the entire content area (Gantt is
       wider than the default middle column will ever be). The right
       detail comes in as a slide-in drawer when a task is selected;
       AppShell wires it via window.FieldSight.RightDrawer. */
    layout:   'full-width',
  };

})();
