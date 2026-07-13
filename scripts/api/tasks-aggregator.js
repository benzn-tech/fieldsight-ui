/* ==========================================================================
   FieldSight API · Tasks aggregator (Sprint 4.2)
   --------------------------------------------------------------------------
   Joins two existing data shapes into a single flat list the Tasks
   page can render without re-doing the join itself:

     • Action SOURCE    — lives inside daily-report topics
                          (text, responsible, deadline, priority)
     • Audit OVERLAY    — /api/actions per date
                          (checked, checked_by, checked_at)

   Single stable contract, regardless of mock vs real backend or
   whether a future `/api/actions/all` endpoint is added — UI
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
       deadline:     string | null,                // free text e.g. "Today 09:00"
       topic_title:  string,
       topic_category: string,
       user_name:    string,                       // owner of the report
       user_folder:  string,                       // folder form
       audit: {
         checked:    boolean,
         checked_by: string | null,
         checked_at: ISO string | null,
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
    try {
      var usersRes = await window.FS.api.sites.getUsers();
      return ((usersRes && usersRes.users) || []).map(deriveFolder).filter(Boolean);
    } catch (e) {
      return ((window.FieldSight && window.FieldSight.fixtures
          && window.FieldSight.fixtures.sites && window.FieldSight.fixtures.sites.users) || [])
          .map(deriveFolder).filter(Boolean);
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
      .filter(function (d) { return d >= from && d <= to && datesMap[d].hasReport; })
      .sort();

    if (datesInRange.length === 0) {
      return { rows: [], from: from, to: to, user: user };
    }

    /* 2) Fan out timeline (action source) AND actions (audit) per day,
       in parallel.
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
    var auditPromise = window.FS.api.actions.getActionsRange({
      from: datesInRange[0], to: datesInRange[datesInRange.length - 1],
    });

    var both = await Promise.all([timelinePromise, auditPromise]);
    var perDay = both[0];
    var auditRange = both[1];

    /* 3) Surface page-level access-denied if either fan-out hit it. */
    if (auditRange && auditRange._accessDenied) {
      return { _accessDenied: true, error: auditRange.error };
    }
    var deniedHit = perDay.filter(function (x) {
      return x.report && x.report._accessDenied;
    })[0];
    if (deniedHit) {
      return { _accessDenied: true, error: deniedHit.report.error };
    }

    /* 4) Flatten into rows. Skip days where the report was not found,
       didn't materialise (admin disambiguation), or carried 0 topics. */
    var auditByDate = (auditRange && auditRange.byDate) || {};
    var rows = [];
    perDay.forEach(function (x) {
      var r = x.report;
      if (!r || r._notFound || r.available_users) return;
      /* Report OWNER's folder — NOT the caller (AuthMock.currentUser). See
         plan §1.3/owner≠caller. Hoisted once per report for the id + the
         lookupAction() call below. */
      var folder = r.user_name ? window.FS.api.folderName(r.user_name) : null;
      (r.topics || []).forEach(function (t) {
        (t.action_items || []).forEach(function (a, idx) {
          var key = window.FS.api.actions.lookupAction(auditByDate[x.date], folder, t.topic_id, idx) || {};
          rows.push({
            id:             x.date + '_' + (folder || '') + '_' + t.topic_id + '_' + idx,
            date:           x.date,
            topic_id:       t.topic_id,
            action_index:   idx,
            action:         a.action,
            responsible:    a.responsible || null,
            priority:       a.priority || null,
            deadline:       a.deadline || null,
            topic_title:    t.topic_title,
            topic_category: t.category,
            user_name:      r.user_name,
            user_folder:    folder,
            audit: {
              checked:    !!key.checked,
              checked_by: key.checked_by || null,
              checked_at: key.checked_at || null,
            },
          });
        });
      });
    });

    return { rows: rows, from: from, to: to, user: user, dates: datesInRange };
  }

  /* ────────────────────────────────────────────────────────────────────
     Sprint 11 C.1 — getCrossDayAudit({from, to, user})
     --------------------------------------------------------------------
     Mock spec for the future endpoint
       GET /api/actions/all?from=YYYY-MM-DD&to=YYYY-MM-DD&user=<folder>
     Returns: { entries: [...], from, to, user }
       entry = {
         action_id:        '<date>_<key>',                       // unique
         topic_action_key: '<user_folder>|<topic_id>_<action_index>'  // groups
                            // same logical action across dates. Composite
                            // (user-dim audit key) when the underlying audit
                            // map key has a folder segment; bare
                            // '<topic_id>_<action_index>' for true legacy
                            // (unmigrated) records — see plan §1.2/§1.3.
         user_folder:      string | null,                        // parsed
                                                                 // from the
                                                                 // composite
                                                                 // key, null
                                                                 // for legacy
         date:             'YYYY-MM-DD',
         topic_id, action_index,
         checked, checked_by, checked_at,
       }

     Cross-day flatten of `actions.getActionsRange`'s `{byDate}` shape so
     /today's WeeklyCompletionKpi and /tasks's history drawer can iterate
     a single flat array. Pure data — no timeline / report join (use
     `getActionsResolvedRange` for that).

     Backend wiring (Sprint 12+): drop the localStorage-backed
     `actions.getActionsRange` fan-out and replace with one
     `GET /api/actions/all` call returning the same shape. UI is
     unchanged.
     ────────────────────────────────────────────────────────────────── */

  async function getCrossDayAudit(opts) {
    opts = opts || {};
    var from = opts.from;
    var to   = opts.to;
    if (!from || !to) {
      return { entries: [], from: from, to: to };
    }

    var user      = resolveUser(opts.user);
    var auditRes  = await window.FS.api.actions.getActionsRange({
      from: from, to: to,
    });
    if (auditRes && auditRes._accessDenied) {
      return { _accessDenied: true, error: auditRes.error };
    }

    var byDate  = (auditRes && auditRes.byDate) || {};
    var entries = [];
    Object.keys(byDate).sort().forEach(function (date) {
      var dayActions = byDate[date] || {};
      Object.keys(dayActions).forEach(function (key) {
        var rec = dayActions[key] || {};
        /* User-dim audit key (plan §1.3): split on the FIRST '|'. Composite
           keys are '<user_folder>|<tid>_<idx>'; true legacy (unmigrated)
           records have no '|' at all — folder stays null and bare === key. */
        var pipeAt  = key.indexOf('|');
        var folder  = pipeAt === -1 ? null : key.slice(0, pipeAt);
        var bare    = pipeAt === -1 ? key  : key.slice(pipeAt + 1);
        var parts   = bare.split('_');
        entries.push({
          action_id:        date + '_' + key,
          topic_action_key: key,
          user_folder:      folder,
          date:             date,
          topic_id:         parseInt(parts[0], 10),
          action_index:     parseInt(parts[1], 10),
          checked:          !!rec.checked,
          checked_by:       rec.checked_by || null,
          checked_at:       rec.checked_at || null,
        });
      });
    });

    return { entries: entries, from: from, to: to, user: user };
  }

  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};
  window.FS.api.tasks = {
    getActionsResolvedRange: getActionsResolvedRange,
    getCrossDayAudit:        getCrossDayAudit,
  };

})();
