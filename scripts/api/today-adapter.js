/* ==========================================================================
   FieldSight · Today Adapter — PLAN.md Phase D (sketch shipped in 2.1)
   --------------------------------------------------------------------------
   Maps a backend-shaped DailyReport (BACKEND-CONTEXT §5.1) into the existing
   Today page's data shape, so today.js can keep using
   MockData.TODAY.{morningBrief, urgent, myTasks, teamTasks, activity, onSite}
   verbatim while the data flows from a real-API-shaped fixture.

   Mapping (PLAN Phase D):
     morningBrief.bullets ← report.executive_summary
     urgent               ← topics where category==='safety' OR
                            safety_flags.length>0, plus
                            safety_observations with risk_level=='high'
     myTasks              ← topics[*].action_items where
                            responsible === currentUser.display_name
     teamTasks            ← rest of action_items (workers see [] — gated
                            via window.FS.canDo at call site)
     activity             ← topics ordered desc by time_range, mapped to
                            { speaker, snippet, timeAgo, channel }
     onSite               ← ctx.onSiteMembers, pre-fetched by today.js via
                            FS.api.sites.getSiteUsers (adapt() itself is
                            pure/sync and can't await — see ctx doc below)

   Pure function — no fetches; takes the report + a small caller context
   and returns a TODAY-shaped object the existing composites consume.

   feat/today-by-project — cross-project fan-out support (still a pure
   function; today.js does the fetching + fan-out, this file only adds
   the per-report stamping):
     ctx.siteSlugByName  { 'SB1108 Ellesmere College': 'sb1108-ellesmere', ... }
                         Optional name→slug map (built once by today.js via
                         FS.api.sites.getSites(), the report-side site list —
                         report.site is ONLY a display name, never a slug,
                         so this is how the slug gets derived). Every
                         derived item is stamped with `site_name` (=
                         report.site, verbatim) and `site_slug` (looked up
                         via this map; null on a lookup miss — callers must
                         treat null as "no slug", never drop the item).
     ctx.idPrefix        Optional string. When today.js fans a date out
                         across MULTIPLE users' reports (admin/multi-project
                         view), topic_id is only unique WITHIN one report —
                         two different users can both have topic_id 0 on the
                         same date. idPrefix (the report owner's folder
                         name) namespaces every derived `id` so merged lists
                         don't collide. Omitted on the single-report fast
                         path, so existing ids are byte-identical to before.
     ctx.onSiteMembers   fix/today-onsite-live — Optional array of live
                         site-member records ({device_id/name, ...} —
                         FS.api.sites.getSiteUsers shape) for the "On
                         site now" widget. today.js resolves which site
                         to fetch (the report's own site, falling back
                         to the caller's own membership site — never a
                         hardcoded literal) and fetches it BEFORE calling
                         adapt(), since adapt() is pure/sync and can't
                         await. adapt() only reshapes it into onSite
                         below. Omitted/empty -> onSite: [] (never a
                         fixture fallback any more).

   feat/user-dim-audit-key (Task 6) — audit-state lookups and every
   derived task item now carry `folder` = the REPORT OWNER's folder
   (see `ownerFolder` in adapt() below), so today.js's keep()/bus
   removal predicate and task-card.js's toggleAction call can key the
   check-off per-user instead of colliding on (topic_id, action_index)
   alone across two different owners' reports on the same date. Reads
   go through FS.api.actions.lookupAction (composite key with legacy
   bare-key fallback) — never a raw actionState[key] lookup.

   Exported to window.FS.api.todayAdapter.adapt(report, ctx)
   ========================================================================== */

