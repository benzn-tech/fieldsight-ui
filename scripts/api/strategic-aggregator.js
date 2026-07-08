/* ==========================================================================
   FieldSight API · Strategic aggregator
   --------------------------------------------------------------------------
   Sprint 9 (Track C). Powers the three strategic dashboards:
     • /portfolio  — construction_manager, last 30 days, per-project rollup
     • /regional   — gm, last quarter, per-site grouped by region
     • /executive  — director, last quarter, per-region + org KPI rollup

   Reuses compliance-aggregator.getSafetyRange() / getQualityRange() for
   safety + quality counts, then layers in:
     • Per-site team size (from sites.fixture.users)
     • Per-site distinct subcontractors active in the window
     • Synthetic completion_rate (derived from action_items.checked
       fraction over the window — read via tasks-aggregator)
     • Health score: A/B/C/D grade computed from a weighted blend of
       safety incident rate × completion rate × overdue-action rate

   Public API:
     window.FS.api.strategic.getProjectRollup({ from, to })
     window.FS.api.strategic.getRegionRollup({ from, to })
     window.FS.api.strategic.getOrgRollup({ from, to })

   Each returns:
     { projects | regions | org, range: { from, to } }
   where projects[] = [
     { site_id, name, region, region_name, location, client, ...,
       safety_count, quality_count, distinct_subs, team_size,
       completion_rate, overdue_count, health: 'A'|'B'|'C'|'D',
       trend: [{ date, value }]   // 14-day safety count for sparkline
     }
   ]

   No new backend endpoint — all derivation is client-side, layered
   on top of existing aggregators. Backend mirror flagged in PLAN §6
   "Backend wiring for Sprint 9 schema".

   feat 4c: getProjectRollup grew a LIVE path. When the org API is live
   (orgLive()), it fetches GET /api/org/rollup/portfolio (real per-site
   safety/action counts, keyed by ORG UUID) and merges it with
   org.getOrgSites() (name/location/client, same ORG UUID key — no slug
   bridge) into the SAME project row shape below, so RollupTable /
   projectColumns render unchanged. quality_count is always 0 live
   (leg-1 item store has no real quality count yet). region /
   region_name / project_value_nzd / team_size / distinct_subs /
   planned_completion aren't in the leg-1 payload — default gracefully
   (null/0/'—'). Envelope guard (denied/not-found/empty/thrown) falls
   back to the fixture-derived path below. getRegionRollup /
   getOrgRollup are UNCHANGED — still fixture-derived in both modes
   (leg-1 endpoint is portfolio/per-site only).
   ========================================================================== */

