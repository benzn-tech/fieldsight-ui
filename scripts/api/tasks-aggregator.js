/* ==========================================================================
   FieldSight API · Tasks aggregator (Sprint 4.2)
   --------------------------------------------------------------------------
   Flattens daily-report topics into a single list the Tasks page can
   render without re-doing the walk itself. Each action item is read from
   the org payload the page already has: text, responsible, deadline,
   priority AND its own done-ness (`action_items.status === 'done'`).
   There is no second store: the legacy DynamoDB tick overlay is gone, so
   `audit.checked` below is derived from `status` alone.

   Single stable contract, regardless of mock vs real backend — UI
   consumers see the same row shape.

   Returned row shape:
     {
       id:           '<date>_<user_folder>_<topic_id>_<action_index>',  // opaque —
                     // user_folder segment (Sprint 11.x user-dim audit key) prevents
                     // same-date/same-tid/idx rows from different owners colliding
                     // on React key / removeRow. No parser reads this id — see
                     // docs/superpowers/plans/2026-07-13-user-dimension-audit-key.md
       date:         'YYYY-MM-DD',
       topic_id:     number,
       action_index: number,
       action:       string,                       // free text
       responsible:  string | null,
       priority:     'high' | 'medium' | 'low' | null,
       status:       'open' | 'in_progress' | 'blocked' | 'done' | null,
                     // feat/editable-tasks-ui — the read shim's authoritative
                     // action_items.status column (a.status), threaded straight
                     // through RAW (unlike today-adapter.js's item.status, which
                     // stores the DERIVED label) — tasks.js's TasksRightDetail
                     // editors derive the display label themselves via
                     // FS.api.deriveStatus(row.status, row.audit.checked), same
                     // helper today.js uses. null for pre-migration items.
       deadline:     string | null,                // free text e.g. "Today 09:00"
       topic_title:  string,
       topic_category: string,
       work_class:   string | undefined,           // Q1 — parent topic's work_class,
                     // verbatim ('work'/'non_work'/undefined). A redacted topic's
                     // rows are omitted entirely before this point — see the
                     // `if (t.redacted) return;` guard above. Consumers must treat
                     // anything but the literal 'non_work' as work.
       user_name:    string,                       // owner of the report
       user_folder:  string,                       // folder form
       actionItemId: string | null,
                     // feat/editable-tasks-ui — durable action_items.id (a.id,
                     // read shim), the PATCH /api/org/action-items/{id} handle —
                     // same field today-adapter.js threads as item.actionItemId.
                     // null for any legacy/pre-migration item the shim hasn't
                     // stamped yet; TasksRightDetail's editors must treat null
                     // as "not editable" and never PATCH with it.
       siteId:       string | null,
                     // feat/editable-tasks-ui — org SITE UUID (org.getOrgSites()'s
                     // site_id space, NOT the legacy report-gateway site_id —
                     // see today-adapter.js's ctx.siteIdByName doc for the full
                     // "two id spaces" explanation), resolved from the report's
                     // site NAME via a one-shot getOrgSiteIdMap() fetched once per
                     // aggregator call (mirrors today.js's identically-named
                     // helper). Feeds the assignee picker's
                     // FS.api.org.getSiteMembers(row.siteId) call; null on a
                     // lookup miss degrades that picker to read-only.
       audit: {
         checked:    boolean,              // status === 'done', nothing else
         checked_by: string | null,        // a.updated_by_name, only when done
         checked_at: ISO string | null,    // a.updated_at, only when done
       }
     }

   Exported to:
     window.FS.api.tasks.getActionsResolvedRange({ from, to, user? })
   ========================================================================== */

