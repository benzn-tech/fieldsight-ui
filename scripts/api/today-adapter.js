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
     onSite               ← getSiteUsers(currentUser.primary_site)

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

  /* Action items don't carry a status — derive from the actions audit
     state (BACKEND-CONTEXT §4.10) so the toggle persists across the
     Today and Timeline surfaces. */
  function deriveStatus(checked) {
    if (checked) return { status: 'Done',  statusTone: 'success' };
    return { status: 'Open', statusTone: 'info' };
  }

  /* Pull a HH:MM from the deadline string when present. The backend
     surfaces deadlines as free-text ("Tomorrow 08:00", "By Friday"); we
     fall back to em-dash if no clock time is present. */
  function dueTimeFromDeadline(deadline) {
    if (!deadline) return '—';
    var m = String(deadline).match(/(\d{2}):(\d{2})/);
    return m ? m[0] : deadline;
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
    var primarySite     = ctx.primarySite     || 'sb1108-ellesmere';
    var actionState     = ctx.actionState     || {}; /* keyed by `${topic_id}_${index}` */
    var nowMinutes      = ctx.nowMinutes      != null ? ctx.nowMinutes : (16 * 60); /* 16:00 NZDT */
    var siteSlugByName  = ctx.siteSlugByName  || {};
    var idPrefix        = ctx.idPrefix ? (ctx.idPrefix + '_') : '';

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

    /* site_name is report.site verbatim (the ONLY site field a report
       carries — see the comment above, no slug exists on the report
       itself). site_slug is looked up via ctx.siteSlugByName; null on a
       miss (unmapped site / map not supplied) rather than throwing —
       callers must treat null as "unknown project", not drop the item. */
    var siteName = report.site || '';
    var siteSlug = (siteName && siteSlugByName[siteName]) || null;
    /* Per-report "on site now" should reflect the SITE THE REPORT CAME
       FROM, not necessarily the viewing caller's own primary_site — that
       distinction only collapses to the same thing on the single-report
       fast path (caller === report owner). Falls back to ctx.primarySite
       when the report's site can't be resolved to a slug, preserving the
       exact previous behaviour for that path. */
    var onSiteLookupSlug = siteSlug || primarySite;

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
      (t.action_items || []).forEach(function (a, idx) {
        var key = t.topic_id + '_' + idx;
        var checked = !!(actionState[key] && actionState[key].checked);
        var status = deriveStatus(checked);
        var task = {
          id:          idPrefix + 'action_' + key,
          topic_id:    t.topic_id,
          actionIndex: idx,
          title:       a.action,
          assignee:    a.responsible || '—',
          status:      status.status,
          statusTone:  status.statusTone,
          priority:    priorityLabel(a.priority),
          dueTime:     dueTimeFromDeadline(a.deadline),
          kind:        'task',
          site_name:   siteName,
          site_slug:   siteSlug,
        };
        if (currentUserName && task.assignee === currentUserName) {
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

    /* ---- onSite: pull users on the report's own site (falls back to
       ctx.primarySite on a slug-lookup miss — see onSiteLookupSlug
       above) -------------------------------------------------------- */
    var onSite = [];
    var sitesFx = (window.FieldSight && window.FieldSight.fixtures && window.FieldSight.fixtures.sites) || { users: [] };
    sitesFx.users.forEach(function (u) {
      if ((u.sites || []).indexOf(onSiteLookupSlug) !== -1) {
        onSite.push({ id: u.device_id, name: u.name });
      }
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

})();