(function () {
  'use strict';

  /* Map a topic's category onto the existing Activity card "channel" field.
     The channel labels are display-only — pick something sensible. */
  var CATEGORY_CHANNEL = {
    safety:   'Safety',
    progress: 'General',
    quality:  'Quality',
  };

  /* Map a daily-report priority + the existing TaskCard tone vocabulary. */
  function priorityLabel(p) {
    if (!p) return 'Medium';
    return p.charAt(0).toUpperCase() + p.slice(1);
  }

  /* feat/editable-tasks-ui — status is now the AUTHORITATIVE
     action_items.status column (Task 1, PATCH /api/org/action-items/{id}).
     The DynamoDB check-off boolean (BACKEND-CONTEXT §4.10) is kept ONLY as
     a legacy fallback: used when the item carries no column status
     (pre-migration days), so a historical check-off never visibly
     reverts. Tone vocabulary verified against the real Badge component
     (scripts/components/badge.js: neutral|accent|success|warning|danger|
     info — NO 'magenta' tone exists there, despite tokens.css defining a
     bespoke --status-blocked magenta/fuchsia hue for a future dedicated
     treatment) and against every other 'blocked' status→tone mapping
     already shipped in this codebase (quality.js statusTone(),
     timeline.js MEETING_STATUS_TONE, programme-task-card.js) — all of
     them use 'danger' for blocked. Matched here for consistency. */
  var STATUS_TONE = { done: 'success', in_progress: 'info', blocked: 'danger', open: 'info' };
  function deriveStatus(columnStatus, checked) {
    var s = columnStatus || (checked ? 'done' : 'open');
    var label = s === 'in_progress' ? 'In progress' : s.charAt(0).toUpperCase() + s.slice(1);
    return { status: label, statusTone: STATUS_TONE[s] || 'info' };
  }

  /* Pull a HH:MM from the deadline string when present. The backend
     surfaces deadlines as free-text ("Tomorrow 08:00", "By Friday"); we
     fall back to em-dash if no clock time is present.
     Superseded by resolveDeadline() below as the source of `dueTime`
     (fix/timeline-buttons-and-deadline) — kept defined/working since
     it's a small correct helper other code may still reach for. */
  function dueTimeFromDeadline(deadline) {
    if (!deadline) return '—';
    var m = String(deadline).match(/(\d{2}):(\d{2})/);
    return m ? m[0] : deadline;
  }

  /* ---------- resolveDeadline — free-text deadline -> absolute date ----
     fix/timeline-buttons-and-deadline. Action-item deadlines are free
     text ("Wednesday", "Tomorrow", "By Friday", "Next week", "Today
     08:30", …) captured relative to the REPORT'S OWN date, not "now" —
     every call site has that origin date available (Today items carry
     .date = report_date; Timeline's ActionItemRow/TopicCard receive a
     `date` prop). Resolves to an absolute yyyy-MM-dd wherever the
     pattern is confidently recognised; falls back to the raw text
     (never a WRONG date) when it isn't. All date math goes through
     FS.api.addDaysISO + a Date.UTC(...) parse of the report date —
     BUG-19: never `new Date('YYYY-MM-DD')`.

     Signature: resolveDeadline(freeText, reportDateISO)
       -> { absolute: 'YYYY-MM-DD'|null, display: string }

     Rule order (first match wins):
       1. empty                       -> { null, '—' }
       2. contains "today"            -> reportDate
       3. contains "tomorrow"         -> reportDate + 1d
       4. contains a weekday name     -> the FIRST occurrence of that
          (mon..sun, full or 3-letter)   weekday STRICTLY AFTER
                                          reportDate
       5. contains "next week"        -> reportDate + 7d
       6. "within|in N day(s)/week(s)" -> reportDate + N (or N*7)
       7. otherwise: try to normalise a bare date already present in
          the text ("2026-02-12", "12 Feb", "Feb 12 2026") -> that
          date; unparsable -> { null, <raw freeText> }

     A trailing clock time in the original text ("Today 08:30") is kept
     on `display` after the resolved date ("2026-02-09 08:30"). */
  var WEEKDAY_INDEX = {
    sunday: 0, sun: 0,
    monday: 1, mon: 1,
    tuesday: 2, tues: 2, tue: 2,
    wednesday: 3, weds: 3, wed: 3,
    thursday: 4, thurs: 4, thur: 4, thu: 4,
    friday: 5, fri: 5,
    saturday: 6, sat: 6,
  };
  var MONTH_INDEX = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
                      'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /* UTC day-of-week for a 'YYYY-MM-DD' string — BUG-19 safe (mirrors
     timeline.js:formatDateLabel / today.js:mondayOf — Date.UTC parse,
     never new Date(str)). */
  function weekdayOfISO(iso) {
    var p = iso.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
  }

  /* Best-effort "there's already a bare date in the text" fallback —
     tried only after today/tomorrow/weekday/next-week/within-N all
     miss. Handles an ISO date anywhere in the string, or "12 Feb[ruary]
     [2026]" / "Feb[ruary] 12[, 2026]" (year optional, defaults to the
     report's own year). Returns 'YYYY-MM-DD' or null (never guesses). */
  function tryParseBareDate(text, reportDateISO) {
    var iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (iso) {
      var mo = parseInt(iso[2], 10), d = parseInt(iso[3], 10);
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return iso[1] + '-' + iso[2] + '-' + iso[3];
    }

    var dayMonth = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\b/);
    var monthDay = text.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
    var day = null, monthToken = null;
    if (dayMonth && MONTH_INDEX.indexOf(dayMonth[2].slice(0, 3).toLowerCase()) !== -1) {
      day = parseInt(dayMonth[1], 10);
      monthToken = dayMonth[2];
    } else if (monthDay && MONTH_INDEX.indexOf(monthDay[1].slice(0, 3).toLowerCase()) !== -1) {
      day = parseInt(monthDay[2], 10);
      monthToken = monthDay[1];
    } else {
      return null;
    }
    var monIdx = MONTH_INDEX.indexOf(monthToken.slice(0, 3).toLowerCase());
    if (monIdx === -1 || day < 1 || day > 31) return null;
    var yearMatch = text.match(/\b(20\d{2})\b/);
    var year = yearMatch ? yearMatch[1] : reportDateISO.split('-')[0];
    return year + '-' + pad2(monIdx + 1) + '-' + pad2(day);
  }

  function resolveDeadline(freeText, reportDateISO) {
    var text = (freeText == null ? '' : String(freeText)).trim();
    if (!text) return { absolute: null, display: '—' };

    var api = window.FS && window.FS.api;
    if (!reportDateISO || !api || !api.addDaysISO) return { absolute: null, display: text };

    var lower = text.toLowerCase();

    /* An explicit date already in the text is authoritative — the extractor
       often renders a relative phrase AND the resolved date, e.g. "Week after
       next Tuesday (2026-07-28 approx.)"; the (2026-07-28) is ground truth and
       must win over re-deriving the weekday. So try the bare/ISO date FIRST,
       then fall back to relative phrasing when no explicit date is present. */
    var absolute = tryParseBareDate(text, reportDateISO);

    if (!absolute) {
      if (/\btoday\b/.test(lower)) {
        absolute = reportDateISO;
      } else if (/\btomorrow\b/.test(lower)) {
        absolute = api.addDaysISO(reportDateISO, 1);
      } else {
        var weekdayMatch = lower.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat)\b/);
        if (weekdayMatch) {
          var targetDow  = WEEKDAY_INDEX[weekdayMatch[1]];
          var currentDow = weekdayOfISO(reportDateISO);
          var delta = (targetDow - currentDow + 7) % 7;
          if (delta === 0) delta = 7; /* strictly AFTER reportDate, never same-day */
          absolute = api.addDaysISO(reportDateISO, delta);
        } else if (/\bnext\s+week\b/.test(lower)) {
          absolute = api.addDaysISO(reportDateISO, 7);
        } else {
          var withinMatch = lower.match(/\b(?:within|in)\s+(\d+)\s*(day|week)s?\b/);
          if (withinMatch) {
            var n = parseInt(withinMatch[1], 10);
            var days = withinMatch[2] === 'week' ? n * 7 : n;
            absolute = api.addDaysISO(reportDateISO, days);
          }
          /* else: no explicit date and no recognised relative phrase -> null */
        }
      }
    }

    if (!absolute) return { absolute: null, display: text };

    var display = absolute;
    var timeMatch = text.match(/\b(\d{1,2}):(\d{2})\b/);
    if (timeMatch) display = absolute + ' ' + pad2(parseInt(timeMatch[1], 10)) + ':' + timeMatch[2];

    return { absolute: absolute, display: display };
  }

  /* Topic time_range uses an en-dash; the start half is the source of
     time-ordering for the activity feed. */
  function topicStartMinutes(t) {
    if (!t.time_range) return 0;
    var m = t.time_range.match(/(\d{2}):(\d{2})/);
    if (!m) return 0;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  /* Coarse "Xh ago / Xm ago" relative to a reference clock time (HH:MM
     in NZDT). The Today fixture's reference is the report end-of-day at
     16:00 NZDT — close enough for a wireframe. */
  function relativeAgo(topicStart, nowMinutes) {
    var diff = Math.max(0, nowMinutes - topicStart);
    if (diff < 60) return diff + 'm ago';
    var h = Math.floor(diff / 60);
    return h + 'h ago';
  }

  /* Build a short body for an urgent card from a topic. */
  function urgentBodyForTopic(topic) {
    if (topic.safety_flags && topic.safety_flags.length > 0) {
      return topic.safety_flags[0].observation;
    }
    return topic.summary || topic.topic_title;
  }

  function adapt(report, ctx) {
    ctx = ctx || {};
    var currentUserName = ctx.currentUserName || (window.AuthMock && window.AuthMock.currentUser && window.AuthMock.currentUser.name) || '';
    /* fix/mine-team-attribution — the viewer's REAL folder_name, when
       known (threaded from GET /api/org/me via session-bridge.js onto
       AuthMock.currentUser.folder_name; today.js passes it through as
       ctx.currentUserFolder). null/undefined here is fine — isMineTask
       falls back to deriving it from currentUserName itself. */
    var currentUserFolder = ctx.currentUserFolder || (window.AuthMock && window.AuthMock.currentUser && window.AuthMock.currentUser.folder_name) || null;
    var actionState     = ctx.actionState     || {}; /* composite/legacy map — read via FS.api.actions.lookupAction only */
    var nowMinutes      = ctx.nowMinutes      != null ? ctx.nowMinutes : (16 * 60); /* 16:00 NZDT */
    var siteSlugByName  = ctx.siteSlugByName  || {};
    /* feat/editable-tasks-ui — org SITE UUID space (org.getOrgSites()'s
       site_id, i.e. _toPageSite's s.id — see programme.js's "CRITICAL"
       doc on this id space), keyed by report site NAME. A DIFFERENT id
       space than siteSlugByName above (that one is the legacy report-
       gateway /api/sites site_id); org.getSiteMembers(siteId) — the
       assignee-picker source — expects THIS UUID space specifically
       (GET /api/org/sites/{id}/members). today.js builds this the same
       way it builds siteSlugByName: a one-shot name→id map fetched once
       per load (getOrgSiteIdMap(), mirroring getSiteSlugMap()) and
       threaded in here. Missing/empty on a lookup miss — every derived
       item still gets siteId: null rather than throwing; callers
       (task-detail assignee picker) must degrade to a disabled read-only
       control on null, never crash. */
    var siteIdByName    = ctx.siteIdByName    || {};
    var idPrefix        = ctx.idPrefix ? (ctx.idPrefix + '_') : '';
    /* fix/today-onsite-live — pre-fetched live site-member records; see
       ctx.onSiteMembers doc above. */
    var onSiteMembers   = ctx.onSiteMembers   || [];

    if (!report || report._notFound) {
      return {
        date:   ctx.date || null,
        site:   '',
        site_slug: null,
        morningBrief: { generatedAt: '—', bullets: [] },
        urgent:  [],
        myTasks: [],
        teamTasks: [],
        activity: [],
        onSite:   [],
      };
    }

    /* feat/user-dim-audit-key (Task 6) — the REPORT OWNER's folder. Feeds
       the audit-state composite key (lookupAction below) and is stamped
       onto every task item as `folder`, so today.js's keep()/bus-removal
       predicate and task-card.js's toggleAction call can thread the
       owner through without re-deriving it. MUST be the RAW ctx.idPrefix
       — the `idPrefix` local above is a DIFFERENT, id-NAMESPACING string
       with a trailing '_' appended (see its declaration a few lines up);
       reusing that would corrupt both the audit key and the user_folder
       sent to toggleAction. Falls back to deriving from report.user_name
       on the single-report fast path, where ctx.idPrefix is omitted. */
    var ownerFolder = ctx.idPrefix || (report.user_name ? window.FS.api.folderName(report.user_name) : null);

    /* site_name is report.site verbatim (the ONLY site field a report
       carries — see the comment above, no slug exists on the report
       itself). site_slug is looked up via ctx.siteSlugByName; null on a
       miss (unmapped site / map not supplied) rather than throwing —
       callers must treat null as "unknown project", not drop the item. */
    var siteName = report.site || '';
    var siteSlug = (siteName && siteSlugByName[siteName]) || null;
    /* feat/editable-tasks-ui — org UUID counterpart of siteSlug above,
       same name-match, different id space (see ctx.siteIdByName doc). */
    var siteId   = (siteName && siteIdByName[siteName]) || null;
    /* ---- morningBrief: executive_summary is array of strings (v3.0+) --
       date + userFolder are passed through so MorningBriefCard's
       "Read full brief" button can deep-link to the canonical
       /timeline?date=…&user=… view (M-5). */
    var bullets = Array.isArray(report.executive_summary)
      ? report.executive_summary.slice()
      : (report.executive_summary ? [String(report.executive_summary)] : []);

    var morningBrief = {
      generatedAt: '5:42 AM',
      bullets:     bullets,
      date:        report.report_date || ctx.date || null,
      userFolder:  report.user_name
                     ? window.FS.api.folderName(report.user_name)
                     : null,
    };

    /* ---- urgent: safety topics + non-empty safety_flags + high obs ----
       P-01 (Sprint 3): expose riskLevel + recommendedAction on every
       urgent item so UrgentCard can render the action plan inline
       without a click-through to the right detail. */
    var urgent = [];
    (report.topics || []).forEach(function (t) {
      var hasSafetyFlags = (t.safety_flags || []).length > 0;
      if (t.category === 'safety' || hasSafetyFlags) {
        var firstFlag = hasSafetyFlags ? t.safety_flags[0] : null;
        urgent.push({
          id:          idPrefix + 'topic_' + t.topic_id,
          title:       t.topic_title,
          badgeLabel:  hasSafetyFlags ? (firstFlag.risk_level || 'medium') + ' risk' : 'Safety topic',
          badgeTone:   hasSafetyFlags && firstFlag.risk_level === 'high' ? 'danger' : 'warning',
          body:        urgentBodyForTopic(t),
          triggeredBy: hasSafetyFlags ? 'Safety flag · ' + (firstFlag.risk_level || 'medium') : 'Topic category · safety',
          riskLevel:   firstFlag ? (firstFlag.risk_level || 'medium') : null,
          recommendedAction: firstFlag ? firstFlag.recommended_action : null,
          kind:        'urgent',
          site_name:   siteName,
          site_slug:   siteSlug,
        });
      }
    });
    (report.safety_observations || []).forEach(function (obs, i) {
      if (obs.risk_level !== 'high') return;
      urgent.push({
        id:                idPrefix + 'safety_obs_' + i,
        title:             obs.observation,
        badgeLabel:        'High risk',
        badgeTone:         'danger',
        /* For site-wide observations, the title already IS the
           observation — keep body empty so the recommendedAction
           below isn't duplicated by the body line. */
        body:              null,
        triggeredBy:       'Site safety observation · ' + (obs.location || 'site'),
        riskLevel:         'high',
        recommendedAction: obs.recommended_action || null,
        location:          obs.location || null,
        kind:              'urgent',
        site_name:         siteName,
        site_slug:         siteSlug,
      });
    });

    /* ---- tasks: flatten action_items, split mine vs team -------------- */
    var myTasks = [];
    var teamTasks = [];
    (report.topics || []).forEach(function (t) {
      /* Q1 — tier-aware Today/Tasks: a redacted topic (life-conversation-
         separation "标为个人+移除") is omitted from Today entirely — not
         rendered, not counted. Mirrors timeline.js's own redacted/removed
         handling; unlike Timeline there is no review control here, so a
         redacted topic's action items simply never surface. */
      if (t.redacted) return;
      (t.action_items || []).forEach(function (a, idx) {
        var key = t.topic_id + '_' + idx;
        var auditEntry = window.FS.api.actions.lookupAction(actionState, ownerFolder, t.topic_id, idx);
        var checked = !!(auditEntry && auditEntry.checked);
        /* feat/editable-tasks-ui — a.status is the read shim's new
           authoritative action_items.status column; checked (DynamoDB
           audit) is now only consulted as the pre-migration fallback
           inside deriveStatus itself. */
        var status = deriveStatus(a.status, checked);
        var task = {
          id:          idPrefix + 'action_' + key,
          /* feat/editable-tasks-ui — durable action_items.id (read shim),
             the PATCH /api/org/action-items/{id} handle. Null for any
             legacy/pre-migration item the shim hasn't stamped yet — the
             task-detail editors must treat null as "not editable", never
             crash. */
          actionItemId: a.id || null,
          /* feat/editable-tasks-ui — org SITE UUID for this task's site
             (see ctx.siteIdByName doc above); null on a lookup miss. Feeds
             the assignee picker's FS.api.org.getSiteMembers(task.siteId)
             call — null degrades the picker to a disabled read-only
             control rather than crashing. */
          siteId:      siteId,
          topic_id:    t.topic_id,
          actionIndex: idx,
          title:       a.action,
          assignee:    a.responsible || '—',
          status:      status.status,
          statusTone:  status.statusTone,
          priority:    priorityLabel(a.priority),
          /* feat/today-rolling-open-items — raw deadline text (or null),
             distinct from dueTime below (which is always a display
             string, '—' when absent). Rolling Today needs the RAW
             presence/absence to render an accurate "No deadline" chip —
             dueTime alone can't tell '—' (no deadline) apart from a
             deadline with no clock time in it. */
          deadline:    a.deadline || null,
          /* fix/timeline-buttons-and-deadline — dueTime now shows the
             free-text deadline RESOLVED to an absolute date (relative to
             this action's own report date), not the raw verbatim text.
             Both TaskCard's due display and the Today right-detail
             ['Due', …] row read task.dueTime directly, so this one
             change wires both. Falls back to the raw text unchanged
             when the pattern isn't recognised (resolveDeadline never
             guesses a wrong date). */
          dueTime:     resolveDeadline(a.deadline, report.report_date || ctx.date).display,
          /* §E-time — the PARENT TOPIC's time_range ('14:09 – 14:09'),
             carried down onto every action item flattened from it.
             action_items themselves have no time column; the topic is
             the only place this timestamp lives. Rendered as a small
             muted label on the Today task card (task-card.js) when
             present. */
          timeRange:   t.time_range || null,
          /* Q1 — tier-aware Today/Tasks: pass the parent topic's
             work_class through verbatim (undefined/'work'/'non_work' —
             never normalised here). Missing/other values must fall
             through to "treat as work" at every consumer via
             `=== 'non_work'`, never `!== 'work'` — same rule the
             timeline "aurora" shape already follows elsewhere. */
          work_class:  t.work_class,
          kind:        'task',
          /* feat/today-rolling-open-items — the report date this item
             was extracted from. today.js's rolling loader fans out
             across many report dates at once, so each item must carry
             its OWN origin date for per-item check-off (toggleAction)
             and age computation — mirrors morningBrief.date above. */
          date:        report.report_date || ctx.date || null,
          /* feat/user-dim-audit-key (Task 6) — report OWNER's folder
             (never AuthMock.currentUser / caller) — see ownerFolder
             above. today.js's keep()/bus predicate and task-card.js's
             toggleAction read this to key the audit lookup/write. */
          folder:      ownerFolder,
          site_name:   siteName,
          site_slug:   siteSlug,
        };
        /* fix/mine-team-attribution — shared predicate (scripts/api/
           mine-team.js), NOT a strict `=== currentUserName` string
           check any more: normalized-exact OR folder-equality match on
           an assigned name; an unassigned item (task.assignee is the
           '—' placeholder or the raw text was null/'') is Mine only
           when THIS report's ownerFolder is the viewer's own folder —
           see mine-team.js's doc for the full rule set. Tasks page
           (tasks.js computeBuckets) calls the exact same predicate so
           the two pages can't drift apart again. */
        if (window.FS.api.isMineTask(task.assignee, ownerFolder, { name: currentUserName, folderName: currentUserFolder })) {
          myTasks.push(task);
        } else {
          teamTasks.push(task);
        }
      });
    });

    /* Workers can only see their own tasks — gate via FS.canDo. */
    var role = (window.AuthMock && window.AuthMock.currentUser && window.AuthMock.currentUser.role) || '';
    if (role === 'worker') teamTasks = [];

    /* ---- activity: topics ordered desc by start time ------------------ */
    var topicsSorted = (report.topics || []).slice().sort(function (a, b) {
      return topicStartMinutes(b) - topicStartMinutes(a);
    });
    var activity = topicsSorted.map(function (t) {
      var speaker = (t.participants && t.participants[0]) || report.user_name || 'Site';
      return {
        id:        idPrefix + 'activity_' + t.topic_id,
        speaker:   speaker,
        snippet:   t.summary || t.topic_title,
        timeAgo:   relativeAgo(topicStartMinutes(t), nowMinutes),
        channel:   CATEGORY_CHANNEL[t.category] || 'General',
        topic_id:  t.topic_id,
        kind:      'activity',
        site_name: siteName,
        site_slug: siteSlug,
      };
    });

    /* ---- onSite: LIVE per-site members, pre-fetched by today.js and
       passed in as ctx.onSiteMembers (fix/today-onsite-live). Replaces
       the old static fixtures.sites.users scan, which was never wired
       to live data — it always surfaced the same 4 mock sb1108 people
       regardless of which site the report actually belonged to. Site
       resolution (which site to fetch) already happened in today.js
       before the fetch — adapt() just reshapes the result into the
       {id, name} OnSiteCard expects. */
    var onSite = onSiteMembers.map(function (m) {
      return { id: m.device_id || m.id || m.cognito_sub || m.name, name: m.name };
    });

    return {
      date:        report.report_date,
      site:        report.site,
      site_slug:   siteSlug,
      morningBrief: morningBrief,
      urgent:      urgent,
      myTasks:     myTasks,
      teamTasks:   teamTasks,
      activity:    activity,
      onSite:      onSite,
    };
  }

  if (!window.FS) window.FS = {};
  if (!window.FS.api) window.FS.api = {};
  window.FS.api.todayAdapter = { adapt: adapt };
  /* fix/timeline-buttons-and-deadline — flat on FS.api (mirrors
     FS.api.addDaysISO / FS.api.folderName) so scripts/composites/
     action-item-row.js (Timeline's action-item deadline render) can
     reuse the exact same resolver without importing the whole adapter
     namespace. Load order doesn't matter — only called at render time,
     well after all scripts have loaded. */
  window.FS.api.resolveDeadline = resolveDeadline;
  /* feat/editable-tasks-ui — flat on FS.api, same rationale as
     resolveDeadline above: scripts/pages/today.js's task-detail editors
     need to recompute a task's {status, statusTone} from the FULL updated
     row PATCH /api/org/action-items/{id} returns, without duplicating the
     STATUS_TONE map or re-running adapt()/a full page reload. */
  window.FS.api.deriveStatus = deriveStatus;

})();
