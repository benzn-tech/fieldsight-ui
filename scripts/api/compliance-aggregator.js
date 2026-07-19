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
               source:              'observation' | 'topic_flag' | 'manual' | 'live',
               observation:         string,
               risk_level:          'high' | 'medium' | 'low',
               recommended_action:  string | null,
               location:            string | null,    // null for topic_flag/manual/live
               who_raised:          string | null,    // null for topic_flag/manual/live
               status:              'open' | 'resolved',  // see _AUDIT-2 below
               resolved_by:         string | null,
               resolved_at:         string | null,    // ISO
               // 'manual' rows (batch B Task 6, merged from org.getObservations)
               // additionally carry obs_id, author_sub, closed — see
               // toManualSafetyRow() below.
               // 'live' rows (feat 4b, merged from org.getLiveItems)
               // additionally carry obs_id, closed — see toLiveSafetyRow()
               // below.
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
               source:              'qc_item' | 'topic_quality' | 'manual' | 'live',
               item:                string,        // headline
               status:               string,        // 'completed' | 'concern' | etc for
                                                      // qc_item; 'observed' | 'resolved'
                                                      // for topic_quality/manual (see _AUDIT-2);
                                                      // fixed 'observed' for live (v1, see
                                                      // toLiveQualityRow)
               resolved_by:         string | null,   // topic_quality only
               resolved_at:         string | null,   // topic_quality only, ISO
               details:              string | null,
               follow_up_needed:    boolean,
               who_raised:          string | null,    // null for qc_item/manual/live
               // 'manual' rows (batch B Task 6, merged from org.getObservations)
               // additionally carry obs_id, author_sub, closed — see
               // toManualQualityRow() below.
               // 'live' rows (feat 4b, merged from org.getLiveItems) — see
               // toLiveQualityRow() below.
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

  /* authority flip (pipeline plan 2026-07-14) — true when the aurora
     timeline shim is live (kill switch: only when orgBaseUrl is ALSO
     set). Shared by both live-merge legs below (getSafetyRange /
     getQualityRange) so the gate condition lives in exactly one place. */
  function timelineIsAurora() {
    return window.FS.api.timelineSource === 'aurora' && !!window.FS.api.orgBaseUrl;
  }

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
       hard-coded literal. The per-date map already holds every user's rows (composite user_folder|topic_id_action_index keys, joined per-row via FS.api.actions.lookupAction() — Task 8, 2026-07-13-user-dimension-audit-key.md),
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
      /* IB-1 fix — drop individual denied (date,folder) reports and keep
         whatever came back accessible; only surface _accessDenied if
         NOTHING accessible came back at all. */
      var deniedAdminItems = perDayAdmin.filter(function (x) {
        return x.report && x.report._accessDenied;
      });
      if (deniedAdminItems.length > 0) {
        perDayAdmin = perDayAdmin.filter(function (x) {
          return !(x.report && x.report._accessDenied);
        });
        if (perDayAdmin.length === 0) {
          return { _accessDenied: true, error: deniedAdminItems[0].report.error };
        }
      }
      return { perDay: perDayAdmin, dates: datesInRange, actionsByDate: actionsByDateAdmin };
    }

    var perDay = await Promise.all(datesInRange.map(function (d) {
      return window.FS.api.timeline.getTimeline({ date: d, user: user })
        .then(function (r) { return { date: d, report: r }; });
    }));
    var actionsByDate = await actionsByDatePromise;

    /* IB-1 fix — drop individual denied (date,folder) reports and keep
       whatever came back accessible; only surface _accessDenied if
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

  /* ─── Live-items merge (feat 4b) ─────────────────────────────────────────
     window.FS.api.org.getLiveItems({date}) rows — { topics: [{id, site_id,
     site_name, user_name, category, title, summary, report_date,
     occurred_at, action_items, safety_observations, is_live}] } (api/org.js)
     — session-sourced live extraction, not yet superseded by the nightly
     report. Mapped onto the same row shapes as toManualSafetyRow/
     toManualQualityRow above, `source: 'live'`, topic_id pinned to -1 like
     the manual rows (there's no matching /timeline topic to deep-link to —
     live items are a separate feed, not part of a report) while
     topic_title carries the REAL topic.title (unlike manual's synthetic
     title) since that's the only descriptive label available. site is
     topic.site_name — a display string, matching every other row's `site`
     field (report rows carry r.site the same way).

     Fable-review F2 — opts.site IS NOT topic.site_id: opts.site is the
     report-side SLUG (window.FS.siteContext / FS.api.sites.getSites()
     site_id, e.g. 'sb1108-ellesmere'), while topic.site_id is an ORG
     UUID — they never match, so a naive site_id compare silently drops
     every live row in a site-scoped view. See resolveSiteNameForFilter()
     below: filtering happens against topic.site_name instead, after
     resolving the opts.site slug → display name once via the report-
     side site list. */
  function computeLiveDates(from, to, fanoutDates) {
    /* Fable-review F1 — live items exist for TODAY and other
       not-yet-reported dates by definition (a live extraction precedes
       its nightly report), so the live-fetch date set must be built
       INDEPENDENTLY of fanout.dates (report-having dates only) — otherwise
       today silently has no live rows until the nightly report lands.
       Enumerate every date in [from, min(to, todayNZDT())] inclusive
       (BUG-19 — string iteration via addDaysISO, never
       new Date('YYYY-MM-DD')), unioned with fanout.dates as a defensive
       backstop (covers any report-day fixture data that lands after the
       today clamp). */
    var todayISO = window.FS.api.todayNZDT();
    var liveTo = to < todayISO ? to : todayISO;
    var set = {};
    if (from <= liveTo) {
      var d = from;
      while (d <= liveTo) {
        set[d] = true;
        d = window.FS.api.addDaysISO(d, 1);
        if (!d) break;
      }
    }
    (fanoutDates || []).forEach(function (d) { set[d] = true; });
    return Object.keys(set).sort();
  }

  /* Fable-review F2 — bridge the report-side site SLUG (opts.site) to the
     org-side display NAME so it can be compared against topic.site_name
     (see the live-items doc comment above for the full slug↔UUID identity
     gap). Returns null when unset OR when the lookup misses; callers MUST
     treat null as "no filter" (keep all rows), never as "match nothing" —
     the live-items endpoint is already ACL-scoped server-side to sites the
     caller can see, so over-showing on a lookup miss is strictly safer
     than the previous drop-everything bug. */
  async function resolveSiteNameForFilter(site) {
    if (!site) return null;
    try {
      var res = await window.FS.api.sites.getSites();
      var match = ((res && res.sites) || []).filter(function (s) {
        return s.site_id === site;
      })[0];
      return match ? match.name : null;
    } catch (e) {
      return null;
    }
  }
  function toLiveSafetyRow(topic, o) {
    return {
      id:                 'live_' + o.id,
      date:               topic.report_date,
      site:               topic.site_name || null,
      user_name:          topic.user_name || null,
      user_folder:        topic.user_name ? window.FS.api.folderName(topic.user_name) : null,
      topic_id:           -1,
      topic_title:        topic.title,
      topic_category:     'safety',
      source:             'live',
      observation:        o.observation,
      risk_level:         o.risk_level,
      recommended_action: null,
      location:           o.location || null,
      who_raised:         null,
      status:             o.status === 'closed' ? 'resolved' : 'open',
      resolved_by:        null,
      resolved_at:        null,
      obs_id:             o.id,
      closed:             o.status === 'closed',
    };
  }

  /* Coarse v1 — the live quality signal is the topic itself (no per-item
     breakdown yet, unlike safety_observations[]), so one row per is_live
     quality-category topic, mirroring toManualQualityRow's shape. */
  function toLiveQualityRow(topic) {
    return {
      id:               'live_' + topic.id,
      date:             topic.report_date,
      site:             topic.site_name || null,
      user_name:        topic.user_name || null,
      user_folder:      topic.user_name ? window.FS.api.folderName(topic.user_name) : null,
      topic_id:         -1,
      topic_title:      topic.title,
      topic_category:   'quality',
      source:           'live',
      item:             topic.title,
      status:           'observed',
      resolved_by:      null,
      resolved_at:      null,
      details:          topic.summary || null,
      follow_up_needed: false,
      who_raised:       null,
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
          var entry = window.FS.api.actions.lookupAction(checkedMap, folder, t.topic_id, 'flag_' + idx);
          var resolved = !!(entry && entry.checked);
          topicFlagRows.push({
            id:                 x.date + '_' + (folder || '') + '_' + t.topic_id + '_flag_' + idx,
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

        var entry = window.FS.api.actions.lookupAction(checkedMap, folder, -1, 'obs_' + idx);
        var resolved = !!(entry && entry.checked);
        rows.push({
          id:                 x.date + '_' + (folder || '') + '_obs_' + idx,
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

    /* feat 4b — live-items merge, same resilience posture as the manual
       merge immediately above. Fable-review F1 — the fetch date set is
       computeLiveDates(from, to, fanout.dates), NOT fanout.dates alone
       (report-having dates only would silently omit today — see
       computeLiveDates()' doc comment above). Fetched pooled (not
       Promise.all — mirror the admin cross-product pooling at
       fanoutDates() above; a full 'All' range can span many dates and an
       unbounded burst risks the same throttling pooledAll guards
       against there). is_live topics' safety_observations[] map through
       toLiveSafetyRow() regardless of topic.category — safety
       observations aren't category-scoped in the report-derived rows
       either (see the topic_flag loop above, which also doesn't filter by
       category). Fable-review F2 — site filter matches topic.site_name
       against the opts.site slug resolved to a display name (see
       resolveSiteNameForFilter() above), not topic.site_id. A live-fetch
       failure must never take the range down — report + manual rows
       still render. */
    try {
      /* authority flip (pipeline plan 2026-07-14) — under timelineIsAurora(),
         the shim already serves live extraction topics for dates the report
         fanout covers via getTimeline, so re-merging live-items for THOSE
         dates would double-display every safety finding (investigation
         §0.11). But fanout.dates is report-having dates only (hasReport:
         true) — TODAY never qualifies (daily_report.json lands the
         following morning, see fanoutDates()/_AUDIT-1), so it has no
         shimmed data either. Rather than skip this leg entirely (which
         silently zeroes out today), drop only the fanout-covered dates
         from the live date set — each date is then served exactly once,
         in both flag states. Non-aurora: no filtering, unchanged. */
      var liveDatesSafety = computeLiveDates(from, to, fanout.dates);
      if (timelineIsAurora()) {
        var fanoutDateSetSafety = {};
        fanout.dates.forEach(function (d) { fanoutDateSetSafety[d] = true; });
        liveDatesSafety = liveDatesSafety.filter(function (d) { return !fanoutDateSetSafety[d]; });
      }
      var liveThunksSafety = liveDatesSafety.map(function (d) {
        return function () {
          return window.FS.api.org.getLiveItems({ date: d });
        };
      });
      var liveResultsSafety = (await window.FS.api.pooledAll(liveThunksSafety, 8)).filter(Boolean);
      var siteNameFilterSafety = opts.site ? await resolveSiteNameForFilter(opts.site) : null;
      var liveRowsSafety = [];
      liveResultsSafety.forEach(function (res) {
        ((res && res.topics) || []).forEach(function (topic) {
          if (!topic.is_live) return;
          if (siteNameFilterSafety && topic.site_name !== siteNameFilterSafety) return;  /* F2 — slug→name bridge, see resolveSiteNameForFilter() */
          (topic.safety_observations || []).forEach(function (o) {
            liveRowsSafety.push(toLiveSafetyRow(topic, o));
          });
        });
      });
      rows = rows.concat(liveRowsSafety);
    } catch (e) {
      console.warn('[compliance] live items unavailable — report/manual rows only', e);
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
          id:               x.date + '_' + (folder || '') + '_qc_' + idx,
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
        var entry = window.FS.api.actions.lookupAction(checkedMap, folder, t.topic_id, 'quality');
        var resolved = !!(entry && entry.checked);
        rows.push({
          id:               x.date + '_' + (folder || '') + '_' + t.topic_id + '_topic',
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

    /* feat 4b — live-items merge (see the matching comment in
       getSafetyRange above; same rationale — F1 computeLiveDates()
       independent of fanout.dates + pooledAll, F2 site_name bridge via
       resolveSiteNameForFilter(), never-throw). Live quality signal is
       coarse (topic itself, see toLiveQualityRow), so only topics tagged
       category === 'quality' qualify — mirrors the topic_quality loop
       above, which filters the same way. */
    try {
      /* authority flip (pipeline plan 2026-07-14): see the matching guard in
         getSafetyRange above — same rationale, same shared timelineIsAurora()
         gate. Drop only the fanout-covered dates from the live date set
         (report-dated days already come through the aurora-shimmed
         getTimeline); TODAY (never report-dated — see fanoutDates()/
         _AUDIT-1) stays in the live set so it isn't silently zeroed out.
         Non-aurora: no filtering, unchanged. */
      var liveDatesQuality = computeLiveDates(from, to, fanout.dates);
      if (timelineIsAurora()) {
        var fanoutDateSetQuality = {};
        fanout.dates.forEach(function (d) { fanoutDateSetQuality[d] = true; });
        liveDatesQuality = liveDatesQuality.filter(function (d) { return !fanoutDateSetQuality[d]; });
      }
      var liveThunksQuality = liveDatesQuality.map(function (d) {
        return function () {
          return window.FS.api.org.getLiveItems({ date: d });
        };
      });
      var liveResultsQuality = (await window.FS.api.pooledAll(liveThunksQuality, 8)).filter(Boolean);
      var siteNameFilterQuality = opts.site ? await resolveSiteNameForFilter(opts.site) : null;
      var liveRowsQuality = [];
      liveResultsQuality.forEach(function (res) {
        ((res && res.topics) || []).forEach(function (topic) {
          if (!topic.is_live || topic.category !== 'quality') return;
          if (siteNameFilterQuality && topic.site_name !== siteNameFilterQuality) return;  /* F2 — slug→name bridge, see resolveSiteNameForFilter() */
          liveRowsQuality.push(toLiveQualityRow(topic));
        });
      });
      rows = rows.concat(liveRowsQuality);
    } catch (e) {
      console.warn('[compliance] live items unavailable — report/manual rows only', e);
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