(function () {
  'use strict';

  /* Org API live gate (feat 4c): mirrors api/org.js's own orgLive() gate
     (that function is a private closure, not exported — every caller
     re-derives the same check). LIVE only when mocks are off AND the org
     base URL is configured AND api/org.js has loaded its export block. */
  function orgLive() {
    return !!(window.FS && window.FS.api && !window.FS.api.useMocks
      && window.FS.api.orgBaseUrl && window.FS.api.org);
  }

  /* ─── Health-score policy ────────────────────────────────────────── */

  /* Inputs each in [0,1]. The lower the safety + overdue + quality
     pressure, AND the higher the completion, the higher the score.
     Weights tuned so a project with 0 safety, 100% completion, no
     overdue → A; 5+ high-risk safety + < 50% completion + many
     overdue → D. */
  function computeHealthScore(metrics) {
    var safety   = metrics.safetyPressure  || 0;       /* 0 = clean, 1 = many */
    var quality  = metrics.qualityPressure || 0;
    var overdue  = metrics.overduePressure || 0;
    var complete = typeof metrics.completionRate === 'number'
      ? metrics.completionRate : 0.7;

    /* Composite 0..1 (1 = best). */
    var score = 1
      - (safety  * 0.40)
      - (quality * 0.20)
      - (overdue * 0.20)
      + ((complete - 0.5) * 0.20);

    if (score >= 0.80) return 'A';
    if (score >= 0.60) return 'B';
    if (score >= 0.40) return 'C';
    return 'D';
  }

  /* Convert raw counts to 0..1 pressure curves so the health-score
     formula above doesn't blow up when one site has 50 issues and
     another has 2. Saturates at thresholds chosen for our 3-site
     30-day demo dataset. */
  function pressure(count, saturationAt) {
    if (count <= 0) return 0;
    var ratio = count / saturationAt;
    return ratio > 1 ? 1 : ratio;
  }

  /* ─── Per-site rollup (used by all three views) ──────────────────── */

  async function buildPerSiteRollup(from, to) {
    var compliance = window.FS && window.FS.api && window.FS.api.compliance;
    var tasksAgg   = window.FS && window.FS.api && window.FS.api.tasks;
    if (!compliance || !tasksAgg) {
      return { projects: [], _error: 'aggregators not loaded' };
    }

    var fxRoot = (window.FieldSight && window.FieldSight.fixtures
      && window.FieldSight.fixtures.sites) || {};
    var sites    = fxRoot.sites    || [];
    var users    = fxRoot.users    || [];
    var regions  = fxRoot.regions  || [];

    /* Region lookup. */
    var regionsById = {};
    regions.forEach(function (r) { regionsById[r.id] = r; });

    /* Fan-out compliance + tasks over the window. Both aggregators
       already do `(date × all-users)` admin fan-out internally
       (Sprint 8 follow-up), so passing no `user` works for any
       caller with cross-site read perms (CM / GM / director / admin). */
    var safetyRes  = await compliance.getSafetyRange({  from: from, to: to });
    var qualityRes = await compliance.getQualityRange({ from: from, to: to });
    var tasksRes   = await tasksAgg.getActionsResolvedRange({ from: from, to: to });

    if (safetyRes && safetyRes._accessDenied)  return { _accessDenied: true, error: safetyRes.error };
    if (qualityRes && qualityRes._accessDenied) return { _accessDenied: true, error: qualityRes.error };
    if (tasksRes && tasksRes._accessDenied)     return { _accessDenied: true, error: tasksRes.error };

    var safetyRows  = (safetyRes  && safetyRes.rows)  || [];
    var qualityRows = (qualityRes && qualityRes.rows) || [];
    var taskRows    = (tasksRes   && tasksRes.rows)   || [];

    /* Build per-site buckets. */
    var byId = {};
    sites.forEach(function (s) {
      var teamSize = users.filter(function (u) {
        return u.primary_site === s.site_id
          || (u.sites || []).indexOf(s.site_id) >= 0;
      }).length;
      byId[s.site_id] = {
        site_id:        s.site_id,
        name:           s.name,
        location:       s.location || null,
        region:         s.region   || null,
        region_name:    (regionsById[s.region] || {}).name || null,
        client:         s.client   || null,
        project_value_nzd:   s.project_value_nzd  || null,
        planned_completion:  s.planned_completion || null,
        team_size:      teamSize,
        safety_count:   0,
        safety_high:    0,
        quality_count:  0,
        sub_set:        {},   /* will dedupe to count distinct subs */
        action_total:   0,
        action_done:    0,
        action_overdue: 0,
        trend:          [],   /* per-day safety count for sparkline */
      };
    });

    /* Walk safety rows. Match by `r.site` (display name) since the
       compliance aggregator carries site name not site_id. */
    function findBySiteName(name) {
      if (!name) return null;
      var hit = sites.filter(function (s) { return s.name === name; })[0];
      return hit ? byId[hit.site_id] : null;
    }

    safetyRows.forEach(function (r) {
      var b = findBySiteName(r.site);
      if (!b) return;
      b.safety_count += 1;
      if ((r.risk_level || '').toLowerCase() === 'high') b.safety_high += 1;
      if (r.subcontractor_id) b.sub_set[r.subcontractor_id] = true;
    });
    qualityRows.forEach(function (r) {
      var b = findBySiteName(r.site);
      if (!b) return;
      b.quality_count += 1;
      if (r.subcontractor_id) b.sub_set[r.subcontractor_id] = true;
    });

    /* Walk task rows for completion + overdue counts. */
    var todayISO = window.FS.api.todayNZDT();
    taskRows.forEach(function (r) {
      var siteName = r.site || (r.user_name ? null : null);
      var b = findBySiteName(siteName);
      /* Tasks aggregator carries site sometimes empty; fallback by
         user → primary_site. */
      if (!b && r.user_folder) {
        var u = users.filter(function (x) { return x.folder_name === r.user_folder; })[0];
        if (u && u.primary_site) b = byId[u.primary_site] || null;
      }
      if (!b) return;
      b.action_total += 1;
      var checked = !!(r.audit && r.audit.checked);
      if (checked) {
        b.action_done += 1;
      } else if (r.deadline && /^\d{4}-\d{2}-\d{2}$/.test(r.deadline) && r.deadline < todayISO) {
        b.action_overdue += 1;
      }
    });

    /* Build trend (per-day safety count) for each site. */
    var trendDates = [];
    var d = from;
    while (d && d <= to) {
      trendDates.push(d);
      d = window.FS.api.addDaysISO(d, 1);
      if (!d) break;
      if (trendDates.length > 90) break;  /* safety cap */
    }
    Object.keys(byId).forEach(function (sid) {
      var b = byId[sid];
      var perDay = {};
      trendDates.forEach(function (dd) { perDay[dd] = 0; });
      safetyRows.forEach(function (r) {
        var hit = findBySiteName(r.site);
        if (hit && hit.site_id === sid && perDay[r.date] != null) {
          perDay[r.date] += 1;
        }
      });
      b.trend = trendDates.map(function (dd) {
        return { date: dd, value: perDay[dd] || 0 };
      });
    });

    /* Finalise — convert sub_set → distinct count, compute
       completion_rate + health. */
    var projects = Object.keys(byId).map(function (sid) {
      var b = byId[sid];
      var distinctSubs = Object.keys(b.sub_set).length;
      var completionRate = b.action_total > 0 ? (b.action_done / b.action_total) : 0.7;
      var safetyPressure  = pressure(b.safety_high * 2 + (b.safety_count - b.safety_high), 10);
      var qualityPressure = pressure(b.quality_count, 8);
      var overduePressure = pressure(b.action_overdue, 5);
      var health = computeHealthScore({
        safetyPressure:  safetyPressure,
        qualityPressure: qualityPressure,
        overduePressure: overduePressure,
        completionRate:  completionRate,
      });
      return {
        site_id:           b.site_id,
        name:              b.name,
        location:          b.location,
        region:            b.region,
        region_name:       b.region_name,
        client:            b.client,
        project_value_nzd: b.project_value_nzd,
        planned_completion:b.planned_completion,
        team_size:         b.team_size,
        safety_count:      b.safety_count,
        safety_high:       b.safety_high,
        quality_count:     b.quality_count,
        distinct_subs:     distinctSubs,
        action_total:      b.action_total,
        action_done:       b.action_done,
        action_overdue:    b.action_overdue,
        completion_rate:   completionRate,
        health:            health,
        trend:             b.trend,
      };
    });

    /* Sort: D first (worst), then C, B, A — health-grade descending
       severity. Within same grade, descending safety_count. */
    var GRADE_ORDER = { D: 0, C: 1, B: 2, A: 3 };
    projects.sort(function (a, b) {
      var go = GRADE_ORDER[a.health] - GRADE_ORDER[b.health];
      if (go !== 0) return go;
      return b.safety_count - a.safety_count;
    });

    return { projects: projects, range: { from: from, to: to } };
  }

  /* ─── LIVE per-site rollup (feat 4c) — merges real counts + org
     metadata by ORG UUID, no slug bridge ────────────────────────────── */

  var STATUS_TO_HEALTH = { green: 'A', yellow: 'C', red: 'D' };
  var GRADE_ORDER_LIVE  = { D: 0, C: 1, B: 2, A: 3 };

  /* Returns { projects } on success, or null when the caller should fall
     back to the fixture-derived path (access denied / not found / empty
     rollup / any thrown error — network, malformed payload, etc). Never
     throws — getProjectRollup relies on that to decide fixture fallback. */
  async function buildLiveProjectRollup() {
    var org = window.FS && window.FS.api && window.FS.api.org;
    if (!org || !org.getPortfolioRollup || !org.getOrgSites) return null;

    try {
      var rollupRes = await org.getPortfolioRollup();
      if (!rollupRes || rollupRes._accessDenied || rollupRes._notFound) return null;
      var rollupSites = rollupRes.sites || [];
      if (rollupSites.length === 0) return null;   /* empty → fixture fallback */

      var sitesRes = await org.getOrgSites();
      if (!sitesRes || sitesRes._accessDenied || sitesRes._notFound) return null;
      var orgSites = sitesRes.sites || [];
      var metaById = {};
      orgSites.forEach(function (s) { metaById[s.site_id] = s; });

      var projects = rollupSites.map(function (r) {
        var meta = metaById[r.site_id] || {};
        var actionTotal   = r.total_actions   || 0;
        var openActions   = r.open_actions    || 0;
        var actionDone    = Math.max(0, actionTotal - openActions);
        var completionRate = actionTotal > 0 ? (actionDone / actionTotal) : 0;
        return {
          site_id:            r.site_id,
          name:               meta.name || r.site_id,
          location:           meta.location || null,
          region:             null,               /* fixture-only, not in leg-1 payload */
          region_name:        null,                /* fixture-only, not in leg-1 payload */
          client:             meta.client || null,
          project_value_nzd:  null,                /* fixture-only, not in leg-1 payload */
          planned_completion: '—',                 /* fixture-only, not in leg-1 payload */
          team_size:          0,                   /* fixture-only, not in leg-1 payload */
          safety_count:       r.open_safety      || 0,
          safety_high:        r.open_high_safety || 0,
          quality_count:      0,                   /* leg-1 item store has no real quality count yet */
          distinct_subs:      0,                   /* fixture-only, not in leg-1 payload */
          action_total:       actionTotal,
          action_done:        actionDone,
          action_overdue:     r.overdue_actions || 0,
          completion_rate:    completionRate,
          health:             STATUS_TO_HEALTH[r.status] || 'C',
          status:             r.status || null,     /* raw backend status, harmless passthrough */
          trend:              [],                   /* leg-1 has no trend series */
        };
      });

      /* Same sort as the fixture path: worst health first, then
         descending safety_count within a grade. */
      projects.sort(function (a, b) {
        var go = GRADE_ORDER_LIVE[a.health] - GRADE_ORDER_LIVE[b.health];
        if (go !== 0) return go;
        return b.safety_count - a.safety_count;
      });

      return { projects: projects };
    } catch (e) {
      return null;   /* network / parse error — fixture fallback */
    }
  }

  async function getProjectRollup(opts) {
    opts = opts || {};
    if (orgLive()) {
      var live = await buildLiveProjectRollup();
      if (live) return { projects: live.projects, range: { from: opts.from, to: opts.to } };
      /* live path unavailable/empty/denied — fall through to the
         existing fixture-derived path below (don't crash, don't blank). */
    }
    return buildPerSiteRollup(opts.from, opts.to);
  }

  /* ─── Region rollup — group projects by region ───────────────────── */

  async function getRegionRollup(opts) {
    opts = opts || {};
    var base = await buildPerSiteRollup(opts.from, opts.to);
    if (base._accessDenied) return base;

    var byRegion = {};
    var fxRoot   = (window.FieldSight && window.FieldSight.fixtures
      && window.FieldSight.fixtures.sites) || {};
    (fxRoot.regions || []).forEach(function (r) {
      byRegion[r.id] = {
        region_id:     r.id,
        name:          r.name,
        country:       r.country,
        projects:      [],
        site_count:    0,
        team_size:     0,
        safety_count:  0,
        quality_count: 0,
        distinct_subs: 0,
        sub_set:       {},
        completion_rate_weighted: 0,
        action_total:  0,
        action_done:   0,
        action_overdue:0,
      };
    });
    /* Catch-all for projects with no region assigned. */
    byRegion.__none = {
      region_id: '__none', name: 'Unassigned', country: null,
      projects: [], site_count: 0, team_size: 0, safety_count: 0,
      quality_count: 0, distinct_subs: 0, sub_set: {},
      completion_rate_weighted: 0, action_total: 0, action_done: 0,
      action_overdue: 0,
    };

    base.projects.forEach(function (p) {
      var key = p.region || '__none';
      var r   = byRegion[key];
      if (!r) {
        byRegion[key] = {
          region_id: key, name: key, country: null,
          projects: [], site_count: 0, team_size: 0, safety_count: 0,
          quality_count: 0, distinct_subs: 0, sub_set: {},
          completion_rate_weighted: 0, action_total: 0, action_done: 0,
          action_overdue: 0,
        };
        r = byRegion[key];
      }
      r.projects.push(p);
      r.site_count    += 1;
      r.team_size     += p.team_size;
      r.safety_count  += p.safety_count;
      r.quality_count += p.quality_count;
      r.action_total  += p.action_total;
      r.action_done   += p.action_done;
      r.action_overdue += p.action_overdue;
    });

    /* Finalise — derive distinct subs (re-walk safety + quality
       per region) + weighted completion rate. */
    var regions = Object.keys(byRegion).map(function (k) {
      var r = byRegion[k];
      r.completion_rate_weighted = r.action_total > 0
        ? (r.action_done / r.action_total) : 0.7;
      r.distinct_subs = Object.keys(r.sub_set).length;
      delete r.sub_set;
      /* Health: take the worst grade among projects in the region. */
      var GRADE_ORDER = { D: 0, C: 1, B: 2, A: 3 };
      r.health = (r.projects.length > 0)
        ? r.projects.map(function (p) { return p.health; })
            .sort(function (a, b) { return GRADE_ORDER[a] - GRADE_ORDER[b]; })[0]
        : 'A';
      /* Trend = sum across projects per day. */
      if (r.projects.length > 0) {
        var trendDates = r.projects[0].trend.map(function (t) { return t.date; });
        r.trend = trendDates.map(function (dd, idx) {
          var sum = r.projects.reduce(function (acc, p) {
            return acc + ((p.trend[idx] && p.trend[idx].value) || 0);
          }, 0);
          return { date: dd, value: sum };
        });
      } else {
        r.trend = [];
      }
      return r;
    }).filter(function (r) { return r.site_count > 0; })
      .sort(function (a, b) { return b.safety_count - a.safety_count; });

    return { regions: regions, range: { from: opts.from, to: opts.to } };
  }

  /* ─── Org rollup — single org-wide aggregate ─────────────────────── */

  async function getOrgRollup(opts) {
    opts = opts || {};
    var regionRes = await getRegionRollup(opts);
    if (regionRes._accessDenied) return regionRes;
    var regions = regionRes.regions || [];

    var totals = regions.reduce(function (acc, r) {
      acc.site_count    += r.site_count;
      acc.team_size     += r.team_size;
      acc.safety_count  += r.safety_count;
      acc.quality_count += r.quality_count;
      acc.action_total  += r.action_total;
      acc.action_done   += r.action_done;
      acc.action_overdue += r.action_overdue;
      return acc;
    }, {
      site_count: 0, team_size: 0, safety_count: 0, quality_count: 0,
      action_total: 0, action_done: 0, action_overdue: 0,
    });
    totals.completion_rate_weighted = totals.action_total > 0
      ? (totals.action_done / totals.action_total) : 0.7;

    /* Project value sum (from per-site fixture). */
    var fxRoot = (window.FieldSight && window.FieldSight.fixtures
      && window.FieldSight.fixtures.sites) || {};
    totals.project_value_nzd = (fxRoot.sites || []).reduce(function (acc, s) {
      return acc + (s.project_value_nzd || 0);
    }, 0);

    /* Org trend = sum of region trends. */
    var orgTrend = [];
    if (regions.length > 0 && regions[0].trend && regions[0].trend.length > 0) {
      var trendDates = regions[0].trend.map(function (t) { return t.date; });
      orgTrend = trendDates.map(function (dd, idx) {
        var sum = regions.reduce(function (acc, r) {
          return acc + ((r.trend[idx] && r.trend[idx].value) || 0);
        }, 0);
        return { date: dd, value: sum };
      });
    }

    /* Org health = worst region grade. */
    var GRADE_ORDER = { D: 0, C: 1, B: 2, A: 3 };
    var orgHealth = regions.length > 0
      ? regions.map(function (r) { return r.health; })
          .sort(function (a, b) { return GRADE_ORDER[a] - GRADE_ORDER[b]; })[0]
      : 'A';

    return {
      org: {
        name: 'FieldSight (NZ)',
        totals: totals,
        health: orgHealth,
        regions: regions,
        trend: orgTrend,
      },
      range: { from: opts.from, to: opts.to },
    };
  }

  if (!window.FS)         window.FS = {};
  if (!window.FS.api)     window.FS.api = {};
  window.FS.api.strategic = {
    getProjectRollup: getProjectRollup,
    getRegionRollup:  getRegionRollup,
    getOrgRollup:     getOrgRollup,
  };

})();