(function () {
  'use strict';

  /* folder_name if present (fixtures + live /api/users alike), else
     derived client-side from name. Real /api/users returns only
     {device_id,name,role,sites} — no folder_name. */
  function deriveFolder(u) {
    return u.folder_name || (u.name ? u.name.replace(/ /g, '_') : '');
  }

  /* Resolve the user param honouring worker-forced-self, mirroring
     the rule used by today.js + activity.js. */
  function resolveUser(explicitUser) {
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
    if (caller.role === 'worker') {
      return caller.name ? window.FS.api.folderName(caller.name) : null;
    }
    if (explicitUser) return explicitUser;
    var isAdmin = caller.role === 'admin' || caller.role === 'gm' || caller.isAdmin;
    if (!isAdmin && caller.name) return window.FS.api.folderName(caller.name);
    return explicitUser || null;
  }

  /* Sourced from the real GET /api/users (report identity) — live =
     pass-through of /api/users, mock = fixtures (unchanged behaviour).
     Falls back to the fixtures read on any /api/users error. Mirrors
     compliance-aggregator.js's adminUserFolders(). */
  async function adminUserFolders() {
    /* No fixture fallback: a failed directory read propagates (mock-mode
       getUsers() returns the fixtures itself and never throws). */
    var usersRes = await window.FS.api.sites.getUsers();
    return ((usersRes && usersRes.users) || []).map(deriveFolder).filter(Boolean);
  }

  /* feat/editable-tasks-ui — org SITE UUID map (org.getOrgSites()'s site_id,
     the _toPageSite space — see today-adapter.js's ctx.siteIdByName doc for
     the full "two id spaces" explanation), keyed by report site NAME
     (report.site, the only site field a report carries). Feeds row.siteId
     (see the row-shape doc above), threaded to TasksRightDetail's assignee
     picker (FS.api.org.getSiteMembers(row.siteId)) the same way today.js
     threads it through today-adapter.js. Mirrors today.js's
     getOrgSiteIdMap() verbatim (own copy — same convention as
     adminUserFolders() above); any error collapses to an empty map so a
     lookup miss just yields row.siteId: null (degrade to read-only
     picker), never blocks the page. */
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

  async function getActionsResolvedRange(opts) {
    opts = opts || {};
    var from = opts.from, to = opts.to;
    if (!from || !to) return { rows: [], from: from, to: to };
    var user = resolveUser(opts.user);

    /* batch A2 Task 3 — opts.site is an EXPLICIT param passed by scoped
       callers only. NEVER read window.FS.siteContext in this function —
       the search palette (search-palette.js) calls this same export
       with no site and must keep its global, unscoped view. When a
       site IS given and the caller is neither a worker (forced-self
       path above, unaffected) nor pinned by an explicit opts.user,
       prefer the site fan-out below over the resolved single-self
       folder — getSiteUsers is server-side permission-scoped (a site
       manager's request returns self + their workers), so widening
       from "just me" to "my site" still respects the caller's ceiling. */
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
    if (opts.site && !opts.user && caller.role !== 'worker') user = null;

    /* 1) Discover days that actually have reports. Use getSpan() — the
       cached wide-discovery over the FULL report history (same underlying
       GET /api/dates as Evidence/Today use) — NOT a trailing getDates({
       months:3 }). The old 3-month cap silently hid every report older
       than ~3 months even when the range said "all": with data in Feb/Mar
       and "today" months later, the 'all' preset returned zero rows. The
       [from,to] filter below still bounds the fan-out for narrow presets. */
    var datesRes = await window.FS.api.window.getSpan();
    if (datesRes && datesRes._accessDenied) {
      return { _accessDenied: true, error: datesRes.error };
    }
    var datesMap = (datesRes && datesRes.dates) || {};
    var datesInRange = Object.keys(datesMap)
      /* hasReport ON PURPOSE (spec §4b) — fans out getTimeline per day;
         an uploads-only day has no report to fetch. */
      .filter(function (d) { return d >= from && d <= to && datesMap[d].hasReport; })
      .sort();

    if (datesInRange.length === 0) {
      return { rows: [], from: from, to: to, user: user };
    }

    /* 2) Fan out the timeline (the action source) per day.
       Sprint 8 follow-up — admin fan-out across all known users when
       no explicit user is provided, matching compliance-aggregator. */
    var isAdmin = caller.role === 'admin' || caller.role === 'gm' || !!caller.isAdmin;
    var folders = null;
    /* Batch A2 Task 3 — also fans out when opts.site is set (sm/pm
       site-scoped view, see comment above), sourcing folders from
       getSiteUsers instead of the full user list; falls back to the
       existing adminUserFolders() path on error. */
    if (!user && (isAdmin || opts.site)) {
      if (opts.site) {
        try {
          var siteUsersRes = await window.FS.api.sites.getSiteUsers(opts.site);
          folders = ((siteUsersRes && siteUsersRes.users) || []).map(deriveFolder).filter(Boolean);
        } catch (e) { folders = await adminUserFolders(); }
      } else {
        folders = await adminUserFolders();
      }
    }

    var timelinePromise;
    if (folders && folders.length > 0) {
      /* Pooled, not Promise.all: the cross-product reaches 150+ requests on
         the 'All' range — see FS.api.pooledAll. Failed fetches → null →
         filtered out (partial data beats a dead page). */
      var taskThunks = datesInRange.reduce(function (acc, d) {
        folders.forEach(function (f) {
          acc.push(function () {
            return window.FS.api.timeline.getTimeline({ date: d, user: f })
              .then(function (r) { return { date: d, report: r }; });
          });
        });
        return acc;
      }, []);
      timelinePromise = window.FS.api.pooledAll(taskThunks, 8).then(function (rs) {
        var out = rs.filter(Boolean);
        /* batch 2c Task 6 — all-failed → error, not a silently-empty page. */
        if (taskThunks.length > 0 && out.length === 0) {
          throw new Error('Could not load data — all requests failed. Please retry.');
        }
        return out;
      });
    } else {
      timelinePromise = Promise.all(datesInRange.map(function (d) {
        return window.FS.api.timeline.getTimeline({ date: d, user: user })
          .then(function (r) { return { date: d, report: r }; });
      }));
    }
    /* feat/editable-tasks-ui — fetched in parallel with the timeline
       fan-out above (cheap, one extra org call), never gating the rest of
       the load. */
    var siteIdMapPromise = getOrgSiteIdMap();

    var both = await Promise.all([timelinePromise, siteIdMapPromise]);
    var perDay = both[0];
    var siteIdMap = both[1];

    /* 3) Surface page-level access-denied only when the caller genuinely
       can't read anything.
       IB-1 fix — drop individual denied (date,folder) items
       and keep whatever came back accessible; a partial 403 degrades to
       "missing rows", not a dead page. Only surface _accessDenied if
       NOTHING accessible came back at all. */
    var deniedItems = perDay.filter(function (x) {
      return x.report && x.report._accessDenied;
    });
    if (deniedItems.length > 0) {
      perDay = perDay.filter(function (x) {
        return !(x.report && x.report._accessDenied);
      });
      if (perDay.length === 0) {
        return { _accessDenied: true, error: deniedItems[0].report.error };
      }
    }

    /* 4) Flatten into rows. Skip days where the report was not found,
       didn't materialise (admin disambiguation), or carried 0 topics. */
    var rows = [];
    perDay.forEach(function (x) {
      var r = x.report;
      if (!r || r._notFound || r.available_users) return;
      /* Report OWNER's folder — NOT the caller (AuthMock.currentUser). See
         plan §1.3/owner≠caller. Hoisted once per report for the id. */
      var folder = r.user_name ? window.FS.api.folderName(r.user_name) : null;
      /* feat/editable-tasks-ui — report.site is a DISPLAY NAME only (no
         slug/id travels with a report — same fact today-adapter.js
         documents); resolved once per report against siteIdMap. */
      var siteName = r.site || '';
      var siteId   = (siteName && siteIdMap[siteName]) || null;
      (r.topics || []).forEach(function (t) {
        /* Q1 — tier-aware Today/Tasks: a redacted topic is omitted from
           Tasks entirely — same rule today-adapter.js applies, no review
           control lives here so a redacted topic's action items simply
           never surface as rows. */
        if (t.redacted) return;
        (t.action_items || []).forEach(function (a, idx) {
          /* Done-ness is the task's own status column — nothing else. */
          var done = a.status === 'done';
          rows.push({
            id:             x.date + '_' + (folder || '') + '_' + t.topic_id + '_' + idx,
            date:           x.date,
            topic_id:       t.topic_id,
            action_index:   idx,
            action:         a.action,
            responsible:    a.responsible || null,
            priority:       a.priority || null,
            /* feat/editable-tasks-ui — raw action_items.status column, see
               the row-shape doc's `status` entry above. */
            status:         a.status || null,
            deadline:       a.deadline || null,
            topic_title:    t.topic_title,
            topic_category: t.category,
            /* Q1 — tier-aware Today/Tasks: the parent topic's work_class,
               verbatim (undefined/'work'/'non_work'). Consumers must
               treat anything other than the literal 'non_work' as work
               (`=== 'non_work'`, never `!== 'work'`) — mirrors the
               existing timeline "aurora" shape convention. */
            work_class:     t.work_class,
            user_name:      r.user_name,
            user_folder:    folder,
            /* feat/editable-tasks-ui — see the row-shape doc above. */
            actionItemId:   a.id || null,
            siteId:         siteId,
            audit: {
              checked:    done,
              checked_by: done ? (a.updated_by_name || null) : null,
              checked_at: done ? (a.updated_at || null) : null,
            },
          });
        });
      });
    });

    return { rows: rows, from: from, to: to, user: user, dates: datesInRange };
  }

  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};
  window.FS.api.tasks = {
    getActionsResolvedRange: getActionsResolvedRange,
  };

})();
