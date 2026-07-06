/* ==========================================================================
   FieldSight API · Compliance aggregator (Sprint 6.0)
   --------------------------------------------------------------------------
   Cross-day fan-out for the two compliance pages, /safety and /quality.

   Each call iterates every date with a report inside [from, to], pulls the
   timeline for the resolved user, and flattens the relevant compliance
   collection into a single rows[] array. Mirrors the shape and fan-out
   pattern of tasks-aggregator.js so both pages can render without
   re-doing the join.

   Two parallel exports:

     window.FS.api.compliance.getSafetyRange({ from, to, user? })
       → {
           rows: [
             {
               id:                  '<date>_<topic_id>_<source>_<idx>',
               date:                'YYYY-MM-DD',
               site:                string,
               user_name:           string,
               user_folder:         string,
               topic_id:            number,
               topic_title:         string,
               topic_category:      'safety' | 'progress' | 'quality',
               source:              'observation' | 'topic_flag' | 'manual',
               observation:         string,
               risk_level:          'high' | 'medium' | 'low',
               recommended_action:  string | null,
               location:            string | null,    // null for topic_flag/manual
               who_raised:          string | null,    // null for topic_flag/manual
               status:              'open' | 'resolved',  // see _AUDIT-2 below
               resolved_by:         string | null,
               resolved_at:         string | null,    // ISO
               // 'manual' rows (batch B Task 6, merged from org.getObservations)
               // additionally carry obs_id, author_sub, closed — see
               // toManualSafetyRow() below.
             }
           ],
           from, to, user, dates: [...]
         }

     window.FS.api.compliance.getQualityRange({ from, to, user? })
       → {
           rows: [
             {
               id:                  '<date>_<topic_id>_<source>_<idx>',
               date:                'YYYY-MM-DD',
               site:                string,
               user_name:           string,
               user_folder:         string,
               topic_id:            number,    // -1 for report-level Q&C items
               topic_title:         string,    // 'Quality & Compliance' synth title for report-level
               topic_category:      'quality' | 'progress' | 'safety',
               source:              'qc_item' | 'topic_quality' | 'manual',
               item:                string,        // headline
               status:               string,        // 'completed' | 'concern' | etc for
                                                      // qc_item; 'observed' | 'resolved'
                                                      // for topic_quality/manual (see _AUDIT-2)
               resolved_by:         string | null,   // topic_quality only
               resolved_at:         string | null,   // topic_quality only, ISO
               details:              string | null,
               follow_up_needed:    boolean,
               who_raised:          string | null,    // null for qc_item/manual
               // 'manual' rows (batch B Task 6, merged from org.getObservations)
               // additionally carry obs_id, author_sub, closed — see
               // toManualQualityRow() below.
             }
           ],
           from, to, user, dates: [...]
         }

   ─── _AUDIT (fixture audit notes) ─────────────────────────────────────────

   _AUDIT-1 · Fixture sparsity.
       dates.fixture.js advertises ~24 days with hasReport: true between
       early-March 2026 and 2026-04-29, BUT daily-report.fixture.js only
       carries one real report: 2026-04-29 / Jarley_Trainor. Every other
       day's getTimeline call returns _notFound. This aggregator handles
       that silently (skips _notFound days, mirrors tasks-aggregator
       line 110 behaviour) — UI will simply render 1 day's worth of
       rows for any range that includes 2026-04-29, and an empty list
       for any other range.

       Resolution: Sprint 7+ fixture expansion can populate adjacent
       days. No code change needed here.

   _AUDIT-2 · No `status` field on safety_observations or safety_flags.
       Schema (BACKEND-CONTEXT §5.1) doesn't carry a status —
       observations are append-only at capture time. UI needs an open/
       resolved split for the KPI strip.

       Task 2 (live-data fixes, 2026-07-03) — RESOLVED via piggyback.
       The deployed `toggle_action` accepts ANY string `action_index`
       (SK is an f-string, no validation), so flag rows join the
       existing GET /api/actions checked map instead of a literal:
         safety_observations → action_index = 'obs_<idx>'  under topic_id -1
         topic-level safety_flags → action_index = 'flag_<idx>' under the
           topic's own topic_id
         quality topic rows (topic_category==='quality', same synthetic-
           status gap) → action_index = 'quality' under the topic's own
           topic_id
       status = 'resolved' when the joined entry has checked:true, else
       the previous default ('open' for safety rows, 'observed' for
       quality topic rows). resolved_by/resolved_at carry checked_by/
       checked_at through when present. The actions map is fetched once
       per date (not per user) in fanoutDates() and joined per row; a
       fetch failure for a date degrades to an empty map for that date
       (rows show as unresolved) rather than failing the page.
       qc_item rows (source 'qc_item') are NOT joined — they already
       carry a real backend status (q.status), so a resolve toggle
       would overwrite honest data with a synthetic binary.

   _AUDIT-3 · Permission scope vs fan-out.
       resolveUser() clamps non-admin / non-gm callers to their own
       folder (matching tasks-aggregator.js:46-55). hse_manager has
       safety:view:org and *should* see org-wide flags, but in mock
       land we don't fan out across `available_users`. Behaviour
       parity with tasks-aggregator was prioritised over correctness;
       the fixture gap (1 author only) means it's not user-visible
       anyway. Sprint 7+ to revisit when fan-out gains real value.

   _AUDIT-4 · Field shapes confirmed.
       Every report fixture has: safety_observations (array),
       quality_and_compliance (array), and topics[].safety_flags
       (array, may be empty), and topics[].category (string).
       Verified against scripts/mock/daily-report.fixture.js:
       29-247 (single report).

   _AUDIT-5 · Generator duplicate observation-vs-flag (2026-07-03).
       Browser-confirmed: the real report generator sometimes writes the
       SAME safety event into BOTH arrays with paraphrased wording —
       e.g. "Worker entering clean area with muddy shoes risking damage
       to finished surfaces" (topics[].safety_flags[], locatable via
       topic_id) vs "Worker entering clean area with muddy shoes"
       (safety_observations[], topic_id -1 — "Open source report" can't
       trace it). getSafetyRange now drops the report-level observation
       row when it fuzzily matches a topic-flag row from the SAME
       report, keeping the topic-flag row. See isDuplicateObservation()
       below. Deliberately NOT applied topic-flag vs topic-flag —
       different topics may legitimately raise similar-sounding flags
       (e.g. two "loose bracing" issues on different levels).

   ────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  /* Resolve user respecting worker-forced-self — copy of
     tasks-aggregator.js:46-55 (intentional parity). */
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

  /* folder_name if present (fixtures + live /api/users alike), else
     derived client-side from name. Real /api/users returns only
     {device_id,name,role,sites} — no folder_name. */
  function deriveFolder(u) {
    return u.folder_name || (u.name ? u.name.replace(/ /g, '_') : '');
  }

  /* Sprint 8 follow-up — admin fan-out across all known users when no
     explicit user is provided. Without this, getTimeline(date, user=null)
     for admin returns the available_users disambiguation envelope, which
     downstream loops skip — yielding empty Tasks/Safety/Quality/Evidence
     pages for admin. We materialise (date × user) cross-product instead.

     Sourced from the real GET /api/users (report identity) via
     window.FS.api.sites.getUsers() — live = pass-through of /api/users,
     mock = fixtures (unchanged behaviour, since mock getUsers() already
     returns fixtures.sites.users with folder_name intact). Falls back to
     the fixtures read on any /api/users error, keeping the previous
     degraded behaviour instead of an empty fan-out. */
  async function adminUserFolders() {
    try {
      var res = await window.FS.api.sites.getUsers();
      return ((res && res.users) || []).map(deriveFolder).filter(Boolean);
    } catch (e) {
      var fx = (window.FieldSight && window.FieldSight.fixtures
        && window.FieldSight.fixtures.sites) || {};
      return (fx.users || []).map(deriveFolder).filter(Boolean);
    }
  }
  function isAdminCaller() {
    var c = (window.AuthMock && window.AuthMock.currentUser) || {};
    return c.role === 'admin' || c.role === 'gm' || !!c.isAdmin;
  }

  /* Internal: discover dates with reports in [from, to], then fan out
     getTimeline for each. Returns { perDay: [{date, report}], denied? }.

     batch A2 Task 3 — `site` (4th param) is an EXPLICIT argument passed
     down from getSafetyRange/getQualityRange; this function must NEVER
     read window.FS.siteContext itself. */
  async function fanoutDates(from, to, user, site) {
    var monthsLookback = (window.FS.api.window && window.FS.api.window.MONTHS_LOOKBACK) || 24;
    var datesRes = await window.FS.api.dates.getDates({ months: monthsLookback });
    if (datesRes && datesRes._accessDenied) {
      return { _accessDenied: true, error: datesRes.error };
    }
    var datesMap = (datesRes && datesRes.dates) || {};
    var datesInRange = Object.keys(datesMap)
      .filter(function (d) { return d >= from && d <= to && datesMap[d].hasReport; })
      .sort();

    if (datesInRange.length === 0) {
      return { perDay: [], dates: [], actionsByDate: {} };
    }

    /* Task 2 (live-data fixes) — fetch the checked-actions map for every
       date in the range, in parallel with the timeline fanout below, so
       flag/topic rows can join their real resolved status instead of a
       hard-coded literal. Actions are keyed by date only (not by user),
       so one fetch per unique date covers the admin cross-product too.
       Per-date failures are swallowed to an empty map — resilience over
       correctness of status (a flag simply shows as 'open' if the join
       fails, it never blocks the page). */
    var actionsByDatePromise = Promise.all(datesInRange.map(function (d) {
      return window.FS.api.actions.getActions(d)
        .then(function (res) { return { date: d, actions: (res && res.actions) || {} }; })
        .catch(function () { return { date: d, actions: {} }; });
    })).then(function (list) {
      var map = {};
      list.forEach(function (x) { map[x.date] = x.actions; });
      return map;
    });

    /* Admin path: cross-product (date × all users) so every report in
       the window gets included rather than being short-circuited by
       the available_users envelope. Batch A2 Task 3 — also taken when
       `site` is set (sm/pm site-scoped view, see getSafetyRange), in
       which case folders are scoped to that site via getSiteUsers
       (server-side permission-scoped) instead of the full user list. */
    if (!user && (isAdminCaller() || site)) {
      var folders;
      if (site) {
        try {
          var su = await window.FS.api.sites.getSiteUsers(site);
          folders = ((su && su.users) || []).map(deriveFolder).filter(Boolean);
        } catch (e) { folders = await adminUserFolders(); }
      } else {
        folders = await adminUserFolders();
      }
      /* Pooled, not Promise.all: the cross-product reaches 150+ requests on
         the 'All' range — see FS.api.pooledAll. Failed fetches → null →
         filtered out (partial data beats a dead page). */
      var adminThunks = datesInRange.reduce(function (acc, d) {
        folders.forEach(function (f) {
          acc.push(function () {
            return window.FS.api.timeline.getTimeline({ date: d, user: f })
              .then(function (r) { return { date: d, report: r }; });
          });
        });
        return acc;
      }, []);
      var perDayAdmin = (await window.FS.api.pooledAll(adminThunks, 8)).filter(Boolean);
      /* batch 2c Task 6 — every request failing (auth outage, hard throttle)
         should surface as an error, not render as a silently-empty page.
         Input of zero thunks (no dates/users) is a legitimate empty. */
      if (adminThunks.length > 0 && perDayAdmin.length === 0) {
        throw new Error('Could not load data — all requests failed. Please retry.');
      }
      var actionsByDateAdmin = await actionsByDatePromise;
      var deniedAdmin = perDayAdmin.filter(function (x) {
        return x.report && x.report._accessDenied;
      })[0];
      if (deniedAdmin) {
        return { _accessDenied: true, error: deniedAdmin.report.error };
      }
      return { perDay: perDayAdmin, dates: datesInRange, actionsByDate: actionsByDateAdmin };
    }

    var perDay = await Promise.all(datesInRange.map(function (d) {
      return window.FS.api.timeline.getTimeline({ date: d, user: user })
        .then(function (r) { return { date: d, report: r }; });
    }));
    var actionsByDate = await actionsByDatePromise;

    var deniedHit = perDay.filter(function (x) {
      return x.report && x.report._accessDenied;
    })[0];
    if (deniedHit) {
      return { _accessDenied: true, error: deniedHit.report.error };
    }

    return { perDay: perDay, dates: datesInRange, actionsByDate: actionsByDate };
  }

  /* ─── Dedup helpers (_AUDIT-5) ───────────────────────────────────────── */

  /* Lowercase, strip punctuation to spaces, collapse whitespace. Pure. */
  function normalizeObservationText(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenize(normalized) {
    return normalized ? normalized.split(' ') : [];
  }

  /* |intersection| / |union| over whitespace-split tokens. Pure. */
  function tokenJaccard(normA, normB) {
    var tokensA = tokenize(normA);
    var tokensB = tokenize(normB);
    if (!tokensA.length || !tokensB.length) return 0;
    var setA = {};
    tokensA.forEach(function (t) { setA[t] = true; });
    var setB = {};
    tokensB.forEach(function (t) { setB[t] = true; });
    var union = {};
    tokensA.concat(tokensB).forEach(function (t) { union[t] = true; });
    var intersectionCount = 0;
    Object.keys(setA).forEach(function (t) { if (setB[t]) intersectionCount += 1; });
    var unionCount = Object.keys(union).length;
    return unionCount === 0 ? 0 : intersectionCount / unionCount;
  }

  /* True when obsText (report-level safety_observations[] wording) is a
     near-duplicate of flagText (topics[].safety_flags[] wording) — see
     _AUDIT-5. Deterministic, cheap, pure. */
  function isDuplicateObservation(obsText, flagText) {
    var normA = normalizeObservationText(obsText);
    var normB = normalizeObservationText(flagText);
    if (!normA || !normB) return false;
    if (normA === normB) return true;
    if (normA.startsWith(normB) || normB.startsWith(normA)) return true;
    return tokenJaccard(normA, normB) >= 0.6;
  }

  /* ─── Manual observation merge (batch B Task 6) ─────────────────────────
     window.FS.api.org.getObservations() rows — {id, kind, site_slug,
     report_date, author_sub, author_name, observation, risk_level,
     recommended_action, status:'open'|'closed', archived_at, created_at}
     (api/org.js) — mapped 1:1 onto the existing safety/quality row shapes
     above so manual rows render through the SAME composites and right-
     detail panels as report-derived rows, with `source: 'manual'` as the
     only branch UI code needs. `status` is translated to the vocabulary
     each page's totalsFromRows()/STATUS_TONE already key on ('resolved'/
     'open' for safety, 'resolved'/'observed' for quality) so the KPI
     strip needs zero changes; the separate `closed` boolean (org API's
     own open/closed vocabulary) plus `obs_id`/`author_sub` are extra
     fields the right-detail Mark closed/Reopen action needs and aren't
     part of the report-derived shape.
     site_slug is passed through as-is, not resolved to a display name —
     matches the create-modal's own newFlag.site (safety-create-modal.js /
     quality-create-modal.js) which already does the same; resolving it
     would cost an extra org.getOrgSites() round trip on every range fetch
     for a cosmetic-only "sites affected" grouping difference. */
  function toManualSafetyRow(o) {
    return {
      id:                 o.id,
      date:               o.report_date,
      site:               o.site_slug || null,
      user_name:          o.author_name || null,
      user_folder:        o.author_name ? window.FS.api.folderName(o.author_name) : null,
      topic_id:           -1,
      topic_title:        'Site safety observations',
      topic_category:     'safety',
      source:             'manual',
      observation:        o.observation,
      risk_level:         o.risk_level,
      recommended_action: o.recommended_action || null,
      location:           null,
      who_raised:         null,
      status:             o.status === 'closed' ? 'resolved' : 'open',
      resolved_by:        null,
      resolved_at:        null,
      obs_id:             o.id,
      author_sub:         o.author_sub || null,
      closed:             o.status === 'closed',
    };
  }

  function toManualQualityRow(o) {
    return {
      id:               o.id,
      date:             o.report_date,
      site:             o.site_slug || null,
      user_name:        o.author_name || null,
      user_folder:      o.author_name ? window.FS.api.folderName(o.author_name) : null,
      topic_id:         -1,
      topic_title:      'Quality & Compliance',
      topic_category:   'quality',
      source:           'manual',
      item:             o.observation,
      status:           o.status === 'closed' ? 'resolved' : 'observed',
      resolved_by:      null,
      resolved_at:      null,
      details:          null,
      follow_up_needed: false,
      who_raised:       null,
      obs_id:           o.id,
      author_sub:       o.author_sub || null,
      closed:           o.status === 'closed',
    };
  }

  /* ─── Safety ─────────────────────────────────────────────────────────── */

  async function getSafetyRange(opts) {
    opts = opts || {};
    var from = opts.from, to = opts.to;
    if (!from || !to) return { rows: [], from: from, to: to };
    var user = resolveUser(opts.user);

    /* batch A2 Task 3 — opts.site is an EXPLICIT param passed by scoped
       callers only. NEVER read window.FS.siteContext in this function —
       Insights (insights-aggregator.js), the strategic dashboards
       (strategic-aggregator.js), and the search palette
       (search-palette.js) call this same export with no site and must
       keep their global, unscoped view. When a site IS given and the
       caller is neither a worker (forced-self path above, unaffected)
       nor pinned by an explicit opts.user, prefer the site fan-out in
       fanoutDates() over the resolved single-self folder — getSiteUsers
       is server-side permission-scoped (a site manager's request
       returns self + their workers), so widening from "just me" to
       "my site" still respects the caller's ceiling. */
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
    if (opts.site && !opts.user && caller.role !== 'worker') user = null;

    var fanout = await fanoutDates(from, to, user, opts.site);
    if (fanout._accessDenied) {
      return { _accessDenied: true, error: fanout.error };
    }

    var rows = [];
    fanout.perDay.forEach(function (x) {
      var r = x.report;
      if (!r || r._notFound || r.available_users) return;
      var folder = r.user_name ? window.FS.api.folderName(r.user_name) : null;
      var checkedMap = (fanout.actionsByDate && fanout.actionsByDate[x.date]) || {};

      /* b) Topic-level safety_flags — built FIRST (but appended after
         the observations below, preserving the original row order) so
         that (a)'s dedup pass has the full same-report flag set to
         compare against. Less rich than observations — no location/
         who, but carries topic context. Also surfaces related_photos
         so the /safety right panel can render them inline (Sprint
         6.6.3 — removes the round-trip to /timeline just to see the
         photos). Status joined the same way as (a), action_index =
         'flag_<idx>' under the topic's own topic_id. */
      var topicFlagRows = [];
      (r.topics || []).forEach(function (t) {
        (t.safety_flags || []).forEach(function (f, idx) {
          var entry = checkedMap[t.topic_id + '_flag_' + idx];
          var resolved = !!(entry && entry.checked);
          topicFlagRows.push({
            id:                 x.date + '_' + t.topic_id + '_flag_' + idx,
            date:               x.date,
            site:               r.site || null,
            user_name:          r.user_name || null,
            user_folder:        folder,
            topic_id:           t.topic_id,
            topic_title:        t.topic_title,
            topic_category:     t.category,
            source:             'topic_flag',
            observation:        f.observation,
            risk_level:         f.risk_level,
            recommended_action: f.recommended_action || null,
            location:           null,
            who_raised:         null,
            status:             resolved ? 'resolved' : 'open',  /* see _AUDIT-2 */
            resolved_by:        resolved ? (entry.checked_by || null) : null,
            resolved_at:        resolved ? (entry.checked_at || null) : null,
            related_photos:     (t.related_photos || []).slice(),
          });
        });
      });

      /* a) Report-level safety_observations (richer — has location +
         who_raised). Status is joined from the actions checked map,
         piggy-backing the existing toggle_action endpoint with
         action_index = 'obs_<idx>' under topic_id -1 (see _AUDIT-2 —
         these rows have no real status field, so 'open' is the
         default until a resolve toggle is recorded).

         _AUDIT-5 — drop this observation if it's a near-duplicate of
         any topic-flag row from the SAME report; keep the topic-flag
         row instead (it's locatable via topic_id, this one is not). */
      (r.safety_observations || []).forEach(function (o, idx) {
        var isDup = topicFlagRows.some(function (fr) {
          return isDuplicateObservation(o.observation, fr.observation);
        });
        if (isDup) return;

        var entry = checkedMap['-1_obs_' + idx];
        var resolved = !!(entry && entry.checked);
        rows.push({
          id:                 x.date + '_obs_' + idx,
          date:               x.date,
          site:               r.site || null,
          user_name:          r.user_name || null,
          user_folder:        folder,
          topic_id:           -1,
          topic_title:        'Site safety observations',
          topic_category:     'safety',
          source:             'observation',
          observation:        o.observation,
          risk_level:         o.risk_level,
          recommended_action: o.recommended_action || null,
          location:           o.location || null,
          who_raised:         o.who_raised || null,
          status:             resolved ? 'resolved' : 'open',  /* see _AUDIT-2 */
          resolved_by:        resolved ? (entry.checked_by || null) : null,
          resolved_at:        resolved ? (entry.checked_at || null) : null,
        });
      });

      rows.push.apply(rows, topicFlagRows);
    });

    /* batch B Task 6 — merge manual observations in AFTER the _AUDIT-5
       dedupe pass above, which only ever compares report-sourced rows
       against each other within the SAME report's forEach iteration —
       appending here means manual rows (unique ids, own `source`) are
       never touched by it, by construction, no dedupe change needed.
       This deliberately ALSO feeds Insights (insights-aggregator.js),
       the strategic dashboards, and the search palette — they all call
       getSafetyRange with no opts.site, so manual observations are real
       safety events and belong in that global, unscoped view too. The
       A2 iron rule still holds: site never comes from
       window.FS.siteContext here, only from the opts.site this function
       itself was called with. A fetch failure must never take the whole
       range down with it — report rows still render. */
    try {
      var manualRes = await window.FS.api.org.getObservations({
        kind: 'safety', from: from, to: to, site_slug: opts.site || undefined,
      });
      var manualRows = ((manualRes && manualRes.observations) || []).map(toManualSafetyRow);
      rows = rows.concat(manualRows);
    } catch (e) {
      console.warn('[compliance] manual observations unavailable — report rows only', e);
    }

    return { rows: rows, from: from, to: to, user: user, dates: fanout.dates };
  }

  /* ─── Quality ────────────────────────────────────────────────────────── */

  async function getQualityRange(opts) {
    opts = opts || {};
    var from = opts.from, to = opts.to;
    if (!from || !to) return { rows: [], from: from, to: to };
    var user = resolveUser(opts.user);

    /* batch A2 Task 3 — opts.site is an EXPLICIT param passed by scoped
       callers only. NEVER read window.FS.siteContext in this function —
       Insights, the strategic dashboards, and the search palette call
       this same export with no site and must keep their global,
       unscoped view (see getSafetyRange above for the full rationale).
       Same sm/pm-with-site preference: prefer the site fan-out over the
       resolved single-self folder when a site is given, the caller
       isn't a worker, and no explicit opts.user pinned the query. */
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
    if (opts.site && !opts.user && caller.role !== 'worker') user = null;

    var fanout = await fanoutDates(from, to, user, opts.site);
    if (fanout._accessDenied) {
      return { _accessDenied: true, error: fanout.error };
    }

    var rows = [];
    fanout.perDay.forEach(function (x) {
      var r = x.report;
      if (!r || r._notFound || r.available_users) return;
      var folder = r.user_name ? window.FS.api.folderName(r.user_name) : null;
      var checkedMap = (fanout.actionsByDate && fanout.actionsByDate[x.date]) || {};

      /* a) Report-level quality_and_compliance items. These carry a
         REAL backend status (q.status — 'completed'/'concern'/etc, not
         synthetic), so they are left untouched by the resolve/reopen
         join below — toggling would overwrite honest data with a fake
         binary. */
      (r.quality_and_compliance || []).forEach(function (q, idx) {
        rows.push({
          id:               x.date + '_qc_' + idx,
          date:             x.date,
          site:             r.site || null,
          user_name:        r.user_name || null,
          user_folder:      folder,
          topic_id:         -1,
          topic_title:      'Quality & Compliance',
          topic_category:   'quality',
          source:           'qc_item',
          item:             q.item,
          status:           q.status || 'unknown',
          details:          q.details || null,
          follow_up_needed: !!q.follow_up_needed,
          who_raised:       null,
        });
      });

      /* b) Topics tagged category === 'quality' — surface as a row each
         so the page covers both shapes. related_photos carried through
         for /quality right panel inline preview (Sprint 6.6.3). Status
         here IS synthetic (fixed 'observed', quality's equivalent of
         safety's _AUDIT-2 gap) — joined the same way as safety topic
         flags, piggy-backing action_index = 'quality' under the
         topic's own topic_id (one row per topic, no idx needed). */
      (r.topics || []).forEach(function (t) {
        if (t.category !== 'quality') return;
        var entry = checkedMap[t.topic_id + '_quality'];
        var resolved = !!(entry && entry.checked);
        rows.push({
          id:               x.date + '_' + t.topic_id + '_topic',
          date:             x.date,
          site:             r.site || null,
          user_name:        r.user_name || null,
          user_folder:      folder,
          topic_id:         t.topic_id,
          topic_title:      t.topic_title,
          topic_category:   t.category,
          source:           'topic_quality',
          item:             t.topic_title,
          status:           resolved ? 'resolved' : 'observed',
          resolved_by:      resolved ? (entry.checked_by || null) : null,
          resolved_at:      resolved ? (entry.checked_at || null) : null,
          details:          t.summary || null,
          follow_up_needed: false,
          who_raised:       (t.participants && t.participants[0]) || null,
          related_photos:   (t.related_photos || []).slice(),
        });
      });
    });

    /* batch B Task 6 — see the matching comment in getSafetyRange above;
       same rationale (dedupe exemption by construction, Insights/
       strategic/search global-view intent, A2 iron rule, never-throw). */
    try {
      var manualRes = await window.FS.api.org.getObservations({
        kind: 'quality', from: from, to: to, site_slug: opts.site || undefined,
      });
      var manualRows = ((manualRes && manualRes.observations) || []).map(toManualQualityRow);
      rows = rows.concat(manualRows);
    } catch (e) {
      console.warn('[compliance] manual observations unavailable — report rows only', e);
    }

    return { rows: rows, from: from, to: to, user: user, dates: fanout.dates };
  }

  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};
  window.FS.api.compliance = {
    getSafetyRange:  getSafetyRange,
    getQualityRange: getQualityRange,
    /* _AUDIT-5 — exposed for unit testing the fuzzy-match spec. */
    _dedupe: {
      normalizeObservationText: normalizeObservationText,
      tokenJaccard:             tokenJaccard,
      isDuplicateObservation:   isDuplicateObservation,
    },
  };

})();
