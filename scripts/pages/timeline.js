/* ==========================================================================
   FieldSight Timeline Page — Sprint 2.2 (PLAN.md Phase B)
   --------------------------------------------------------------------------
   The PRIMARY surface the backend was designed to serve:
     /timeline?date=YYYY-MM-DD&user=Jarley_Trainor

   Middle column:
     • Header: date · user · site
     • KpiStrip:   Topics · Safety · Recordings · Words
     • ExecutiveSummaryCard
     • Topic list (TopicCard, collapsible, click to open in right detail)
     • Empty / no-report / admin-disambiguation states

   Right detail:
     • TopicDetail panel with tabs (Overview, Transcript, Audio, Video,
       Photos). Sprint 2.2 ships Overview + Photos against real fixtures;
       Transcript / Audio / Video tabs have placeholder content that
       Phase C (Sprint 2.3) wires up against the existing api modules.

   Bug-traps honoured here:
     • BUG-19 NZDT date math — uses FS.api.addDaysISO, never new Date(str).
     • BUG-20 CloudFront-HTML-404 — getTimeline returns { _notFound:true }
       on either a real 404 or a 200/HTML body, so the no-report branch
       triggers for both.
     • §8.7 empty arrays render gracefully.

   Registers as window.FieldSight.PAGES['/timeline']
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  /* ---------- helpers --------------------------------------------------- */

  function readRouteParams() {
    var route = window.FS && window.FS.Router && window.FS.Router.getCurrentRoute();
    return (route && route.params) || {};
  }

  function callerFolder() {
    var u = (window.AuthMock && window.AuthMock.currentUser) || {};
    if (!u.name) return null;
    return window.FS.api.folderName(u.name);
  }

  /* Coerced: a caller without an `isAdmin` field used to make this return
     `undefined`. Equivalent inside an `if`, but it is a predicate — callers
     (and tests) should be able to compare it. */
  function isAdminLike(user) {
    return !!(user && (user.role === 'admin' || user.role === 'gm' || user.isAdmin));
  }

  /* Can this caller reach a multi-person view at all, from where they are?
     The question the "back to overview" control actually needs answered —
     it used to ask isAdminLike, which silently excluded pm and site_manager
     and left them with NO way out of a person's day once they opened one.

     It is not the same question as isAdminLike:
       • admin/gm     — yes, with or without a site (no site → the cross-site
                        user list; with one → that site's day).
       • pm / site_mgr — only WITH a site anchored. Without one the resolver
                        below forces them back to self, so a siteless "back"
                        would bounce them straight into the view they just
                        tried to leave.
       • worker       — never; they have no overview to return to. */
  function canSeeOverview(caller, site) {
    if (!caller || caller.role === 'worker') return false;
    return isAdminLike(caller) || !!site;
  }

  /* Whose day does this URL mean? Pure, so the landing rule is testable
     without mounting the page.

       ?user=X     → that person (explicit; how "Open" navigates)
       ?view=team  → the multi-person view (explicit; how the team control
                     and the back control navigate)
       neither     → the caller's OWN day

     `selfDefaulted` distinguishes "we put you here" from "you asked for
     this", which is what licenses the empty-day handover to the team view:
     an explicitly requested empty day still renders its own empty state,
     because redirecting away from a page someone asked for is disorienting.

     Workers are pinned to themselves whatever the URL says — they have no
     team view to be sent to, so no marker is needed. */
  function resolveTimelineScope(caller, params, selfFolder) {
    var p = params || {};
    if (caller && caller.role === 'worker') {
      return { user: selfFolder, selfDefaulted: false };
    }
    if (p.user) return { user: p.user, selfDefaulted: false };
    if (p.view === 'team') return { user: null, selfDefaulted: false };
    return { user: selfFolder, selfDefaulted: true };
  }

  /* ---------- life-conversation separation: optimistic overrides --------- */
  /* Q2 follow-up. A redaction/revert commits at the org-api, but the next
     getTimeline often reads a STALE warm-Lambda snapshot for a few seconds
     (BUG: read-after-write lag on the writer endpoint), so a plain refetch
     leaves the topic in its old bucket — or worse, flickers back. Instead the
     review buttons apply an optimistic patch keyed by the durable topic_row_id
     (stable across the lag, unlike the per-report topic_id); render merges it on
     top of the fetched report so the topic moves at once, and each refetch
     reconciles the patch away once the server has caught up. These three pure
     helpers hold that logic (unit-tested — tests/timeline-redaction-overrides). */

  /* Merge each optimistic patch onto the topic with the matching topic_row_id.
     Returns a new list; overridden topics are shallow-cloned (never mutated).
     Topics without a topic_row_id (e.g. meeting topics) are passed through. */
  function applyTopicOverrides(topics, overrides) {
    var list = topics || [];
    if (!overrides || Object.keys(overrides).length === 0) return list;
    return list.map(function (t) {
      var patch = t && t.topic_row_id ? overrides[t.topic_row_id] : null;
      return patch ? Object.assign({}, t, patch) : t;
    });
  }

  /* Split the (already override-merged) topics into the visible list and the
     "Removed / personal" area on the redacted flag, preserving order within each. */
  function partitionTopics(topics) {
    var visible = [], removed = [];
    (topics || []).forEach(function (t) {
      (t && t.redacted ? removed : visible).push(t);
    });
    return { visible: visible, removed: removed };
  }

  /* Given a freshly fetched report, drop every override field the server has
     now caught up to; an override whose fields are all confirmed is retired.
     Overrides whose topic is missing from the fresh report are kept (the read
     hasn't surfaced it yet). null and undefined compare equal (a reverted
     redaction_id may come back as either). */
  function reconcileTopicOverrides(overrides, freshTopics) {
    if (!overrides || Object.keys(overrides).length === 0) return {};
    var byRow = {};
    (freshTopics || []).forEach(function (t) {
      if (t && t.topic_row_id) byRow[t.topic_row_id] = t;
    });
    var next = {};
    Object.keys(overrides).forEach(function (rowId) {
      var patch = overrides[rowId];
      var server = byRow[rowId];
      if (!server) { next[rowId] = patch; return; }   // not yet in the read → keep
      var remaining = {};
      Object.keys(patch).forEach(function (field) {
        var s = server[field] == null ? null : server[field];
        var p = patch[field] == null ? null : patch[field];
        if (s !== p) remaining[field] = patch[field];   // server hasn't caught up → keep
      });
      if (Object.keys(remaining).length > 0) next[rowId] = remaining;
    });
    return next;
  }

  /* ---------- session picker (feat 5) ------------------------------------ */
  /* Pure helpers over GET /api/org/sessions's { sessions, excluded } shape
     (unit-tested — tests/session-picker). The picker filters CLIENT-SIDE
     over the already-fetched report topics (match on topic.session_id) —
     selecting a session never issues a network request; only the initial
     getSessions(date, user) fetch does. */

  /* A picker offering a single option is noise — only render once there is
     an actual choice to make (spec: "renders only when there are >=2
     sessions"). Zero or one session both mean "nothing to narrow". */
  function shouldShowSessionPicker(sessions) {
    return !!(sessions && sessions.length >= 2);
  }

  /* null/undefined sessionId = "All day" (no filtering) — returns the list
     unchanged, INCLUDING session_kind:'report' topics (which carry no
     session_id at all and would otherwise never match anything). A real
     sessionId keeps only topics whose session_id matches exactly, which
     also hides report-kind topics under an active filter (spec: they have
     no session, so they're absent from every single-session view). */
  function filterTopicsBySession(topics, sessionId) {
    var list = topics || [];
    if (sessionId == null) return list;
    return list.filter(function (t) { return !!t && t.session_id === sessionId; });
  }

  /* Group sessions that share a `block` (a meeting split across recording
     restarts — same gap-merged meeting, several press-record events).
     Preserves first-appearance order of both groups and sessions within a
     group. A session with no block (undefined/null) gets its own
     singleton group, keyed by session_id so two blockless sessions never
     collapse into one group. */
  function groupSessionsByBlock(sessions) {
    var order = [];
    var byKey = {};
    (sessions || []).forEach(function (s) {
      if (!s) return;
      var key = s.block != null ? 'block:' + s.block : 'solo:' + s.session_id;
      if (!byKey[key]) {
        byKey[key] = { block: s.block != null ? s.block : null, sessions: [] };
        order.push(key);
      }
      byKey[key].sessions.push(s);
    });
    return order.map(function (key) { return byKey[key]; });
  }

  /* Truncate a long participant list sensibly: up to `max` names verbatim,
     then "+N more" instead of a wall of text. Falsy names filtered out. */
  function formatParticipants(participants, max) {
    var list = (participants || []).filter(Boolean);
    var limit = max || 2;
    if (list.length === 0) return '';
    if (list.length <= limit) return list.join(', ');
    return list.slice(0, limit).join(', ') + ' +' + (list.length - limit) + ' more';
  }

  /* One picker row's full summary line, e.g.
     "15:16 – 15:17 · 1 topic · 2 open · Alex, Unknown Inspector". */
  function formatSessionSummary(session) {
    var s = session || {};
    var topicCount = s.topic_count || 0;
    var openCount  = s.open_action_count || 0;
    var parts = [
      s.label || '',
      topicCount + (topicCount === 1 ? ' topic' : ' topics'),
      openCount + ' open',
    ];
    var participants = formatParticipants(s.participants);
    if (participants) parts.push(participants);
    return parts.join(' · ');
  }

  /* Surface excluded topics honestly without naming/linking them (spec —
     "say so quietly", never expose which topic). null when nothing was
     excluded so the caller can skip rendering the note entirely. */
  function formatExcludedNote(excluded) {
    if (!excluded) return null;
    var parts = [];
    var redacted = excluded.redacted || 0;
    var nonWork  = excluded.non_work || 0;
    if (redacted) parts.push(redacted + ' personal topic' + (redacted === 1 ? '' : 's') + ' hidden');
    if (nonWork)  parts.push(nonWork + ' non-work topic' + (nonWork === 1 ? '' : 's') + ' hidden');
    return parts.length ? parts.join(' · ') : null;
  }

  /* ---------- meeting-scoped email draft (#10, mailto v1) --------------- */
  /* One-click hand-off of ONE meeting's OUTSTANDING action items as an
     editable draft in the sender's own mail client. Everything below is a
     pure client-side transform over topics ALREADY in hand (the open
     report's topics, narrowed to the selected session by
     filterTopicsBySession) — it calls NO endpoint, reads no email address,
     and resolves no recipient. See docs/superpowers/specs/
     2026-07-25-meeting-scoped-action-export.md §4 (recommendation: mailto
     first). Recipient auto-resolution (participant name -> users.email) is
     the DEFERRED part (§5, an open privacy decision) and is intentionally
     absent: the mailto `to:` field is ALWAYS empty and no lookup happens.

     NOTHING IS SENT. `mailto:` merely opens the OS default mail client with
     a pre-filled, unsent draft; FieldSight transmits no mail in any path. */

  /* An action item's "done" signal. The authoritative source is the
     action_items.status column (feat/editable-tasks-ui). Default here is
     column-only (status === 'done'); the render site injects a richer
     predicate that also honours the legacy DynamoDB check-off boolean. */
  function defaultActionDone(a) {
    return !!(a && a.status === 'done');
  }

  /* Resolve an action item's free-text deadline to a display string, reusing
     the shared today-adapter resolver when present (absolute YYYY-MM-DD when
     confidently parseable, raw text otherwise, '—' when empty — it NEVER
     guesses a wrong date). Falls back to the raw text under Node/tests where
     FS.api isn't loaded. */
  function resolveDueDisplay(deadline, reportDateISO) {
    var api = window.FS && window.FS.api;
    if (api && typeof api.resolveDeadline === 'function') {
      var r = api.resolveDeadline(deadline, reportDateISO);
      return (r && r.display) || '—';
    }
    var t = deadline == null ? '' : String(deadline).trim();
    return t || '—';
  }

  /* Collect a scope's OUTSTANDING (open) action items, grouped by topic and
     in topic order. Belt-and-suspenders privacy assertion: even though the
     server already excludes redacted / non_work topics from the rendered
     timeline, re-assert it here so a personal item can NEVER reach an
     outbound draft, no matter how the topics list was assembled. `isDone`
     is called as isDone(action, topic_id, index); items it flags are
     skipped (an email of a meeting's *outstanding* actions is the useful
     artefact). Returns [{ topicTitle, items:[action…] }], only for topics
     that still have >=1 open item. */
  function collectSessionActionItems(topics, isDone) {
    var done = isDone || defaultActionDone;
    var groups = [];
    (topics || []).forEach(function (t) {
      if (!t) return;
      if (t.redacted === true) return;            /* never send a redacted topic */
      if (t.work_class === 'non_work') return;    /* never send a personal topic */
      var kept = (t.action_items || []).filter(function (a, idx) {
        if (!a) return false;
        return !done(a, t.topic_id, idx);
      });
      if (kept.length === 0) return;
      groups.push({
        topicTitle: t.topic_title || t.title || 'Untitled topic',
        items: kept,
      });
    });
    return groups;
  }

  /* Union of participant NAMES over the (already exclusion-filtered) topics —
     used only for a body "Discussed with:" line so the sender knows who to
     add. These are LLM-heard names, never email addresses, and never touch
     the `to:` field. */
  function unionSessionParticipants(topics) {
    var seen = {}, out = [];
    (topics || []).forEach(function (t) {
      if (!t || t.redacted === true || t.work_class === 'non_work') return;
      (t.participants || []).forEach(function (p) {
        if (p && !seen[p]) { seen[p] = true; out.push(p); }
      });
    });
    return out;
  }

  /* One item's plain-text line: "- [PRIORITY] <text> — <responsible> (due <date|—>)". */
  function formatActionLine(action, reportDateISO) {
    var a = action || {};
    var text = (a.action != null ? a.action : a.text) || '';
    var priority = String(a.priority || 'medium').toUpperCase();
    var who = a.responsible || 'Unassigned';
    var due = resolveDueDisplay(a.deadline, reportDateISO);
    return '- [' + priority + '] ' + text + ' — ' + who + ' (due ' + due + ')';
  }

  /* Assemble the plain-text body from a prefix of the flattened item entries
     (mailto is plain text — no formatting). Groups by topic (a blank line +
     the topic title before its first item). When `omitted > 0`, a visible
     "… +N more items" line is appended — items are NEVER silently dropped.
     The "Discussed with:" line lists participant NAMES only; the footer's
     deep link doubles as the overflow escape hatch. */
  function assembleEmailBody(entries, omitted, ctx) {
    var lines = [ctx.intro, ''];
    var lastTopic = null;
    (entries || []).forEach(function (e) {
      if (e.topicTitle !== lastTopic) {
        if (lastTopic !== null) lines.push('');
        lines.push(e.topicTitle);
        lastTopic = e.topicTitle;
      }
      lines.push(e.line);
    });
    if (omitted > 0) {
      lines.push('');
      lines.push('… +' + omitted + ' more item' + (omitted === 1 ? '' : 's'));
    }
    if (ctx.participants && ctx.participants.length) {
      lines.push('');
      lines.push('Discussed with: ' + ctx.participants.join(', '));
    }
    lines.push('');
    lines.push(ctx.footer);
    return lines.join('\n');
  }

  /* Build the mailto draft for one meeting's outstanding actions.
     Returns null when there is nothing outstanding to send (caller then
     disables/omits the button — never an empty email). Otherwise returns
     { subject, body, to:'', url, totalItems, includedItems, omittedItems,
     truncated }. The `to:` is ALWAYS '' (recipient resolution deferred).

     Length ceiling: mailto has a practical ~2000-encoded-char limit; we
     budget ~1800 to be safe. When the fully-populated URL would exceed the
     budget we include the largest prefix of items that fits and append a
     visible "… +N more items" line (+ the footer deep link as the escape
     hatch). Because the list is a single meeting this rarely triggers. */
  function buildSessionEmailDraft(opts) {
    opts = opts || {};
    var topics    = opts.topics || [];
    var session   = opts.session || null;
    var date      = opts.date || '';
    var reportDate = opts.reportDate || date;
    var siteName  = opts.siteName || (session && session.site_name) || '';
    var deepLink  = opts.deepLink || '';
    var budget    = opts.budget || 1800;

    var groups = collectSessionActionItems(topics, opts.isDone);
    var totalItems = groups.reduce(function (n, g) { return n + g.items.length; }, 0);
    if (totalItems === 0) return null;

    var sessionLabel = (session && session.label) || 'All day';
    var subject = 'Action items — ' + siteName + ' — ' + sessionLabel
      + (date ? ' (' + date + ')' : '');

    /* Participant NAMES only, for the body — never the recipient field. */
    var participants = (session && session.participants && session.participants.length)
      ? session.participants.filter(Boolean)
      : unionSessionParticipants(topics);

    var ctx = {
      intro: 'Outstanding action items from ' + (siteName ? siteName + ' — ' : '')
        + sessionLabel + (date ? ' (' + date + ')' : '') + ':',
      participants: participants,
      footer: 'Generated from FieldSight' + (deepLink ? ' — ' + deepLink : ''),
    };

    /* Flatten to per-item entries, preserving topic grouping. */
    var entries = [];
    groups.forEach(function (g) {
      g.items.forEach(function (a) {
        entries.push({ topicTitle: g.topicTitle, line: formatActionLine(a, reportDate) });
      });
    });

    function urlFor(k) {
      var body = assembleEmailBody(entries.slice(0, k), totalItems - k, ctx);
      /* to: is ALWAYS empty — no recipients, no email lookup. */
      var url = 'mailto:?subject=' + encodeURIComponent(subject)
        + '&body=' + encodeURIComponent(body);
      return { body: body, url: url };
    }

    /* Largest prefix whose encoded URL fits the budget (greedy, tiny N). */
    var chosen = 0, built = urlFor(totalItems);
    if (built.url.length <= budget) {
      chosen = totalItems;
    } else {
      for (var k = totalItems - 1; k >= 0; k--) {
        var cand = urlFor(k);
        if (cand.url.length <= budget) { chosen = k; built = cand; break; }
        built = cand;   /* keep the smallest as the honest fallback */
      }
    }

    return {
      subject:       subject,
      body:          built.body,
      to:            '',
      url:           built.url,
      totalItems:    totalItems,
      includedItems: chosen,
      omittedItems:  totalItems - chosen,
      truncated:     chosen < totalItems,
    };
  }

  /* ---------- content-correction Phase D: history word diff ------------- */
  /* Whitespace-tokenized LCS word diff. Tokens keep their trailing whitespace
     so joining same+ins reproduces `after` and same+del reproduces `before`.
     Consecutive same-type runs are merged. (unit-tested — tests/content-edit-format) */
  function _tokenizeWords(s) { return (s || '').match(/\S+\s*/g) || []; }
  function diffWords(before, after) {
    var a = _tokenizeWords(before), b = _tokenizeWords(after);
    var m = a.length, n = b.length;
    var dp = [];
    for (var i = 0; i <= m; i++) { var row = []; for (var j = 0; j <= n; j++) row.push(0); dp.push(row); }
    for (var i = m - 1; i >= 0; i--) {
      for (var j = n - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var segs = [];
    function push(type, text) {
      if (segs.length && segs[segs.length - 1].type === type) segs[segs.length - 1].text += text;
      else segs.push({ type: type, text: text });
    }
    var i = 0, j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) { push('same', a[i]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', a[i]); i++; }
      else { push('ins', b[j]); j++; }
    }
    while (i < m) { push('del', a[i]); i++; }
    while (j < n) { push('ins', b[j]); j++; }
    return segs;
  }

  /* content-propagate (item #3) — derive the single before/after TERM an
     EditableText commit just made, reusing diffWords rather than adding a
     second diff implementation. diff_candidates() (the D2 helper behind
     GlossaryConfirm) only flags the "after" side (new proper-noun-like
     tokens present in the saved text but not the prior text) — it never
     pairs a candidate with the surface form it replaced, precisely so that
     side isn't guessed (see GlossaryConfirm's own header note). This walks
     the word diff between the field's old and new full text looking for an
     adjacent del/ins pair (either order — diffWords can emit either side
     first on a tie) whose ins side matches one of the flagged candidates;
     that adjacency is what "replaced" means here. Only ever returns the
     FIRST such pair — a single edit touching two distinct proper nouns in
     one commit is not handled (rare; the user can re-trigger per name by
     editing again). Null when no candidate lines up with a clean
     substitution (e.g. the candidate was purely inserted, not a
     replacement) — correctly means "nothing to propagate". */
  function findCorrectionPair(beforeText, afterText, candidateTerms) {
    var segs = diffWords(beforeText || '', afterText || '');
    var terms = candidateTerms || [];
    for (var i = 0; i < segs.length - 1; i++) {
      var x = segs[i], y = segs[i + 1];
      if (x.type === y.type) continue;
      var delSeg = x.type === 'del' ? x : (y.type === 'del' ? y : null);
      var insSeg = x.type === 'ins' ? x : (y.type === 'ins' ? y : null);
      if (!delSeg || !insSeg) continue;
      var before = delSeg.text.trim();
      var after  = insSeg.text.trim();
      if (before && after && terms.indexOf(after) !== -1) {
        return { before: before, after: after };
      }
    }
    return null;
  }

  /* A UTC content_edits.created_at → NZ local "YYYY/MM/DD HH:MM". Intl with an
     explicit IANA zone is DST-correct and is NOT the BUG-19 naive-parse pattern
     (the input carries a +00:00 offset, so it is unambiguous). */
  function formatEditTime(iso) {
    if (!iso) return '';
    var d = new Date(String(iso).replace(' ', 'T'));
    if (isNaN(d.getTime())) return String(iso);
    var parts = new Intl.DateTimeFormat('en-NZ', {
      timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    var p = {};
    parts.forEach(function (x) { p[x.type] = x.value; });
    var hour = p.hour === '24' ? '00' : p.hour;   // Intl may emit '24' at midnight
    return p.year + '/' + p.month + '/' + p.day + ' ' + hour + ':' + p.minute;
  }

  /* One content_edits row → display parts for ContentHistoryPanel. */
  function formatContentEdit(edit) {
    edit = edit || {};
    return {
      field: edit.field,
      when: formatEditTime(edit.created_at),
      who: edit.actor_name || edit.actor_role || 'Unknown',
      segments: diffWords(edit.before_text || '', edit.after_text || ''),
    };
  }

  /* Pick the most recent date with a report from /api/dates, or null.
     Mirrors the helper in today.js so the two pages share the same
     fallback semantics — when "today" has no report, the user lands
     on the latest available rather than a stale hardcoded date. */
  function findLatestReportDate(datesMap) {
    var keys = Object.keys(datesMap || {}).filter(function (d) {
      return datesMap[d] && datesMap[d].hasReport;
    });
    if (keys.length === 0) return null;
    keys.sort();
    return keys[keys.length - 1];
  }

  function formatDateLabel(yyyymmdd) {
    if (!yyyymmdd) return '';
    var p = yyyymmdd.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    var months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
    var days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    return days[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + months[d.getUTCMonth()] + ' ' + p[0];
  }

  function unfolder(folder) {
    return (folder || '').replace(/_/g, ' ');
  }

  /* ---------- shared header rendering ---------------------------------- */

  function PageHeader(props) {
    var report    = props.report;
    var date      = props.date;
    var user      = props.user;
    var site      = props.site;
    var DatePicker = window.FieldSight.DatePicker;

    var subtitleParts = [];
    if (date) subtitleParts.push(formatDateLabel(date));
    if (user) subtitleParts.push(unfolder(user));
    if (report && report.site) subtitleParts.push(report.site);

    /* Sprint 4.5 — when the URL carries `from=today`, the user arrived
       here by clicking "View daily report" on /today. Surface an
       explicit back link so they don't have to dig for the left-nav. */
    var fromToday = (readRouteParams().from === 'today');

    /* Navigate the timeline route to a new date while preserving the
       active user + site query params (Sprint 2.5 / Phase E; batch A). */
    function onChangeDate(newDate) {
      var params = readRouteParams();
      var u = params.user || (user || '');
      var s = params.site || (site || '');
      var qs = '?date=' + newDate + (s ? '&site=' + encodeURIComponent(s) : '') + (u ? '&user=' + u : '');
      window.FS.Router.navigate('/timeline' + qs);
    }

    return React.createElement('div', {
      className: 'fs-timeline-page__header',
    },
      fromToday ? React.createElement('button', {
        type:      'button',
        className: 'fs-timeline-page__back',
        onClick:   function () { window.FS.Router.navigate('/today'); },
      },
        React.createElement('span', { className: 'fs-timeline-page__back-arrow' },
          '←'),
        React.createElement('span', null, 'Back to Today'),
      ) : null,
      React.createElement('h2', { className: 'fs-timeline-page__title' },
        'Daily Report'),
      React.createElement('div', { className: 'fs-timeline-page__subtitle' },
        subtitleParts.join(' · ')),
      DatePicker && date ? React.createElement(DatePicker, {
        date:        date,
        onChange:    onChangeDate,
        /* monthsRange deliberately omitted → DatePicker's own 24-month
           default. The old `monthsRange: 3` cut /api/dates to a 90-day
           lookback, so a user whose reports are older (e.g. Feb–Mar viewed
           in July) got ZERO calendar dots. */
        /* Dots follow the ACTIVE user so they match the per-user report
           fetch (admin dots were a union across all users — dotted dates
           with no content for the selected user). No user → union stays,
           which pairs with the admin "pick a user" state. */
        user:        user || null,
        /* Batch A — when no user is selected, dots follow the active
           project instead of the (now-dropped) admin union. User wins
           when both are present. */
        site:        (user ? null : site),
      }) : null,
      /* Admin/GM viewing a specific user: offer a way back to the
         user-picker (available_users state) — previously the only way to
         switch users was hand-editing the ?user= query param. Batch A —
         when a project is active, "back" means the aggregated per-site
         day view (drop user, keep site) rather than the raw cross-site
         user list.

         F2 — this back control is URL-based (never window.history.back(),
         which is fragile on deep links: refresh, bookmark, or a link
         shared from elsewhere leaves no browser history entry to pop) and
         ALWAYS renders whenever an admin/gm is viewing a specific user —
         previously it was folded into the same conditional as the
         "View another user" toggle further below, giving the two
         directions of the same bidirectional control different visibility
         rules. Both directions now share one URL contract: drop ?user=,
         keep date + site. */
      (user && canSeeOverview((window.AuthMock && window.AuthMock.currentUser) || {}, site))
        ? React.createElement('button', {
            type:      'button',
            className: 'fs-btn fs-btn--tertiary fs-btn--sm',
            style:     { marginTop: '6px' },
            onClick:   function () {
              /* view=team is what makes this an EXPLICIT choice. Dropping
                 ?user= alone is no longer enough: the resolver now treats
                 "no user" as "show me my own day", so a bare back link
                 would land the caller straight back on themselves. */
              window.FS.Router.navigate('/timeline?view=team&date=' + (date || '')
                + (site ? '&site=' + encodeURIComponent(site) : ''));
            },
          },
            /* Same destination, two different journeys — the label has to say
               which one this is. On your OWN day (where own-day-first now
               lands you by default) the team view is somewhere you have not
               been, so "back" would be a lie; on someone else's it is
               genuinely where you came from. Derived from the folder rather
               than a new prop so the control stays self-contained. */
            (user === callerFolder())
              ? (site ? 'View everyone on this site →' : 'View the team →')
              : (site ? '← All people on this site' : '← Back to overview'))
        : null,
    );
  }

  /* ---------- KpiStrip wired from report metadata ---------------------- */

  /* Total time recorded across the day, for the KPI card. Deliberately NOT the
     mm:ss the audio player uses: "9:29" in a stat tile reads as a clock time,
     and this number is a duration that can exceed an hour. Returns the em dash
     when the metric is absent, so the caller can pass a missing value straight
     through. */
  function fmtRecordedTime(seconds) {
    if (seconds == null) return '—';
    var s = Math.max(0, Math.round(seconds));
    if (s < 60) return s + 's';
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (h > 0) return m > 0 ? h + 'h ' + m + 'm' : h + 'h';
    return m + 'm ' + (s % 60) + 's';
  }

  function ReportKpis(props) {
    var KpiStrip = window.FieldSight.KpiStrip;
    var StatCard = window.FieldSight.StatCard;
    var report = props.report || {};

    /* Counted over the topics ACTUALLY ON SCREEN. With a meeting selected in
       the session picker the list narrows to that meeting, and a strip still
       reading the whole day's "4 Topics" above a one-topic list is not a
       header — it is a contradiction, and it undermines the filter it sits
       above. props.topics is the already-scoped list when there is one. */
    var counted = props.topics || report.topics || [];
    var topics  = counted.length;
    var safetyCount = counted.reduce(function (acc, t) {
      var tagged = (t.category === 'safety') || ((t.safety_flags || []).length > 0);
      return acc + (tagged ? 1 : 0);
    }, 0);
    // These two KPIs read `_report_metadata`, which the legacy nightly daily-report
    // generator populates but the live Aurora/extraction path did not — so every real
    // timeline rendered a hard 0 (Ben_UCPK2 on 2026-07-31: 21 recording rows in the DB
    // behind a "0"). org-api now counts them live off the `recordings` table and emits
    // recordings_processed + duration_seconds.
    //
    // Gate on the FIELD, never on the metadata block: the live path always emits a
    // block ({source, version}), so a block-level check is true on exactly the days
    // this is meant to fix and the misleading 0 comes straight back. An absent field
    // shows "—" (metric unavailable), which is what a day served by an older org-api,
    // or by the reindex builder, still gets. A present 0 renders as 0 — that is a fact
    // ("nothing recorded today"), not a missing metric.
    var meta = report._report_metadata || {};

    /* Recordings and Recorded time are counted per DAY off the recordings
       table; there is no per-session split of them. When the view is scoped
       to one meeting they become unavailable rather than wrong — showing the
       day's totals beside a one-meeting topic count would attribute the whole
       day's recording to that meeting. '—' already means "metric unavailable"
       everywhere else in this strip, so it needs no new vocabulary. */
    var dayOnly = !props.sessionScoped;

    return React.createElement(KpiStrip, null,
      React.createElement(StatCard, {
        value: topics, label: 'Topics',
      }),
      React.createElement(StatCard, {
        value: safetyCount, label: 'Safety', tone: safetyCount > 0 ? 'danger' : 'neutral',
      }),
      React.createElement(StatCard, {
        value: (dayOnly && meta.recordings_processed != null) ? meta.recordings_processed : '—',
        label: 'Recordings',
      }),
      React.createElement(StatCard, {
        value: dayOnly ? fmtRecordedTime(meta.duration_seconds) : '—',
        label: 'Recorded',
      }),
    );
  }

  /* ---------- Empty / not-found states --------------------------------- */

  function NoReportState(props) {
    var Card = window.FieldSight.Card;
    return React.createElement(Card, {
      padding: 'lg', className: 'fs-timeline-page__empty',
    },
      React.createElement(Card.Body, null,
        React.createElement('div', { className: 'fs-timeline-page__empty-title' },
          'No report yet'),
        React.createElement('div', { className: 'fs-timeline-page__empty-body' },
          props.message || 'No report has been generated for this date and user.'),
      ),
    );
  }

  function AvailableUsersState(props) {
    var Card = window.FieldSight.Card;
    return React.createElement(Card, {
      padding: 'lg', className: 'fs-timeline-page__picker',
    },
      React.createElement(Card.Body, null,
        React.createElement('div', { className: 'fs-timeline-page__empty-title' },
          'Pick a user to view the report for ' + formatDateLabel(props.date)),
        React.createElement('ul', { className: 'fs-timeline-page__users' },
          (props.users || []).map(function (u) {
            return React.createElement('li', { key: u },
              React.createElement('button', {
                type: 'button',
                className: 'fs-timeline-page__user',
                onClick: function () {
                  var qs = '/timeline?date=' + props.date + '&user=' + u
                    + (props.site ? '&site=' + encodeURIComponent(props.site) : '');
                  window.FS.Router.navigate(qs);
                },
              }, unfolder(u)),
            );
          }),
        ),
        /* Escape hatch — arriving here via the "← Back to overview" /
           "View another user ↺" toggle left no way back to the report
           being viewed (user feedback 2026-07-06).
           F2 — URL-based, not window.history.back(): a deep link straight
           into this picker state has no browser history entry to pop, so
           history.back() silently did nothing. Drop ?user= (there wasn't
           one set here anyway) and keep date/site — if no user was ever
           set, this is just '/timeline?date=...'. */
        React.createElement('button', {
          type:      'button',
          className: 'fs-btn fs-btn--tertiary fs-btn--sm',
          style:     { marginTop: '10px' },
          onClick:   function () {
            window.FS.Router.navigate('/timeline?date=' + (props.date || '')
              + (props.site ? '&site=' + encodeURIComponent(props.site) : ''));
          },
        }, '← Back'),
      ),
    );
  }

  /* Batch A — multi-project admin/gm caller with no project chosen yet:
     pick which site's day to view (mirrors AvailableUsersState's card
     shape). Only rendered once sitesList has resolved to more than one
     option — see TimelineMiddleColumn's render-branch ordering. */
  function SitePickerState(props) {
    var Card = window.FieldSight.Card;
    return React.createElement(Card, {
      padding: 'lg', className: 'fs-timeline-page__picker',
    },
      React.createElement(Card.Body, null,
        React.createElement('div', { className: 'fs-timeline-page__empty-title' },
          'Pick a project'),
        React.createElement('ul', { className: 'fs-timeline-page__users' },
          (props.sitesList || []).map(function (s) {
            return React.createElement('li', { key: s.site_id },
              React.createElement('button', {
                type:      'button',
                className: 'fs-timeline-page__user',
                onClick:   function () {
                  if (props.onChangeSite) props.onChangeSite(s.site_id);
                },
              },
                s.name,
                s.location ? React.createElement('span', {
                  style: { display: 'block', fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' },
                }, s.location) : null,
              ),
            );
          }),
        ),
      ),
    );
  }

  /* =====================================================================
     AggregatedDayView — site-wide fan-out (Batch A core)
     ---------------------------------------------------------------------
     Rendered by TimelineMiddleColumn when a project is chosen but no
     specific person is (site && !user). Fans out getSiteUsers ×
     getTimeline across every user on the site (bounded concurrency via
     pooledAll) and renders one section per person who has a report for
     the date, reusing ReportKpis / ExecutiveSummaryCard / TopicCard
     exactly as the single-user daily view does below. AskChat is
     intentionally omitted — it's scoped to a single report; cross-report
     Q&A is Phase 4.
     ===================================================================== */
  /* ---- alerts Ask route (routing spec §3.5) ------------------------------
     AskChat is mounted in THREE places on this page — once in
     AggregatedDayView and twice in TimelineRightDetail — and only the page's
     day view is in a position to fetch the programme. Wiring the provider to
     one mount would have made the route work on one route and be silently
     absent on the other two, which is the same mistake the topic-link
     placement made and had to be corrected for.

     So the tasks live at module scope, written by whichever view fetched
     them, and every mount reads the same provider. An empty cache means the
     route does not exist and the question goes to the agent — the designed
     degradation, not a bug. */
  var _programmeTasks = null;

  function makeAlertsProvider(suggestions) {
    if (!_programmeTasks || !_programmeTasks.length) return null;
    return function () {
      var M = window.FS.api.programmeMentions;
      var today = window.FS.api.todayNZDT();
      return {
        tasks:  _programmeTasks,
        today:  today,
        /* state:'all' is what this page fetches (see the suggestions effect),
           so silence is claimable. Passing null instead would be safe but
           would drop the most useful section. */
        silent: M ? M.silentTasks(_programmeTasks, M.indexByTask(suggestions || []),
                                  { today: today,
                                    coverage: { states: 'all', from: null, to: null } })
                  : null,
        /* No baseline is loaded on this page, so lateness is reported as
           unchecked rather than as "on time". */
        lateness: null,
      };
    };
  }

  function AggregatedDayView(props) {
    var fs                   = window.FieldSight;
    var ErrorBanner          = fs.ErrorBanner;
    var ExecutiveSummaryCard = fs.ExecutiveSummaryCard;
    var TopicCard            = fs.TopicCard;

    var refState = React.useState({ status: 'loading' });
    var state    = refState[0];
    var setState = refState[1];

    var retryRef   = React.useState(0);
    var retryCount = retryRef[0];
    var setRetry   = retryRef[1];

    /* Project 3 §2 — matcher suggestions for this site, so a topic can show
       that what was said reached the programme.

       state:'all' here, unlike the Programme page's review queue which wants
       'pending'. The point on this side is that the link EXISTS, and a
       CONFIRMED suggestion is the strongest evidence of that — fetching only
       pending ones would hide the link at exactly the moment it was accepted.

       Failure is silent by design: this is an annotation, and a topic without
       it must still render. */
    var suggRef        = React.useState([]);
    var suggestions    = suggRef[0];
    var setSuggestions = suggRef[1];

    React.useEffect(function () {
      var mocked = window.FS.api.useMocks;
      var site = window.FS.siteContext ? window.FS.siteContext.get() : null;
      if (!site && !mocked) { setSuggestions([]); return undefined; }
      var cancelled = false;
      window.FS.api.programme.getSuggestions({ site: site, state: 'all' })
        .then(function (res) {
          if (!cancelled) setSuggestions((res && res.suggestions) || []);
        })
        .catch(function () { if (!cancelled) setSuggestions([]); });
      return function () { cancelled = true; };
    }, [props.date]);

    /* Programme tasks for the alerts Ask route (routing spec §3.5). The chat
       already lives on this page; the alert signals did not. One extra call
       makes the route reachable, which is cheaper than putting a second chat
       surface on the Programme page just to be near the data.

       Failure is silent and the route simply stays unavailable — the answer
       then goes to the agent, which is today's behaviour. */
    var progRef        = React.useState(null);
    var programmeTasks = progRef[0];
    var setProgrammeTasks = progRef[1];

    React.useEffect(function () {
      var site = window.FS.siteContext ? window.FS.siteContext.get() : null;
      if (!site && !window.FS.api.useMocks) { setProgrammeTasks(null); return undefined; }
      var cancelled = false;
      window.FS.api.programme.getProgramme(site)
        .then(function (res) {
          if (cancelled) return;
          var leaves = (res && res.programme && res.programme.leaves) || null;
          _programmeTasks = leaves;
          setProgrammeTasks(leaves);
        })
        .catch(function () { if (!cancelled) setProgrammeTasks(null); });
      return function () { cancelled = true; };
    }, [props.date]);

    var mentionsByTopic = React.useMemo(function () {
      var m = window.FS.api.programmeMentions;
      return m ? m.indexByTopic(suggestions) : {};
    }, [suggestions]);

    /* life-conversation separation (Q2) — optimistic redaction/revert patches,
       same mechanism as TimelineMiddleColumn but applied PER SECTION here. Keyed
       by durable topic_row_id; merged over each section's report before
       partitioning so a removed/restored topic switches bucket instantly, with
       no refetch of this view's expensive per-user fan-out. */
    var overridesRef = React.useState({});
    var overrides    = overridesRef[0];
    var setOverrides = overridesRef[1];

    /* fix/action-checkoff-sync (Bug 1) — this view renders ONE date
       (props.date) fanned out across every user on the site, so a
       single getActions(date) call covers every section's TopicCards.
       user-dimension audit key plan (docs/superpowers/plans/2026-07-13-
       user-dimension-audit-key.md, Task 5) — the audit key NOW carries
       the section owner's folder (see the TopicCard mount + bus
       subscription below), so two sections' topic 0 / action 0 on the
       same date no longer collide. Mirrors TimelineMiddleColumn's own
       actions fetch (~line 743) so checked state actually shows here
       instead of the hardcoded {} this view used to pass down. */
    var refActionsState = React.useState({});
    var actionsMap    = refActionsState[0];
    var setActionsMap = refActionsState[1];

    React.useEffect(function () {
      var cancelled = false;
      window.FS.api.actions.getActions(props.date).then(function (res) {
        if (cancelled) return;
        setActionsMap((res && res.actions) || {});
      });
      return function () { cancelled = true; };
    }, [props.date]);

    /* fix/action-checkoff-sync (Bug 1) — mirrors TimelineMiddleColumn's
       bus subscription (~line 800) so a toggle made anywhere (this
       view's own TopicCards, the right-detail OverviewTab, or a tick
       made from the single-user timeline for the same date) updates
       every section's TopicCard live, including ones currently
       collapsed/unmounted. user-dimension audit key plan (Task 5) — the
       bus payload now carries user_folder, and the map key is derived
       via FS.api.actions.actionKey(payload.user_folder, …) so two
       different sections' topic 0 / action 0 on the same date land on
       distinct composite keys instead of colliding. */
    React.useEffect(function () {
      var bus = window.FS && window.FS.actionsBus;
      if (!bus) return undefined;
      var myDate = props.date;
      return bus.subscribe(function (payload) {
        if (!payload || payload.date !== myDate) return;
        setActionsMap(function (cur) {
          var key = window.FS.api.actions.actionKey(payload.user_folder, payload.topic_id, payload.action_index);
          var next = Object.assign({}, cur || {});
          next[key] = {
            checked:    !!payload.checked,
            checked_by: payload.checked_by,
            checked_at: payload.checked_at,
          };
          return next;
        });
      });
    }, [props.date]);

    React.useEffect(function () {
      var cancelled = false;
      setState({ status: 'loading' });

      Promise.all([
        window.FS.api.sites.getSiteUsers(props.site),
        /* aggregation-attribution fix: recorders whose topics are site-tagged
           via G5b (recordings.site_id) but who are NOT site members. Without
           this union, a non-member recorder's topics (e.g. an admin's) vanish
           from the site view even though ?user=<folder> shows them. Degrade to
           members-only if the contributors call fails. */
        window.FS.api.org.getSiteContributors(props.site, props.date)
          .catch(function () { return { folders: [] }; }),
      ]).then(function (both) {
        if (cancelled) return;
        var users  = (both[0] && both[0].users) || [];
        /* folder → section user object. Members first (richer: name / role /
           device), then contributor-only folders as synthetic entries so a
           non-member recorder still gets a section. Deduped by folder. */
        var byFolder = {};
        users.forEach(function (u) {
          if (u && u.folder_name) byFolder[u.folder_name] = u;
        });
        ((both[1] && both[1].folders) || []).forEach(function (folder) {
          if (folder && !byFolder[folder]) {
            byFolder[folder] = { folder_name: folder, name: unfolder(folder), role: null };
          }
        });
        var thunks = Object.keys(byFolder).map(function (folder) {
          var u = byFolder[folder];
          return function () {
            return window.FS.api.timeline.getTimeline({ date: props.date, user: folder })
              .then(function (r) { return { user: u, report: r }; });
          };
        });
        return window.FS.api.pooledAll(thunks, 8).then(function (raw) {
          if (cancelled) return;
          var results = raw.filter(Boolean);
          if (thunks.length > 0 && results.length === 0) {
            setState({
              status:  'error',
              message: 'Could not load reports — all requests failed. Please retry.',
              retry:   function () { setRetry(function (n) { return n + 1; }); },
            });
            return;
          }
          var sections = results.filter(function (x) {
            return x.report && !x.report._notFound && !x.report.available_users && !x.report._accessDenied;
          }).sort(function (a, b) {
            var an = (a.report.user_name || a.user.name || '').toLowerCase();
            var bn = (b.report.user_name || b.user.name || '').toLowerCase();
            return an < bn ? -1 : (an > bn ? 1 : 0);
          });
          setState({ status: 'ok', sections: sections });
          /* Retire optimistic patches the fresh fan-out has caught up to
             (across every section's topics). */
          var freshTopics = [];
          sections.forEach(function (s) {
            (s.report.topics || []).forEach(function (t) { freshTopics.push(t); });
          });
          setOverrides(function (cur) { return reconcileTopicOverrides(cur, freshTopics); });
        });
      }).catch(function () {
        if (cancelled) return;
        setState({
          status:  'error',
          message: 'Could not load reports — all requests failed. Please retry.',
          retry:   function () { setRetry(function (n) { return n + 1; }); },
        });
      });

      return function () { cancelled = true; };
    }, [props.site, props.date, retryCount]);

    /* Q2 — apply optimistic redaction/revert patches dispatched by the shared
       right-detail review buttons, and reset them when the viewed day/site
       changes. Mirrors TimelineMiddleColumn; both views' listeners coexist
       harmlessly (only the mounted-and-rendered view's overrides are read). */
    React.useEffect(function () {
      function onRefresh(e) {
        var d = e && e.detail;
        if (d && d.topicRowId && d.patch) {
          setOverrides(function (cur) {
            var next = Object.assign({}, cur);
            next[d.topicRowId] = Object.assign({}, cur[d.topicRowId], d.patch);
            return next;
          });
          return;   // patch alone moves the topic; skip the expensive refetch
        }
        setRetry(function (n) { return n + 1; });
      }
      window.addEventListener('fs:timeline-refresh', onRefresh);
      return function () { window.removeEventListener('fs:timeline-refresh', onRefresh); };
    }, []);
    React.useEffect(function () { setOverrides({}); }, [props.site, props.date]);

    if (state.status === 'loading') {
      return React.createElement('div', { className: 'fs-timeline-page__loading' },
        'Loading reports…');
    }

    if (state.status === 'error') {
      return ErrorBanner
        ? React.createElement(ErrorBanner, {
            message:   state.message,
            retryable: true,
            onRetry:   state.retry,
          })
        : React.createElement(NoReportState, { message: state.message });
    }

    var sections = state.sections || [];
    if (sections.length === 0) {
      return React.createElement(NoReportState, {
        message: 'No reports for this project on ' + formatDateLabel(props.date),
      });
    }

    /* topic_id is per-report sequential (0,1,2…) — every section has a
       topic 0. Selection identity in the aggregated view must therefore
       be the NAMESPACED sel.id ('topic_<folder>_<n>'), never the bare
       topic_id, or clicking A's topic 0 highlights B's and C's too
       (Fable review A-1/A-2). */
    var selectedAggId = props.selectedItem && props.selectedItem.kind === 'topic'
      ? props.selectedItem.id
      : null;

    /* life-conversation separation (Q2) — same content:edit-OR-own-report gate
       the single-user view and the detail-pane review buttons use, so a
       reviewer's per-section "Removed / personal" area shows exactly where the review
       buttons do. hasContentEditPerm is caller-level; isOwnReport is per-section
       (computed inside the map). */
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
    var hasContentEditPerm = !!(window.FS && window.FS.can && window.FS.P
        && window.FS.can(caller, window.FS.P('content', 'edit')));

    return React.createElement(React.Fragment, null,
      sections.map(function (section) {
        var report         = section.report;
        var sectionUser     = section.user.folder_name;
        var sectionUserName = report.user_name;
        var roleLabel = section.user.role
          ? section.user.role.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); })
          : null;

        /* Q2 — merge optimistic patches, then split this section's topics into
           the visible list and its own "Removed / personal" area. */
        var _p = partitionTopics(applyTopicOverrides(report.topics, overrides));
        var isOwnReport = !!(caller && caller.name
            && window.FS.api.folderName(caller.name) === sectionUser);
        var sectionCanEdit = hasContentEditPerm || isOwnReport;

        return React.createElement('div', {
          key:       sectionUser,
          className: 'fs-timeline-page__person-section',
          style:     { marginBottom: '28px' },
        },
          React.createElement('div', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' },
          },
            React.createElement('div', null,
              React.createElement('div', {
                style: { fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' },
              }, unfolder(section.report.user_name || (section.user && section.user.name) || '')),
              roleLabel ? React.createElement('div', {
                style: { fontSize: '12px', color: 'var(--text-tertiary)' },
              }, roleLabel) : null,
            ),
            /* The day's outstanding actions for this person, as a mail draft.
               Inlined here because it was previously reachable ONLY by first
               going into the single-person view — behind a button labelled
               "View only", which reads as "you may only look". The most
               common hand-off on the page should not be hidden behind a
               control that says the opposite of what it does.

               session: null is the whole-day scope buildSessionEmailDraft
               already supports (it labels the draft "All day" and unions the
               participants across topics), which is exactly this view's
               scope. The button disables itself when nothing is outstanding.

               "Generate report" is NOT inlined alongside it: that flow is
               per-MEETING by construction (GenerateReportButton returns null
               without a session, and the backend scopes the export to one
               session's topic_row_ids). A day can hold several meetings, so
               there is no correct session to pass from here — it stays in
               the single-person view where a meeting can actually be picked. */
            React.createElement('div', {
              style: { display: 'flex', alignItems: 'center', gap: '8px' },
            },
              React.createElement(DraftEmailButton, {
                topics:     _p.visible,
                session:    null,
                /* THIS section's recorder — photo S3 keys are per-folder, so
                   the caller's own folder here would resolve someone else's
                   pictures prefix (or none). */
                userFolder: sectionUser,
                siteName:   report.site,
                date:       props.date,
                reportDate: report.report_date || props.date,
                deepLink:   (typeof window !== 'undefined' && window.location)
                  ? window.location.href : '',
                /* Mirrors the single-person view's _isActionDone: the Aurora
                   status column wins when present, else the check-off overlay.
                   Keyed on THIS section's folder — the audit key carries a user
                   dimension (#23), so passing the caller's folder here would
                   read another person's check-offs. */
                isDone: function (a, topicId, idx) {
                  if (a && a.status) return a.status === 'done';
                  var st = window.FS.api.actions.lookupAction(
                    actionsMap, sectionUser, topicId, idx);
                  return !!(st && st.checked);
                },
              }),
              React.createElement('button', {
                type:      'button',
                className: 'fs-btn fs-btn--tertiary fs-btn--sm',
                /* Was "View only". It navigates to this person's own day, which
                   carries MORE than this section does (date picker, meeting
                   picker, Generate report, Ask, audio/video) — the old label
                   advertised a permission limit that does not exist. */
                title:     "Open this person's day — meetings, report, Ask, audio",
                onClick:   function () {
                  window.FS.Router.navigate('/timeline?site=' + encodeURIComponent(props.site)
                    + '&date=' + props.date + '&user=' + encodeURIComponent(sectionUser));
                },
              }, 'Open'),
            ),
          ),
          React.createElement(ReportKpis, { report: report }),
          (report.executive_summary || []).length > 0
            ? React.createElement(ExecutiveSummaryCard, { bullets: report.executive_summary })
            : null,
          React.createElement('div', { className: 'fs-timeline-page__section-label' },
            'Topics'),
          React.createElement('div', { className: 'fs-timeline-page__topics' },
            _p.visible.map(function (topic) {
              /* Project 3 §2. mentionsForTopic, never
                 mentionsByTopic[topic.topic_id]: the report side's topic_id
                 is per-report sequential (every section has a topic 0) while
                 a suggestion's is topics.id, a uuid. The durable report-side
                 key is topic_row_id and the module owns that distinction.

                 This is the SECOND of two TopicCard mounts in this component.
                 Wiring only one is how a feature ends up working on one
                 route and silently absent on the other. */
              var _mentions = window.FS.api.programmeMentions
                ? window.FS.api.programmeMentions.mentionsForTopic(topic, mentionsByTopic)
                : [];
              var _linked = _mentions[0];
              return React.createElement(TopicCard, {
                key:           topic.topic_id,
                topic:         topic,
                date:          props.date,
                actionState:   actionsMap,
                userFolder:    sectionUser,
                programmeTaskName: _linked ? _linked.task_name : null,
                programmeTaskId:   _linked ? _linked.task_id : null,
                onOpenProgrammeTask: function (taskId) {
                  window.location.hash = '#/programme?task=' + encodeURIComponent(taskId || '');
                },
                selected:      selectedAggId === ('topic_' + sectionUser + '_' + topic.topic_id),
                defaultOpen:   false,
                highlight:     false,
                flagHighlight: null,
                onSelect:      function () {
                  if (props.onSelect) {
                    props.onSelect({
                      kind:       'topic',
                      /* Namespaced by section owner — bare topic_id collides
                         across sections AND leaves the right pane's
                         reset-to-Overview effect (deps [sel.id]) stuck when
                         switching between two people's same-numbered topic. */
                      id:         'topic_' + sectionUser + '_' + topic.topic_id,
                      topic_id:   topic.topic_id,
                      topic:      topic,
                      date:       props.date,
                      /* RED LINE — this SECTION's own user, never the
                         page-level `user` (undefined in this branch).
                         Wrong value here shows person A's topics next to
                         person B's transcript/audio/photos. */
                      user:       sectionUser,
                      user_name:  sectionUserName,
                    });
                  }
                },
              });
            }),
          ),

          /* life-conversation separation (Q2) — this section's collapsed
             "Removed / personal" area, mirroring the single-user view. Reviewer-only
             (sectionCanEdit); redacted topics stay recoverable via RemovedTopic.
             Keys are namespaced by section owner (topic_id is per-report). */
          _p.removed.length && sectionCanEdit ? React.createElement('details', {
            className: 'fs-timeline-page__removed',
          },
            React.createElement('summary', null, 'Removed / personal (' + _p.removed.length + ')'),
            _p.removed.map(function (topic) {
              return React.createElement(RemovedTopic, {
                key:   sectionUser + '_' + topic.topic_id,
                topic: topic,
              });
            }),
          ) : null,
        );
      }),
    );
  }

  /* =====================================================================
     TimelineMiddleColumn
     ===================================================================== */
  function TimelineMiddleColumn(props) {
    var fs = window.FieldSight;
    var ExecutiveSummaryCard = fs.ExecutiveSummaryCard;
    var TopicCard            = fs.TopicCard;

    var refParams = React.useState(function () { return readRouteParams(); });
    var params    = refParams[0];
    var setParams = refParams[1];

    React.useEffect(function () {
      return window.FS.Router.subscribe(function (route) {
        setParams(Object.assign({}, route.params || {}));
      });
    }, []);

    /* Batch A2 Task 2 — the header's /timeline special case rewrites the
       URL on change (app-shell.js onHeaderSiteChange), which the Router
       subscription above already catches. This subscription covers
       context changes made elsewhere (another page, or a future caller
       of FS.siteContext.set) that don't touch /timeline's own URL —
       re-resolve params so the site-resolution block below picks up the
       new value. */
    React.useEffect(function () {
      if (!(window.FS && window.FS.siteContext)) return undefined;
      return window.FS.siteContext.onChange(function () {
        setParams(Object.assign({}, (window.FS.Router.getCurrentRoute() || {}).params || {}));
      });
    }, []);

    /* Sprint 6.6.4 — deep-link target topic. When /safety or /quality
       launches into /timeline?topic=N, we auto-open + flash that
       topic; all other topics auto-collapse (focus mode). Parsed
       once per params change so navigating again resets the focus. */
    var targetTopicId = params.topic != null && params.topic !== ''
      ? String(params.topic)
      : null;

    /* Search results / Ask citations deep-link by topic TITLE, because the
       backend has the Aurora topic UUID, not the report's per-report
       sequential topic_id. Resolve the SAME spotlight by matching a report
       topic's title. matchesTopicTarget() folds both keys together. */
    var targetTopicTitle = params.topicTitle != null && params.topicTitle !== ''
      ? String(params.topicTitle)
      : null;
    var hasTopicTarget = targetTopicId !== null || targetTopicTitle !== null;
    function matchesTopicTarget(t) {
      return (targetTopicId !== null && String(t.topic_id) === String(targetTopicId))
          || (targetTopicTitle !== null && (t.topic_title || '') === targetTopicTitle);
    }

    /* cross-project deep-link project sync: a route carrying &site (a cross-project
       search result or Ask citation) points the top-bar project selector at
       that project, so the selector always matches the content shown. Ref-
       guarded to fire once per site change, not on every render. */
    var syncedSiteRef = React.useRef(null);
    React.useEffect(function () {
      var s = params.site;
      if (!s || syncedSiteRef.current === s) return;
      syncedSiteRef.current = s;
      if (window.FS.siteContext && window.FS.siteContext.get() !== s) {
        window.FS.siteContext.set(s);
      }
    }, [params.site]);

    /* Sprint 6.7.2 — deeper precision: when /safety includes
       &flag=<idx>, highlight that specific safety_flag inside the
       target topic (not the whole topic card). null = whole-topic
       flash from 6.6.4. */
    var targetFlagIdx = params.flag != null && params.flag !== ''
      ? parseInt(params.flag, 10)
      : null;
    if (targetFlagIdx !== null && isNaN(targetFlagIdx)) targetFlagIdx = null;

    /* A2-2 — Ask citation transcript-line deep link. An absolute
       "HH:MM:SS" time-of-day string (same space as transcript segment
       .start/.time_label — transcript-list.js), or null. Threaded through
       the auto-select effect below into selectedItem.turnTime so it only
       ever reaches the ONE topic being spotlighted (TimelineRightDetail
       reads sel.turnTime, never the raw route param) — a topic opened by
       hand never gets a stray flash. */
    var targetTurnTime = params.turnTime != null && params.turnTime !== ''
      ? String(params.turnTime)
      : null;

    /* Resolve effective (date, user, site) honouring the three-tier role
       rule (Task 4 — carried over from the Task 3 review):
         • worker                        → forced to self, always (line
                                            below, unconditional).
         • site_manager / project_manager → forced to self ONLY when no
                                            site is anchored. Once a site
                                            IS anchored (URL ?site=, the
                                            persisted last-viewed choice,
                                            or the single-site auto-anchor
                                            further below) they fall
                                            through to AggregatedDayView
                                            instead — the backend already
                                            scopes their getSiteUsers /
                                            getTimeline calls to
                                            self + own-site workers
                                            (site_manager) or their
                                            managed sites (pm), so nothing
                                            unsafe is exposed.
         • admin / gm                    → always free; isAdminLike
                                            short-circuits both checks. */
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
    var date   = params.date;            /* may be undefined → bootstrap resolves */
    var user   = params.user;

    /* One-shot sites list fetch (mirrors AvailableUsersState's lack of
       gating — mock getSites() always resolves; no useMocks branch here
       since the api layer itself owns that switch). Declared BEFORE the
       site resolution so the single-site auto-anchor can participate in
       it — anchoring after the role-forcing checks left a single-site
       site_manager/PM forced to self on their very first visit (Task 4
       review carry-over). */
    var refSitesList = React.useState([]);
    var sitesList    = refSitesList[0];
    var setSitesList = refSitesList[1];
    React.useEffect(function () {
      var cancelled = false;
      /* Phase 2 (Aurora read consolidation): source the sites list from
         org.getOrgSites() (Aurora-accessible sites, {sites:[{site_id,...}]}
         via _toPageSite — same shape this page already reads below), not
         the legacy report-gateway /sites list — so the single-site
         auto-anchor and default site come from the caller's ACTUAL Aurora
         memberships, never the legacy global mapping. */
      window.FS.api.org.getOrgSites()
        .then(function (res) {
          if (cancelled) return;
          setSitesList((res && res.sites) || []);
        })
        .catch(function () {
          if (!cancelled) setSitesList([]);
        });
      return function () { cancelled = true; };
    }, []);

    /* Batch A2 Task 2 — resolve the active site/project up front: URL wins,
       then the global FS.siteContext (header-driven, shared across pages),
       then the single-site auto-anchor (a caller scoped to exactly one
       project never had to choose; no navigate/persist — persisting would
       poison localStorage for a caller who later gains more sites).
       Deliberately computed BEFORE the role-forcing checks below — they
       need to know whether a site is anchored, including the auto-anchor
       case once sitesList lands and re-renders. */
    var site = params.site || (window.FS.siteContext && window.FS.siteContext.get())
      || (sitesList.length === 1 ? sitesList[0].site_id : null);

    /* Stale-anchor guard (Fable review B-2): a persisted/URL site the
       caller can no longer access (account switch, revoked) renders a
       blank selector and a misleading empty aggregated view. Once the
       sites list has landed, an unknown site resolves to null and the
       stale context is cleared (idempotent — safe in render). */
    if (site && sitesList.length > 0
        && !sitesList.some(function (s) { return s.site_id === site; })) {
      /* Only clear the CONTEXT when the stale value actually came from it
         (Fable review #1b): a garbage/revoked ?site= in a deep link must
         not destroy the user's valid global selection — and set() is now
         deduped, so this render-phase call can't loop either way. */
      if (!params.site && window.FS.siteContext) window.FS.siteContext.set(null);
      site = null;
    }

    /* Whose day are we on?
         ?user=X     → that person (explicit; how "Open" navigates)
         ?view=team  → the multi-person view (explicit; how "back" navigates)
         neither     → YOUR OWN day.

       The default used to be the team view for anyone with a site anchored,
       which made "see what I recorded" — the single most common thing a
       recorder opens this page for — cost an extra click and a scan down a
       list of colleagues to find yourself. Own-day-first inverts that; the
       team view is one labelled control away, and `view=team` keeps it a
       real URL so it survives refresh, bookmarks and shared links.

       A caller whose own day turns out to be EMPTY falls through to the team
       view in the fetch effect below (managers often record nothing
       themselves). That fallback is deliberately state-only, not a redirect:
       the URL stays "no explicit choice", so moving to a date where they DID
       record shows their own day again rather than stranding them on the
       team view. */
    var _scope        = resolveTimelineScope(caller, params, callerFolder());
    user              = _scope.user;
    var selfDefaulted = _scope.selfDefaulted;

    /* Switching projects resets the active person — a user picked for
       one site rarely maps onto another. Persists the choice via the
       global FS.siteContext so it's shared with the header selector and
       every other site-scoped page (Batch A2 Task 2). Still needed here
       for SitePickerState, which calls this directly. */
    function onChangeSite(siteId) {
      if (window.FS.siteContext) window.FS.siteContext.set(siteId || null);
      var qs = siteId
        ? '?site=' + encodeURIComponent(siteId) + (date ? '&date=' + date : '')
        : '';
      window.FS.Router.navigate('/timeline' + qs);
    }

    /* Project 3 §2 — matcher suggestions, so a topic can show that what was
       said reached the programme. Mirrors AggregatedDayView's fetch (same
       state:'all' reasoning: the point here is that the LINK EXISTS, and a
       confirmed suggestion is the strongest evidence of that, so fetching
       only pending ones would hide the link at the moment it was accepted).

       This view rendered `mentionsByTopic` without ever declaring it — the
       block was carried over from AggregatedDayView, comment and all, into a
       component that has neither the fetch nor the index. The result was a
       bare ReferenceError inside the topic map, which React turns into an
       unmounted subtree: EVERY single-person timeline was a white screen, not
       just the ones reached through "Open". The variable is now real.

       Failure is silent by design: this is an annotation, and a topic without
       it must still render. */
    var suggRef        = React.useState([]);
    var suggestions    = suggRef[0];
    var setSuggestions = suggRef[1];

    React.useEffect(function () {
      var mocked = window.FS.api.useMocks;
      var suggSite = window.FS.siteContext ? window.FS.siteContext.get() : null;
      if (!suggSite && !mocked) { setSuggestions([]); return undefined; }
      var cancelled = false;
      window.FS.api.programme.getSuggestions({ site: suggSite, state: 'all' })
        .then(function (res) {
          if (!cancelled) setSuggestions((res && res.suggestions) || []);
        })
        .catch(function () { if (!cancelled) setSuggestions([]); });
      return function () { cancelled = true; };
    }, [date]);

    var mentionsByTopic = React.useMemo(function () {
      var m = window.FS.api.programmeMentions;
      return m ? m.indexByTopic(suggestions) : {};
    }, [suggestions]);

    var refState = React.useState({ status: 'loading' });
    var state    = refState[0];
    var setState = refState[1];

    var retryRef   = React.useState(0);
    var retryCount = retryRef[0];
    var setRetry   = retryRef[1];

    /* life-conversation separation (Q2) — optimistic redaction/revert patches
       keyed by durable topic_row_id, merged over the fetched report so a
       removed/restored topic switches bucket instantly and doesn't flicker on
       the stale post-write refetch; reconciled away as the org-api read catches
       up (see applyTopicOverrides / reconcileTopicOverrides above). */
    var overridesRef = React.useState({});
    var overrides    = overridesRef[0];
    var setOverrides = overridesRef[1];

    /* session picker (feat 5) — GET /api/org/sessions is a SEPARATE fetch
       from getTimeline, keyed on the settled report (state.report only
       changes once per successful load/retry, never per render), so this
       effect fires once per (date, user) — narrowing to a session below is
       pure client-side filtering over topics already in hand and issues no
       further request of its own. */
    var refSessions      = React.useState({ status: 'idle', sessions: [], excluded: null });
    var sessionsState     = refSessions[0];
    var setSessionsState  = refSessions[1];

    var refSelectedSession    = React.useState(null);   /* null = "All day" */
    var selectedSessionId     = refSelectedSession[0];
    var setSelectedSessionId  = refSelectedSession[1];

    React.useEffect(function () {
      if (state.status !== 'ok') return undefined;
      var rpt = state.report;
      var hasReportNow = !!(rpt && !rpt._notFound && !rpt.available_users);
      if (!hasReportNow) { setSessionsState({ status: 'idle', sessions: [], excluded: null }); return undefined; }
      /* Same owner-folder resolution as ownerFolder further below (self-view
         has user===null; report.user_name is always the real owner). */
      var folder = user || (rpt.user_name && window.FS.api.folderName(rpt.user_name)) || null;
      if (!folder || !date) { setSessionsState({ status: 'idle', sessions: [], excluded: null }); return undefined; }
      var cancelled = false;
      setSessionsState({ status: 'loading', sessions: [], excluded: null });
      window.FS.api.org.getSessions({ date: date, user: folder }).then(function (res) {
        if (cancelled) return;
        if (!res || res._accessDenied || res._notFound) {
          setSessionsState({ status: 'ok', sessions: [], excluded: null });
          return;
        }
        var loaded = res.sessions || [];
        setSessionsState({ status: 'ok', sessions: loaded, excluded: res.excluded || null });
        /* Deep link: ?session=<id> preselects that meeting in the picker, so
           arriving from Today's "Open" lands on THAT meeting's topics instead
           of an unfiltered day the caller then has to scroll. Applied here
           rather than at mount because the picker can only hold a session that
           actually exists in the loaded list — a stale or cross-day id would
           otherwise filter everything away and render a blank day, which is
           strictly worse than showing all of it. Silently ignored when it does
           not match; "All day" remains the honest fallback. */
        var wanted = params.session;
        if (wanted && loaded.some(function (s) { return s.session_id === wanted; })) {
          setSelectedSessionId(wanted);
        }
      }).catch(function () {
        if (!cancelled) setSessionsState({ status: 'ok', sessions: [], excluded: null });
      });
      return function () { cancelled = true; };
    }, [date, user, state.status, state.report]);

    /* A new date/user has entirely different session_ids — drop any active
       filter rather than silently show zero topics against a stale id. */
    React.useEffect(function () { setSelectedSessionId(null); }, [date, user]);

    /* Sprint 2.8 (Phase H) — when both a daily report and meeting
       minutes exist for the date, the user picks which to view. */
    var refView = React.useState('daily');
    var view    = refView[0];
    var setView = refView[1];

    /* M-2 — when no date is in the URL, resolve one before fetching:
       try today (NZDT), fall back to the most recent date in
       /api/dates, then navigate so the URL reflects what the user is
       looking at. The fetch effect below sits in 'loading' until the
       redirect lands. */
    React.useEffect(function () {
      if (date) return undefined;
      var cancelled = false;
      var qsUser = user ? '&user=' + encodeURIComponent(user) : '';
      var qsSite = site ? '&site=' + encodeURIComponent(site) : '';
      /* fix/timeline-buttons-and-deadline — the redirects below were
         dropping ?from=today, so Today's "Open timeline" link (bare
         /timeline?from=today, no date — the rolling-list case) lost the
         flag on this self-resolve redirect, and the "Back to Today"
         button (gated on readRouteParams().from === 'today') never
         appeared. Preserve it through both redirects below like
         qsUser/qsSite. */
      var qsFrom = params.from ? '&from=' + encodeURIComponent(params.from) : '';
      var today = window.FS.api.todayNZDT();

      /* Batch A — site-aware bootstrap. Once a project is anchored,
         resolve the initial date against THAT site's own report calendar
         (24-month lookback, matching DatePicker's own default) instead of
         probing today's single-user report below — `user` is frequently
         empty here (site_manager/pm landing straight on
         AggregatedDayView), so getTimeline(today, user) wouldn't reflect
         the site's actual report activity. Falls back to `today` — same
         as the no-site path below — when the site has no report dates at
         all (or the calendar call is denied), so the page still
         navigates and AggregatedDayView can render its own empty state
         rather than leaving the page stuck in 'loading' forever.
         Mock mode: getDates() ignores `site` and returns the full
         fixture calendar — acceptable; findLatestReportDate then simply
         resolves to the same latest date the no-site path would have
         found anyway (BACKEND-CONTEXT §4.3 note in api/dates.js). */
      if (site) {
        window.FS.api.dates.getDates({ months: 24, site: site }).then(function (res) {
          if (cancelled) return;
          var resolved = (res && !res._accessDenied)
            ? (findLatestReportDate(res.dates || {}) || today)
            : today;
          window.FS.Router.navigate('/timeline?date=' + resolved + qsUser + qsSite + qsFrom);
        }).catch(function () { /* fall through; fetch effect won't run */ });
        return function () { cancelled = true; };
      }

      window.FS.api.timeline.getTimeline({ date: today, user: user })
        .then(function (r) {
          if (cancelled) return null;
          if (r && !r._notFound && !r._accessDenied) return today;
          return window.FS.api.dates.getDates({ months: 3 }).then(function (res) {
            if (cancelled || !res || res._accessDenied) return today;
            return findLatestReportDate(res.dates || {}) || today;
          });
        })
        .then(function (resolved) {
          if (cancelled || !resolved) return;
          window.FS.Router.navigate('/timeline?date=' + resolved + qsUser + qsSite + qsFrom);
        })
        .catch(function () { /* fall through; fetch effect won't run */ });

      return function () { cancelled = true; };
    }, [date, user, site]);

    React.useEffect(function () {
      if (!date) return undefined;            /* bootstrap above is in flight */
      var cancelled = false;

      /* Batch A — project chosen, no specific person: AggregatedDayView
         owns its own getSiteUsers × getTimeline fan-out fetch below; skip
         the single-user fetch entirely and set a minimal ok-state so
         render reaches the aggregated branch. Worker-forced-self (above)
         resolves `user` BEFORE this effect runs, so workers never land
         here — site && !user means admin/gm, OR a site_manager/PM with an
         anchored site (their forced-self rule is site-conditional). */
      if (site && !user) {
        setState({ status: 'ok', aggregated: true });
        return undefined;
      }

      /* Own-day-first fallback. `selfDefaulted` marks the case where nobody
         asked for this person — the resolver put the caller on their own day
         because no ?user= and no view=team was given. If that day turns out
         to hold nothing, showing an empty page would be a worse landing than
         the team view the default replaced, so hand over to it.

         Only ever applies to the implicit default: an explicit ?user= (an
         empty day someone deliberately opened) still renders its own empty
         state, because silently redirecting away from a page you asked for
         is disorienting. */
      var canFallBackToTeam = selfDefaulted && canSeeOverview(caller, site);

      setState({ status: 'loading' });
      Promise.all([
        window.FS.api.timeline.getTimeline({ date: date, user: user }),
        window.FS.api.actions.getActions(date),
        window.FS.api.meetings.getMeetingMinutes({ date: date, user: user }),
      ]).then(function (results) {
        if (cancelled) return;
        var report  = results[0];
        var actions = results[1].actions || {};
        var meeting = results[2];

        /* P-12 — page-level access-denied. If the daily-report endpoint
           rejected this caller (§8.4: non-admin querying another user),
           short-circuit to AccessDenied. We don't downgrade to a meeting
           view — if the timeline call was forbidden, the meeting fetch
           against the same folder almost certainly was too. */
        if (report && report._accessDenied) {
          setState({
            status:  'access_denied',
            message: report.error,
            scope:   user ? unfolder(user) + "'s daily report" : "this report",
          });
          return;
        }

        /* Meeting minutes fetched via the generic media presigner;
           a 403 there should NOT block the daily report from rendering.
           Strip access-denied / not-found responses to null. */
        if (meeting && (meeting._notFound || meeting._accessDenied)) {
          meeting = null;
        }

        var hasReport  = !!(report && !report._notFound && !report.available_users);
        var hasMeeting = !!meeting;

        /* Nothing of the caller's own on this date, and they were only here
           by default — show the team instead of an empty page (see
           canFallBackToTeam above). Checked against BOTH sources: a day with
           no daily report but a meeting recording is still the caller's day
           and must not hand over. */
        if (canFallBackToTeam && !hasReport && !hasMeeting) {
          setState({ status: 'ok', aggregated: true, selfEmpty: true });
          return;
        }

        /* Default to daily if it exists, otherwise meeting. The toggle
           UI surfaces only when both are present (§5.5). */
        setView(function (cur) {
          if (hasReport && hasMeeting) return cur;
          if (hasMeeting && !hasReport) return 'meeting';
          return 'daily';
        });
        setState({
          status:  'ok',
          report:  report,
          actions: actions,
          meeting: meeting,
        });
        /* Retire any optimistic redaction/revert patch the server has now
           caught up to; a still-stale read keeps the patch so the topic
           stays in its optimistic bucket rather than flickering back. */
        setOverrides(function (cur) { return reconcileTopicOverrides(cur, report.topics); });
      }).catch(function (err) {
        if (cancelled) return;
        setState({ status: 'error', error: { code: (err && err.status) || 0, message: (err && err.message) || 'Could not load report', retryable: true }, retry: function () { setRetry(function (n) { return n + 1; }); } });
      });
      return function () { cancelled = true; };
    }, [date, user, retryCount]);

    /* life-conversation separation — a redaction / revert / keep-as-work in
       the right-detail refetches the report so the visible/removed partition
       reflects the new `redacted`/`work_class` state. Decoupled via a window
       event (no prop plumbing through the detail pane). */
    React.useEffect(function () {
      function onRefresh(e) {
        /* Q2 — when the review button carries a { topicRowId, patch } detail,
           apply it optimistically and DON'T refetch: the write already
           committed, so the patch alone moves the topic to its new bucket at
           once, with no "Loading report…" flash and no chance of the stale
           read-after-write refetch clobbering it. Overrides self-heal on the
           next detail-less refetch (reconcile) or clear on date/user change.
           Detail-less callers (content edits, keep-as-work) refetch as before —
           they need fresh server fields the patch layer doesn't carry. */
        var d = e && e.detail;
        if (d && d.topicRowId && d.patch) {
          setOverrides(function (cur) {
            var next = Object.assign({}, cur);
            next[d.topicRowId] = Object.assign({}, cur[d.topicRowId], d.patch);
            return next;
          });
          return;
        }
        setRetry(function (n) { return n + 1; });
      }
      window.addEventListener('fs:timeline-refresh', onRefresh);
      return function () { window.removeEventListener('fs:timeline-refresh', onRefresh); };
    }, []);

    /* Drop optimistic patches when the viewed report changes — a new date/user
       has different topic_row_ids. Keyed on date/user ONLY (never retryCount),
       so a just-applied patch survives its own reconcile refetch. */
    React.useEffect(function () {
      setOverrides({});
    }, [date, user]);

    /* Sprint 6.7.1 — keep state.actions in sync with cross-component
       toggles (the right-detail OverviewTab also renders the same
       action_items via its own ActionItemRow instances). When any
       sibling fires a successful toggle, mirror it into our local
       actions map so re-renders here see the new check state. */
    React.useEffect(function () {
      var bus = window.FS && window.FS.actionsBus;
      if (!bus) return undefined;
      return bus.subscribe(function (payload) {
        if (!payload || payload.date !== date) return;
        setState(function (s) {
          if (s.status !== 'ok') return s;
          var key = window.FS.api.actions.actionKey(payload.user_folder, payload.topic_id, payload.action_index);
          var nextActions = Object.assign({}, s.actions || {});
          nextActions[key] = {
            checked:    !!payload.checked,
            checked_by: payload.checked_by,
            checked_at: payload.checked_at,
          };
          return Object.assign({}, s, { actions: nextActions });
        });
      });
    }, [date]);

    /* Sprint 6.6.4 — auto-select the deep-linked topic once per
       (date, topicId) pair. Fires after the report loads; finds the
       matching topic, asks the AppShell to open the right panel via
       props.onSelect. We track via ref so subsequent re-renders or
       state churn don't re-trigger. The ref resets when the target
       topic id changes (user clicked a different deep-link). */
    var autoSelectKeyRef = React.useRef(null);
    React.useEffect(function () {
      if (state.status !== 'ok' || !hasTopicTarget) return;
      var report = state.report;
      if (!report || report._notFound || report.available_users) return;
      /* turnTime rides in the dedup key too: two Ask citations into the
         SAME topic but different transcript moments must each re-fire
         onSelect (and therefore re-flash at the new line), not get
         swallowed by the ref-guard from the first click. */
      var key = date + '|' + (targetTopicId || targetTopicTitle) + '|' + (targetTurnTime || '');
      if (autoSelectKeyRef.current === key) return;
      var topic = (report.topics || []).filter(matchesTopicTarget)[0];
      if (!topic) return;
      autoSelectKeyRef.current = key;
      if (props.onSelect) {
        props.onSelect({
          kind:      'topic',
          id:        'topic_' + topic.topic_id,
          topic_id:  topic.topic_id,
          topic:     topic,
          date:      date,
          user:      user,
          user_name: report.user_name,
          turnTime:  targetTurnTime,
        });
      }
    }, [state.status, targetTopicId, targetTopicTitle, targetTurnTime, date]);

    /* Task C — Search's "Ask FieldSight" hand-off (search-palette.js).
       Read-and-clear the sessionStorage prefill exactly once per mount,
       via a lazy useState initializer rather than an effect so the value
       is ready in time for AskChat's own mount-time prefill effect
       (ask-chat.js) — that effect only runs once on ITS mount too, so it
       must see the real value on AskChat's first render, not one render
       later. Threaded into the report-level AskChat mount below. Must
       sit above the early returns (:401+) — rules of hooks. */
    var refAskPrefill = React.useState(function () {
      try {
        var v = sessionStorage.getItem('fs.ask.prefill');
        if (v) sessionStorage.removeItem('fs.ask.prefill');
        return v || '';
      } catch (_) { return ''; }
    });
    var askPrefill = refAskPrefill[0];

    /* Loading */
    if (state.status === 'loading') {
      return React.createElement('div', {
        className: 'fs-timeline-page',
      },
        React.createElement(PageHeader, {
          date: date, user: user,
          site: site,
        }),
        React.createElement('div', { className: 'fs-timeline-page__loading' },
          'Loading report…'),
      );
    }

    if (state.status === 'error') {
      var ErrorBanner = window.FieldSight.ErrorBanner;
      return React.createElement('div', { className: 'fs-timeline-page' },
        React.createElement(PageHeader, {
          date: date, user: user,
          site: site,
        }),
        ErrorBanner
          ? React.createElement(ErrorBanner, {
              message:   (state.error && state.error.message) || 'Could not load report',
              retryable: true,
              onRetry:   state.retry,
            })
          : React.createElement(NoReportState, {
              message: (state.error && state.error.message) || 'Could not load report',
            }),
      );
    }

    /* P-12 — empathetic 403 (BACKEND-CONTEXT §8.4). */
    if (state.status === 'access_denied') {
      var AccessDenied = window.FieldSight.AccessDenied;
      return React.createElement('div', { className: 'fs-timeline-page' },
        React.createElement(PageHeader, {
          date: date, user: user,
          site: site,
        }),
        AccessDenied
          ? React.createElement(AccessDenied, {
              scope:   state.scope,
              message: state.message,
            })
          : React.createElement(NoReportState, { message: state.message || 'Access denied.' }),
      );
    }

    /* Batch A — multi-project admin/gm caller with no project chosen:
       offer the project picker instead of the raw cross-site user list
       (available_users below) once we know there's more than one option.
       While sitesList is still resolving, sitesList.length is 0 so this
       branch simply doesn't match yet — the 'loading' branch above (from
       the still-in-flight, non-short-circuited fetch below) covers that
       window without any extra state. */
    if (!site && !user && sitesList.length > 1) {
      return React.createElement('div', { className: 'fs-timeline-page' },
        React.createElement(PageHeader, {
          date: date, user: null,
          site: site,
        }),
        React.createElement(SitePickerState, {
          sitesList: sitesList, onChangeSite: onChangeSite,
        }),
      );
    }

    /* Batch A core — project chosen, no specific person: fan out across
       every user on the site (AggregatedDayView) instead of a single
       report. The fetch effect above short-circuits to a minimal
       ok-state for this case; AggregatedDayView does its own fetching. */
    /* `state.aggregated` as well as `!user`: the own-day-first fallback keeps
       `user` set to the caller (nothing asked it to change) and signals the
       handover through state, so the URL stays free of an explicit choice and
       a date where they DID record shows their own day again. */
    if (site && (!user || state.aggregated)) {
      return React.createElement('div', { className: 'fs-timeline-page' },
        React.createElement(PageHeader, {
          date: date, user: null,
          site: site,
        }),
        state.selfEmpty
          ? React.createElement('div', {
              className: 'fs-timeline-page__self-empty-note',
              style: {
                fontSize: '13px', color: 'var(--text-tertiary)',
                margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: '8px',
              },
            },
              React.createElement('span', null,
                'You have no recordings on this date — showing the team instead.'),
            )
          : null,
        React.createElement(AggregatedDayView, {
          site: site, date: date,
          onSelect: props.onSelect, selectedItem: props.selectedItem,
        }),
      );
    }

    var report  = state.report;
    var meeting = state.meeting;
    var hasReport  = !!(report  && !report._notFound  && !report.available_users);
    var hasMeeting = !!meeting;

    /* Admin disambiguation shape: { date, available_users:[...] } */
    if (report && report.available_users && !hasMeeting) {
      return React.createElement('div', { className: 'fs-timeline-page' },
        React.createElement(PageHeader, {
          date: date, user: null,
          site: site,
        }),
        React.createElement(AvailableUsersState, {
          date: date, users: report.available_users, site: site,
        }),
      );
    }

    /* No-anything shape */
    if (!hasReport && !hasMeeting) {
      return React.createElement('div', { className: 'fs-timeline-page' },
        React.createElement(PageHeader, {
          date: date, user: user,
          site: site,
        }),
        React.createElement(NoReportState, {
          message: (report && report.message) || ('No report for ' + unfolder(user || '') + ' on ' + date),
        }),
      );
    }

    /* View toggle — surfaces only when both exist for the date (§5.5). */
    var bothExist = hasReport && hasMeeting;
    var effectiveView = view;
    if (effectiveView === 'meeting' && !hasMeeting) effectiveView = 'daily';
    if (effectiveView === 'daily'   && !hasReport)  effectiveView = 'meeting';

    var actionState = state.actions || {};
    var selectedTopicId = props.selectedItem && props.selectedItem.kind === 'topic'
      ? props.selectedItem.topic_id
      : null;

    /* life-conversation separation (Task 11) — same content:edit-OR-own-report
       gate OverviewTab computes (~line 1489), recomputed here because the
       removed-area section lives in the middle column, a different function.
       `caller` (~line 660) and `report`/`user` (~line 1045/662) are already
       in scope by this point (past every early-return branch above). */
    var hasContentEditPerm = !!(window.FS && window.FS.can && window.FS.P
        && window.FS.can(caller, window.FS.P('content', 'edit')));
    var ownerFolder = user || (report && report.user_name && window.FS.api.folderName(report.user_name)) || null;
    var isOwnReport = !!(ownerFolder && caller && caller.name
        && window.FS.api.folderName(caller.name) === ownerFolder);
    var canEditContent = hasContentEditPerm || isOwnReport;

    var AskChat            = window.FieldSight.AskChat;
    var MeetingTopicCard   = window.FieldSight.MeetingTopicCard;

    function ViewToggle() {
      if (!bothExist) return null;
      return React.createElement('div', { className: 'fs-timeline-page__view-toggle', role: 'tablist' },
        React.createElement('button', {
          type: 'button', role: 'tab',
          className: 'fs-timeline-page__view-tab' + (effectiveView === 'daily'   ? ' fs-timeline-page__view-tab--active' : ''),
          'aria-selected': effectiveView === 'daily',
          onClick: function () { setView('daily'); },
        }, 'Daily report'),
        React.createElement('button', {
          type: 'button', role: 'tab',
          className: 'fs-timeline-page__view-tab' + (effectiveView === 'meeting' ? ' fs-timeline-page__view-tab--active' : ''),
          'aria-selected': effectiveView === 'meeting',
          onClick: function () { setView('meeting'); },
        }, 'Meeting minutes'),
      );
    }

    /* ---- Meeting view ---- */
    if (effectiveView === 'meeting') {
      return React.createElement('div', { className: 'fs-timeline-page' },
        React.createElement(PageHeader, {
          date: date, user: user, report: report || meeting,
          site: site,
        }),
        React.createElement(ViewToggle),

        meeting.meeting_title ? React.createElement('div', {
          className: 'fs-timeline-page__meeting-title',
        }, meeting.meeting_title) : null,

        React.createElement(ExecutiveSummaryCard, {
          bullets: meeting.executive_summary,
          label:   'Meeting summary',
        }),

        React.createElement('div', { className: 'fs-timeline-page__section-label' },
          'Topics'),
        React.createElement('div', { className: 'fs-timeline-page__topics' },
          (meeting.topics || []).map(function (topic) {
            return React.createElement(MeetingTopicCard, {
              key:      topic.topic_id,
              topic:    topic,
              selected: selectedTopicId === topic.topic_id,
              onSelect: function () {
                if (props.onSelect) {
                  props.onSelect({
                    kind:       'meeting_topic',
                    id:         'meeting_topic_' + topic.topic_id,
                    topic_id:   topic.topic_id,
                    topic:      topic,
                    date:       date,
                    user:       user,
                    user_name:  meeting.user_name,
                  });
                }
              },
            });
          }),
        ),

        (meeting.next_steps || []).length > 0
          ? React.createElement(React.Fragment, null,
              React.createElement('div', { className: 'fs-timeline-page__section-label' },
                'Next steps'),
              React.createElement('ul', { className: 'fs-timeline-page__list' },
                meeting.next_steps.map(function (s, i) {
                  return React.createElement('li', { key: i }, s);
                })
              ),
            )
          : null,

        (meeting.parking_lot || []).length > 0
          ? React.createElement(React.Fragment, null,
              React.createElement('div', { className: 'fs-timeline-page__section-label' },
                'Parking lot'),
              React.createElement('ul', { className: 'fs-timeline-page__list' },
                meeting.parking_lot.map(function (s, i) {
                  return React.createElement('li', { key: i }, s);
                })
              ),
            )
          : null,
      );
    }

    /* session picker (feat 5) — narrow the visible topics to one recording
       session ("just that meeting") instead of the whole day. Filtering is
       CLIENT-SIDE over the topics already fetched above (match on
       topic.session_id); selecting a session never refetches getTimeline.
       All day (selectedSessionId === null) is a no-op filter, so
       session_kind:'report' topics (no session_id at all) stay visible —
       they only drop out once a specific session is chosen. */
    var daySessions  = sessionsState.sessions || [];
    var showSessionPicker = shouldShowSessionPicker(daySessions);
    var excludedNote      = formatExcludedNote(sessionsState.excluded);

    /* life-conversation separation (Task 11) — a redacted (confirmed-personal)
       topic is hidden from the default topic list and relocated to a
       collapsed "Removed / personal" section with a revert control, reviewers only
       (spec §5 "hidden + recoverable"). Session filtering runs FIRST so the
       removed section, like the visible list, stays scoped to whichever
       session (or All day) is currently selected. */
    var _scopedTopics = filterTopicsBySession(
      applyTopicOverrides(report.topics, overrides), selectedSessionId);
    var _partition    = partitionTopics(_scopedTopics);
    var visibleTopics = _partition.visible;
    var removedTopics = _partition.removed;

    /* meeting-scoped email draft (#10) — resolve the current scope for the
       "Draft email" control. When a specific session is selected the draft is
       that meeting; "All day" (null) drafts the whole day's outstanding items,
       labelled as such. The report owner's folder feeds the same done-check
       (status column, else legacy DynamoDB check-off) the topic cards use, so
       an item ticked here counts as done and is left out of the draft. */
    var _selectedSession = selectedSessionId
      ? (daySessions.filter(function (s) { return s.session_id === selectedSessionId; })[0] || null)
      : null;
    var _draftUserFolder = report.user_name ? window.FS.api.folderName(report.user_name) : null;
    function _isActionDone(a, topicId, idx) {
      if (a && a.status) return a.status === 'done';
      var st = window.FS.api.actions.lookupAction(actionState, _draftUserFolder, topicId, idx);
      return !!(st && st.checked);
    }
    /* Belt-and-suspenders: the draft builder re-asserts redacted/non_work
       exclusion itself, but pass the ALREADY-visible (non-removed) topics so a
       personal item has to slip two independent filters to ever reach it. */
    var _draftEl = React.createElement(DraftEmailButton, {
      topics:     visibleTopics,
      session:    _selectedSession,
      /* ownerFolder, not `user`: the self-view has user===null and the photos
         belong to whoever recorded the day. */
      userFolder: ownerFolder,
      siteName:   report.site || site || '',
      date:       date,
      reportDate: report.report_date || date,
      deepLink:   (typeof window !== 'undefined' && window.location) ? window.location.href : '',
      isDone:     _isActionDone,
    });
    /* Delivery-C Tier-2 generate control — sits beside the mailto draft, active
       only when a specific meeting is selected (the modal is per-session). */
    var _genReportEl = React.createElement(GenerateReportButton, {
      session:    _selectedSession,
      date:       date,
      userFolder: _draftUserFolder,
      siteName:   report.site || site || '',
      topics:     visibleTopics,
    });

    /* ---- Daily report view (default) ---- */
    return React.createElement('div', {
      className: 'fs-timeline-page',
    },
      React.createElement(PageHeader, {
        date: date, user: user, report: report,
        site: site,
      }),
      React.createElement(ViewToggle),
      React.createElement(ReportKpis, {
        report: report,
        /* The visible list, not the day — see ReportKpis. */
        topics: visibleTopics,
        sessionScoped: !!selectedSessionId,
      }),
      /* The executive summary narrates the whole DAY — it is written once,
         over every topic, and there is no per-meeting version of it. Left
         standing under a one-meeting view it describes four meetings above a
         list showing one, which is the same contradiction the KPI strip had.
         Hidden rather than trimmed: a summary cannot be filtered down to the
         sentences that happen to mention this session without rewriting it. */
      selectedSessionId ? null : React.createElement(ExecutiveSummaryCard, {
        bullets: report.executive_summary,
      }),
      (showSessionPicker || excludedNote) ? React.createElement('div', {
        className: 'fs-session-picker-wrap',
      },
        showSessionPicker ? React.createElement(SessionPicker, {
          sessions:          daySessions,
          selectedSessionId: selectedSessionId,
          onSelect:          setSelectedSessionId,
        }) : null,
        excludedNote ? React.createElement('div', {
          className: 'fs-session-picker__excluded-note',
        }, excludedNote) : null,
      ) : null,
      React.createElement('div', {
        className: 'fs-timeline-page__section-label fs-timeline-page__topics-head',
        style:     { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
      },
        React.createElement('span', null, 'Topics'),
        React.createElement('div', {
          className: 'fs-timeline-page__topics-actions',
          style:     { display: 'flex', alignItems: 'center', gap: '8px' },
        }, _genReportEl, _draftEl)),
      React.createElement('div', { className: 'fs-timeline-page__topics' },
        visibleTopics.map(function (topic) {
          /* Sprint 6.6.4 — focus mode + flash. When a deep-link target
             is set, the matching topic auto-opens (via defaultOpen
             boolean) and gets highlight=true (scrollIntoView + 3-pulse
             flash). Other topics force-collapse (defaultOpen=false)
             so the target reads as the focal point. When no target,
             defaultOpen=undefined leaves user-toggled state alone. */
          var isTarget = matchesTopicTarget(topic);
          var defaultOpenProp = !hasTopicTarget
            ? undefined
            : isTarget;
          /* mentionsForTopic, never mentionsByTopic[topic.topic_id]: the
             report side's topic_id is per-report sequential (every section
             has a topic 0) while a suggestion's topic_id is topics.id, a
             uuid. The durable report-side key is topic_row_id, and the
             module owns that distinction so no page has to. */
          var mentions = window.FS.api.programmeMentions
            ? window.FS.api.programmeMentions.mentionsForTopic(topic, mentionsByTopic)
            : [];
          var linked = mentions[0];

          return React.createElement(TopicCard, {
            key:         topic.topic_id,
            topic:       topic,
            date:        date,
            actionState: actionState,
            programmeTaskName: linked ? linked.task_name : null,
            programmeTaskId:   linked ? linked.task_id : null,
            onOpenProgrammeTask: function (taskId) {
              window.location.hash = '#/programme?task=' + encodeURIComponent(taskId || '');
            },
            /* user-dimension audit key plan (Task 5) — MUST derive from
               report.user_name, never the page `user` param: the
               self-view route has user=null (documented crux trap), and
               report.user_name is always the actual report owner. */
            userFolder:  report.user_name ? window.FS.api.folderName(report.user_name) : null,
            selected:    selectedTopicId === topic.topic_id,
            defaultOpen: defaultOpenProp,
            /* Sprint 7 follow-up — when &flag= is present, suppress
               the topic-level flash entirely; SafetyFlagRow owns the
               scroll + flash so the spotlight lands on one row, not
               the whole topic card. defaultOpen still fires so the
               flag row is in the DOM for the row's own scrollIntoView. */
            highlight:   isTarget && targetFlagIdx === null,
            /* Sprint 6.7.2 — only the matched topic gets a flagHighlight;
               others ignore. */
            flagHighlight: isTarget ? targetFlagIdx : null,
            onSelect:    function () {
              if (props.onSelect) {
                props.onSelect({
                  kind:       'topic',
                  id:         'topic_' + topic.topic_id,
                  topic_id:   topic.topic_id,
                  topic:      topic,
                  date:       date,
                  user:       user,
                  user_name:  report.user_name,
                });
              }
            },
          });
        }),
      ),

      /* life-conversation separation (Task 11) — collapsed "Removed / personal"
         area: confirmed-personal topics are hidden from the list above but
         stay recoverable here (reviewers only) via revertRedaction. */
      removedTopics.length && canEditContent ? React.createElement('details', {
        className: 'fs-timeline-page__removed',
      },
        React.createElement('summary', null, 'Removed / personal (' + removedTopics.length + ')'),
        removedTopics.map(function (topic) {
          return React.createElement(RemovedTopic, { key: topic.topic_id, topic: topic });
        }),
      ) : null,

      /* Per-report Ask Agent (PLAN Phase G). Stateless — each question
         is independent. Scope='both' grounds across transcript +
         report. */
      AskChat ? React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'fs-timeline-page__section-label' },
          'Ask agent'),
        React.createElement(AskChat, {
          date:            date,
          user:            user || (report && report.user_name && window.FS.api.folderName(report.user_name)),
          scope:           'both',
          /* Supplied only when the programme actually loaded. AskChat treats
             an absent provider as "this route does not exist", so a failed
             fetch degrades to the agent rather than to a wrong answer.

             `silent` is passed as null unless the suggestion fetch used
             state:'all' — programmeMentions refuses to claim silence without
             that coverage, and flattening it here would undo the refusal. */
          alertsProvider: makeAlertsProvider(suggestions),
          placeholder:     'Ask anything about today’s report…',
          compact:         true,
          initialQuestion: askPrefill,
          suggestions: [
            'What were today’s safety highlights?',
            'Which actions are still open?',
            'Any decisions about the scaffold inspection?',
          ],
        }),
      ) : null,
    );
  }

  /* session picker (feat 5) — "All day" plus one row per recording session,
     sessions sharing a `block` (a meeting split across recording restarts)
     grouped together so the user thinks in meetings, not press-record
     events. Module-level, same convention as RemovedTopic below: purely a
     view over props (sessions/selectedSessionId/onSelect), no fetch of its
     own — TimelineMiddleColumn owns the one getSessions call. */
  function SessionPicker(props) {
    var sessions = props.sessions || [];
    var selected = props.selectedSessionId;
    var groups   = groupSessionsByBlock(sessions);
    return React.createElement('div', {
      className: 'fs-session-picker', role: 'tablist', 'aria-label': 'Filter by session',
    },
      React.createElement('button', {
        type: 'button', role: 'tab', 'aria-selected': selected == null,
        className: 'fs-session-picker__row fs-session-picker__row--all'
          + (selected == null ? ' fs-session-picker__row--active' : ''),
        onClick: function () { props.onSelect(null); },
      }, 'All day'),
      groups.map(function (group, gi) {
        var isBlock = group.sessions.length > 1;
        return React.createElement('div', {
          key: 'session-block-' + gi,
          className: 'fs-session-picker__group' + (isBlock ? ' fs-session-picker__group--block' : ''),
        },
          isBlock ? React.createElement('div', { className: 'fs-session-picker__group-label' },
            'Same meeting, restarted') : null,
          group.sessions.map(function (s) {
            return React.createElement('button', {
              key: s.session_id, type: 'button', role: 'tab',
              'aria-selected': selected === s.session_id,
              className: 'fs-session-picker__row'
                + (selected === s.session_id ? ' fs-session-picker__row--active' : ''),
              onClick: function () { props.onSelect(s.session_id); },
            }, formatSessionSummary(s));
          }),
        );
      }),
    );
  }

  /* meeting-scoped email draft (#10) — a one-click "Draft email" control for
     the currently-scoped meeting's OUTSTANDING action items. Rendered as an
     <a href="mailto:…"> (a plain user-click navigation — no window.open, so
     no pop-up blocker can eat it, unlike window.location assignment on some
     clients). Opens the sender's OWN mail client with an editable, UNSENT
     draft — FieldSight sends nothing, ever. When the scope has no
     outstanding items the control renders DISABLED with a reason rather than
     producing an empty email. All data comes from `topics` already in hand;
     no endpoint call, no recipient/email resolution (deferred, §5). */
  function DraftEmailButton(props) {
    var draft = buildSessionEmailDraft({
      topics:     props.topics,
      session:    props.session,
      siteName:   props.siteName,
      date:       props.date,
      reportDate: props.reportDate || props.date,
      deepLink:   props.deepLink,
      isDone:     props.isDone,
    });
    if (!draft) {
      return React.createElement('button', {
        type:      'button',
        className: 'fs-btn fs-btn--tertiary fs-btn--sm fs-draft-email fs-draft-email--empty',
        disabled:  true,
        title:     'No outstanding action items in this view to send',
      }, 'Draft email');
    }
    var tip = draft.truncated
      ? ('Opens a draft in your mail client — ' + draft.omittedItems
         + ' item' + (draft.omittedItems === 1 ? '' : 's')
         + ' trimmed to fit; full list via the link in the email. Nothing is sent until you send it.')
      : 'Opens a draft in your mail client — nothing is sent until you send it';
    return React.createElement(React.Fragment, null,
      React.createElement('a', {
        className: 'fs-btn fs-btn--secondary fs-btn--sm fs-draft-email',
        href:      draft.url,
        title:     tip,
        /* mailto stays in the same tab handoff to the OS mail client; no
           target/_blank needed and no rel required for a mailto scheme. */
      }, 'Draft email'),
      /* Beside it, not instead of it. The two hand-offs lose different
         things and neither dominates:
           Draft email  pre-fills recipient + subject and opens the compose
                        window — but mailto rides in a URL, so it cannot
                        attach a photo and it TRIMS items past ~1800 chars.
           Preview      shows what is about to go, carries the photos that
                        evidence each finding, and never truncates — but the
                        user pastes into a message they opened themselves.
         A finding without its photo is an assertion; with it, it is
         evidence. That is what earns the second button. */
      React.createElement(PreviewEmailButton, props),
    );
  }

  /* Opens EmailPreviewModal. Separate component so the modal's open/closed
     state does not live in DraftEmailButton, which renders in two places
     (the aggregated person-section and the single-day view) and would
     otherwise share one flag across both. */
  function PreviewEmailButton(props) {
    var openRef = React.useState(false);
    var open    = openRef[0];
    var setOpen = openRef[1];
    var Modal   = window.FieldSight.EmailPreviewModal;
    if (!Modal) return null;          /* script not loaded → no broken button */
    return React.createElement(React.Fragment, null,
      React.createElement('button', {
        type:      'button',
        className: 'fs-btn fs-btn--tertiary fs-btn--sm',
        title:     'See the hand-off with its photos, then copy it into any email',
        onClick:   function () { setOpen(true); },
      }, 'Preview & copy'),
      React.createElement(Modal, {
        open:       open,
        onClose:    function () { setOpen(false); },
        topics:     props.topics,
        session:    props.session,
        date:       props.date,
        reportDate: props.reportDate || props.date,
        siteName:   props.siteName,
        userFolder: props.userFolder,
        isDone:     props.isDone,
        deepLink:   props.deepLink,
      }),
    );
  }

  /* Delivery-C Tier-2 — a per-session "Generate report" control beside the mailto
     "Draft email". Opens SessionReportModal (review the company template, fill the
     confirmed fields, generate a Word/PDF, download or server-email it). Shown only
     when a specific session is selected (Tier-2 is per-session) AND the caller may
     create reports; self-contained modal-open state so the picker render is
     unchanged. Renders nothing if the composite isn't loaded (defensive). */
  function GenerateReportButton(props) {
    var s_open = React.useState(false); var open = s_open[0], setOpen = s_open[1];
    var Modal   = (window.FieldSight || {}).SessionReportModal;
    var caller  = (window.AuthMock && window.AuthMock.currentUser) || {};
    var canCreate = !!(window.FS && window.FS.can && window.FS.can(caller, window.FS.P('report', 'create')));
    if (!props.session || !Modal || !canCreate) return null;
    return React.createElement(React.Fragment, null,
      React.createElement('button', {
        type:      'button',
        className: 'fs-btn fs-btn--primary fs-btn--sm fs-generate-report',
        onClick:   function () { setOpen(true); },
        title:     'Generate a report for this meeting',
      }, 'Generate report'),
      React.createElement(Modal, {
        open:       open,
        onClose:    function () { setOpen(false); },
        session:    props.session,
        date:       props.date,
        userFolder: props.userFolder,
        siteName:   props.siteName,
        topics:     props.topics,
      }));
  }

  /* life-conversation separation (Task 11) — one row in TimelineMiddleColumn's
     "Removed / personal" collapsed section. Module-level (not nested inside
     TimelineMiddleColumn) to match this file's convention (GlossaryConfirm/
     EditableText/etc. are all siblings, not re-declared every render). */
  function RemovedTopic(props) {
    var IconBtn = window.FieldSight.IconButton;
    var busyRef = React.useState(false); var busy = busyRef[0], setBusy = busyRef[1];
    return React.createElement('div', { className: 'fs-timeline-page__removed-row' },
      React.createElement('span', null, unfolder(props.topic.topic_title || props.topic.title || 'Removed')),
      IconBtn ? React.createElement(IconBtn, {
        icon: 'rotate-ccw', size: 'sm', variant: 'ghost', disabled: busy || !props.topic.redaction_id,
        ariaLabel: 'Restore',
        onClick: function () {
          if (busy || !props.topic.redaction_id) return;
          setBusy(true);
          window.FS.api.actions.revertRedaction(props.topic.redaction_id).then(function (r) {
            setBusy(false);
            var toast = window.FS && window.FS.toast;
            if (!r || r._accessDenied || r._notFound) { if (toast) toast.show({ message: (r && r.error) || 'Could not restore', tone: 'error', duration: 5000 }); return; }
            if (toast) toast.show({ message: 'Restored', tone: 'success', duration: 3000 });
            /* Optimistic patch (Q2): return the topic to the visible list at
               once (clear redacted + its id), rather than waiting for the
               stale post-write refetch to catch up. */
            window.dispatchEvent(new CustomEvent('fs:timeline-refresh', {
              detail: { topicRowId: props.topic.topic_row_id, patch: { redacted: false, redaction_id: null } },
            }));
          }).catch(function () { setBusy(false); });
        },
      }) : null);
  }

  /* =====================================================================
     TimelineRightDetail — TopicDetail panel + media tabs
     ===================================================================== */

  /* Tab sets — daily reports surface media (transcript / audio / video
     / photos), meeting minutes don't (their per-topic recordings live
     in a different bundle the prototype doesn't fetch). */
  var DAILY_TABS = [
    { key: 'overview',   label: 'Overview' },
    { key: 'transcript', label: 'Transcript' },
    { key: 'audio',      label: 'Audio' },
    { key: 'video',      label: 'Video' },
    { key: 'photos',     label: 'Photos' },
    { key: 'ask',        label: 'Ask' },
  ];
  var MEETING_TABS = [
    { key: 'overview', label: 'Overview' },
    { key: 'ask',      label: 'Ask' },
  ];

  /* Status / category palettes for meeting topics — kept in sync with
     the MeetingTopicCard composite. */
  var MEETING_STATUS_TONE  = { decided: 'success', deferred: 'warning', in_discussion: 'info', blocked: 'danger' };
  var MEETING_STATUS_LABEL = { decided: 'Decided', deferred: 'Deferred', in_discussion: 'In discussion', blocked: 'Blocked' };
  var MEETING_PRIORITY_TONE = { high: 'danger', medium: 'warning', low: 'info' };

  /* Topic time_range uses an en-dash: "07:00 – 07:30". Returns
     { start: 'HH:MM:SS', end: 'HH:MM:SS' } or { start: null, end: null }. */
  function parseTimeRange(time_range) {
    if (!time_range) return { start: null, end: null };
    var m = String(time_range).match(/(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/);
    if (!m) return { start: null, end: null };
    function pad(s) { return s.length === 1 ? '0' + s : s; }
    return {
      start: pad(m[1]) + ':' + m[2] + ':00',
      end:   pad(m[3]) + ':' + m[4] + ':00',
    };
  }

  /* editable-content-correction (Task 18) — D7 two-tier authority: per-item
     correction (EditableText/canEditContent) is author/pm/site_manager/
     admin, but PROMOTING a correction to a name_aliases glossary row is
     site_manager+ only. roles.js/fs-globals.js export ROLES + level +
     HIERARCHY_ROLES but not a hasMinimumRole helper on window.FS (the plan's
     "FS.roles.hasMinimumRole(...) if available" hedge — it isn't), so this
     mirrors roles.js's hasMinimumRole logic locally, plus an isAdmin bypass
     (consistent with FS.can's own isAdmin short-circuit). */
  function isSiteManagerPlus(caller) {
    if (!caller) return false;
    if (caller.isAdmin === true) return true;
    var HR = window.FS && window.FS.HIERARCHY_ROLES;
    var ROLES = window.FS && window.FS.ROLES;
    if (!HR || !ROLES || HR.indexOf(caller.role) === -1 || HR.indexOf('site_manager') === -1) return false;
    return (ROLES[caller.role] && ROLES[caller.role].level || 0)
        >= (ROLES.site_manager && ROLES.site_manager.level || 0);
  }

  /* editable-content-correction (Task 18 Step 3) — offered by EditableText
     after a save whose response carries D2 diff candidates. diff_candidates()
     returns bare strings (new proper-noun-like tokens present in the saved
     text but not the prior text) — it does NOT pair each with the surface
     form it replaced, so that "wrong" side is collected from the confirming
     user rather than guessed. */
  function GlossaryConfirm(props) {
    var IconBtn = window.FieldSight.IconButton;
    var busyRef = React.useState(null);
    var busyTerm = busyRef[0], setBusyTerm = busyRef[1];
    return React.createElement('div', { className: 'fs-topic-detail__glossary-confirm' },
      props.candidates.map(function (term) {
        function onConfirm() {
          var wrong = window.prompt(
            'Add "' + term + '" to the site glossary. What was the previous (incorrect) spelling?', '');
          if (!wrong || !wrong.trim()) return;
          setBusyTerm(term);
          window.FS.api.actions.confirmAlias({
            wrong_term: wrong.trim(), right_term: term, kind: 'other',
          }).then(function (res) {
            setBusyTerm(null);
            var toast = window.FS && window.FS.toast;
            if (!res || res._accessDenied) {
              if (toast) toast.show({ message: (res && res.error) || 'Could not add to glossary',
                                      tone: 'error', duration: 5000 });
              return;
            }
            if (props.onConfirmed) props.onConfirmed(term);
            if (toast) toast.show({ message: 'Added "' + term + '" to the glossary',
                                    tone: 'success', duration: 3000 });
          }).catch(function () {
            setBusyTerm(null);
            var toast = window.FS && window.FS.toast;
            if (toast) toast.show({ message: 'Could not add to glossary', tone: 'error', duration: 5000 });
          });
        }
        return React.createElement('span', { key: term },
          'Add to glossary: ' + term + ' ',
          IconBtn ? React.createElement(IconBtn, {
            icon: 'check', ariaLabel: 'Confirm "' + term + '" as a glossary correction',
            size: 'sm', variant: 'ghost', disabled: busyTerm === term,
            onClick: onConfirm,
          }) : null,
        );
      }),
    );
  }

  /* content-propagate (item #3) — sibling of GlossaryConfirm, same trigger
     (a commit that produced a D2 candidate + a clean before/after
     substitution, see findCorrectionPair above), different question: does
     this SAME correction also need making elsewhere in the topic?
     patch_content forbids batching a fix across rows ("exactly one editable
     field required"), so without this the user has to hunt down every other
     occurrence by hand — verified live on test: one topic had "Sean" in
     topics.summary AND in 5 action_items.responsible cells, one edit fixed 1
     of the 6.

     preview-then-confirm, never auto-apply — a substring match can corrupt
     an unrelated sentence, which is the whole reason this is preview-then-
     confirm rather than fire-and-forget. Confirmation is the same two-click
     arm/commit pattern used elsewhere in this codebase (programme-task-
     editor.js's delete button, photo-grid.js's keyframe delete) — never
     window.confirm.

     Mounts already armed with a preview fetch (preview is read-only, safe to
     call automatically); renders NOTHING while loading and NOTHING once
     resolved with field_count 0 — silence is correct, there's nothing else
     to fix. */
  function TopicCorrectionPropagate(props) {
    var Button = window.FieldSight.Button;
    var Badge  = window.FieldSight.Badge;

    var stRef = React.useState({ phase: 'loading', preview: null, message: null });
    var st = stRef[0], setSt = stRef[1];
    var confirmRef = React.useState(false);
    var confirmArmed = confirmRef[0], setConfirmArmed = confirmRef[1];
    var busyRef = React.useState(false);
    var busy = busyRef[0], setBusy = busyRef[1];

    function runPreview() {
      setConfirmArmed(false);
      setSt({ phase: 'loading', preview: null, message: null });
      window.FS.api.actions.previewTopicCorrection(props.topicId, props.before, props.after)
        .then(function (res) {
          if (!res || res._accessDenied || res._notFound) {
            setSt({ phase: 'error', preview: null,
                    message: (res && res.error) || 'Could not check for other occurrences.' });
            return;
          }
          setSt({ phase: 'ready', preview: res, message: null });
        })
        .catch(function (err) {
          setSt({ phase: 'error', preview: null,
                  message: (err && err.message) || 'Could not check for other occurrences.' });
        });
    }

    React.useEffect(function () { runPreview(); }, [props.topicId, props.before, props.after]);

    if (st.phase === 'loading') return null;   // silent while checking, no "0 matches" flash

    if (st.phase === 'error') {
      return React.createElement('div', { className: 'fs-topic-detail__propagate fs-topic-detail__propagate--error' },
        React.createElement('span', null, st.message),
        Button ? React.createElement(Button, {
          size: 'sm', variant: 'tertiary', onClick: runPreview,
        }, 'Try again') : null,
      );
    }

    var preview = st.preview;
    if (!preview || !preview.field_count) return null;   // nothing else needs fixing

    function apply() {
      setBusy(true);
      window.FS.api.actions.applyTopicCorrection(props.topicId, props.before, props.after)
        .then(function (res) {
          setBusy(false);
          if (!res || res._accessDenied || res._notFound) {
            setConfirmArmed(false);
            setSt({ phase: 'error', preview: null,
                    message: (res && res.error) || 'Could not apply the correction.' });
            return;
          }
          var toast = window.FS && window.FS.toast;
          if (toast) {
            toast.show({
              message: 'Fixed ' + res.changed_count + ' other place' + (res.changed_count === 1 ? '' : 's'),
              tone: 'success', duration: 3000,
            });
          }
          /* Detail-less dispatch — the read precedent in this file (see the
             onRefresh listeners above) treats a detail-less event as "refetch,
             don't optimistically patch": propagate rewrites fields across
             MULTIPLE rows (summary + N action_items/findings), which a single
             {topicRowId, patch} override can't represent, so a full refetch is
             the only way the rewritten fields actually render. */
          window.dispatchEvent(new CustomEvent('fs:timeline-refresh'));
          if (props.onApplied) props.onApplied();
        })
        .catch(function (err) {
          setBusy(false);
          var status = err && err.status;
          if (status === 409) {
            /* Apply is all-or-nothing — a 409 means NOTHING was written, not
               a partial write. Say so explicitly and re-preview (the matches
               that raced us may have changed) rather than implying it's safe
               to just retry the same apply. */
            setConfirmArmed(false);
            runPreview();
            var toast409 = window.FS && window.FS.toast;
            if (toast409) {
              toast409.show({
                message: 'Something else changed first — nothing was written. Re-checking…',
                tone: 'error', duration: 5000,
              });
            }
            return;
          }
          setConfirmArmed(false);
          setSt({ phase: 'error', preview: null,
                  message: (err && err.message) || 'Could not apply the correction.' });
        });
    }

    var matches = preview.matches || [];
    var byTable = {};
    var tableOrder = [];
    matches.forEach(function (m) {
      var t = m.table || 'other';
      if (!byTable[t]) { byTable[t] = []; tableOrder.push(t); }
      byTable[t].push(m);
    });

    return React.createElement('div', { className: 'fs-topic-detail__propagate' },
      React.createElement('div', { className: 'fs-topic-detail__propagate-question' },
        'Also fix ' + preview.field_count + ' other place' + (preview.field_count === 1 ? '' : 's') + ' in this topic?'),
      tableOrder.map(function (table) {
        return React.createElement('div', { key: table, className: 'fs-topic-detail__propagate-group' },
          Badge ? React.createElement(Badge, { size: 'sm', tone: 'neutral', variant: 'outline' }, table)
                : React.createElement('span', null, table),
          React.createElement('ul', { className: 'fs-topic-detail__propagate-list' },
            byTable[table].map(function (m, i) {
              return React.createElement('li', { key: table + '-' + i, className: 'fs-topic-detail__propagate-item' },
                (m.before_snippet || '') + ' → ' + (m.after_snippet || ''));
            }),
          ),
        );
      }),
      React.createElement('div', { className: 'fs-topic-detail__propagate-actions' },
        !confirmArmed
          ? (Button ? React.createElement(Button, {
              size: 'sm', variant: 'secondary', disabled: busy,
              onClick: function () { setConfirmArmed(true); },
            }, 'Fix these too') : null)
          : React.createElement(React.Fragment, null,
              Button ? React.createElement(Button, {
                size: 'sm', variant: 'primary', disabled: busy, onClick: apply,
              }, busy ? 'Applying…' : 'Confirm — apply to all ' + preview.field_count) : null,
              Button ? React.createElement(Button, {
                size: 'sm', variant: 'ghost', disabled: busy,
                onClick: function () { setConfirmArmed(false); },
              }, 'Cancel') : null,
            ),
      ),
    );
  }

  /* life-conversation separation (Task 11) — one confirm+remove action writes
     BOTH the redaction (createRedaction) and the human verdict
     (submitClassificationFeedback). Placed beside GlossaryConfirm since both
     are small per-topic review affordances rendered inline in the detail
     pane. */
  function TopicReviewButtons(props) {
    // props: { topicRowId, workClass, workConfidence, category, onRemoved }
    var IconBtn = window.FieldSight.IconButton;
    var busyRef = React.useState(false);
    var busy = busyRef[0], setBusy = busyRef[1];
    if (!IconBtn || !props.topicRowId) return null;
    var isFlagged = props.workClass === 'non_work';

    function toast(msg, tone) {
      var t = window.FS && window.FS.toast;
      if (t) t.show({ message: msg, tone: tone || 'success', duration: tone === 'error' ? 5000 : 3000 });
    }
    function feedback(verdict) {
      return window.FS.api.actions.submitClassificationFeedback({
        topic_id: props.topicRowId, human_verdict: verdict,
        classifier_verdict: props.workClass || null,
        classifier_confidence: props.workConfidence != null ? props.workConfidence : null,
        topic_category: props.category || null,
      });
    }
    function remove(verdict) {
      if (busy) return;
      setBusy(true);
      Promise.all([
        window.FS.api.actions.createRedaction(props.topicRowId, 'non_work'),
        feedback(verdict),
      ]).then(function (r) {
        setBusy(false);
        if (!r[0] || r[0]._accessDenied || r[0]._notFound) { toast((r[0] && r[0].error) || 'Could not remove', 'error'); return; }
        toast('Removed from reports');
        /* Optimistic patch (Q2): move the topic into the "Removed / personal" area
           immediately, carrying the just-issued redaction id so the revert
           control there is enabled without waiting for the refetch. */
        var newId = r[0].redaction && r[0].redaction.id;
        var patch = { redacted: true };
        if (newId) patch.redaction_id = newId;
        window.dispatchEvent(new CustomEvent('fs:timeline-refresh', {
          detail: { topicRowId: props.topicRowId, patch: patch },
        }));
        if (props.onRemoved) props.onRemoved();
      }).catch(function () { setBusy(false); toast('Could not remove', 'error'); });
    }
    function keepAsWork() {
      if (busy) return;
      setBusy(true);
      feedback('reject_is_work').then(function () {
        setBusy(false); toast('Kept as work');
        window.dispatchEvent(new CustomEvent('fs:timeline-refresh'));   // clears the "suspected personal" flag
      }).catch(function () { setBusy(false); toast('Could not save', 'error'); });
    }

    return React.createElement('div', { className: 'fs-topic-detail__review' },
      isFlagged
        ? React.createElement(React.Fragment, null,
            React.createElement('span', { className: 'fs-topic-detail__review-flag' }, 'Possibly personal · needs review '),
            React.createElement(IconBtn, { icon: 'check', size: 'sm', variant: 'ghost', disabled: busy,
              ariaLabel: 'Confirm personal and remove', onClick: function () { remove('confirm_non_work'); } }),
            React.createElement(IconBtn, { icon: 'x', size: 'sm', variant: 'ghost', disabled: busy,
              ariaLabel: 'Actually work-related', onClick: keepAsWork }))
        : React.createElement(IconBtn, { icon: 'user-x', size: 'sm', variant: 'ghost', disabled: busy,
            ariaLabel: 'Mark as personal and remove', onClick: function () { remove('missed_personal'); } }),
    );
  }

  /* editable-content-correction — inline free-text editor. Blur (or Ctrl+Enter)
     commits via updateContent(table, id, {field: value}); optimistic, reverts +
     toasts on failure. Read-only fallback renders `display`.
     showGlossaryConfirm (Task 18) — when true AND the save response carries
     D2 diff candidates, renders GlossaryConfirm beneath the textarea. */
  function EditableText(props) {
    var editable = props.editable;
    var ref = React.useState(props.value || '');
    var value = ref[0], setValue = ref[1];
    var busyRef = React.useState(false);
    var busy = busyRef[0], setBusy = busyRef[1];
    var candidatesRef = React.useState([]);
    var candidates = candidatesRef[0], setCandidates = candidatesRef[1];
    /* content-propagate (item #3) — the before/after TERM derived from this
       commit, when one lines up with a flagged D2 candidate (see
       findCorrectionPair above). Null = nothing to offer propagating. */
    var correctionPairRef = React.useState(null);
    var correctionPair = correctionPairRef[0], setCorrectionPair = correctionPairRef[1];

    if (!editable) {
      return React.createElement(props.tag || 'span',
        { className: props.className }, props.display != null ? props.display : (props.value || '—'));
    }
    /* content-correction Phase D — explicit ✓ Save. Unchanged value: just exit.
       Success: exit the editor UNLESS glossary candidates need confirming (keep
       it open for GlossaryConfirm). Failure: revert + toast, stay open to retry
       or cancel. onExitEdit closes pencil-toggle (Pattern B) editors; absent for
       always-on (Pattern A) fields. */
    function commit() {
      var next = value;
      if (next === (props.value || '')) { if (props.onExitEdit) props.onExitEdit(); return; }
      setBusy(true);
      window.FS.api.actions.updateContent(props.table, props.id, (function () {
        var p = {}; p[props.field] = next; return p;
      })()).then(function (res) {
        setBusy(false);
        if (!res || res._accessDenied || res._notFound) {
          setValue(props.value || '');
          var toast = window.FS && window.FS.toast;
          if (toast) toast.show({ message: (res && res.error) || 'Could not save edit',
                                  tone: 'error', duration: 5000 });
          return;
        }
        if (props.showGlossaryConfirm && res.candidates && res.candidates.length) {
          setCandidates(res.candidates);
          /* content-propagate (item #3) — a sibling offer to GlossaryConfirm,
             not gated by the same site_manager+ glossary-promotion authority:
             any editor who just made this correction may want it fanned out
             across the topic. Only set (and only then does
             TopicCorrectionPropagate mount + auto-preview) when the word diff
             actually finds a clean substitution behind the candidate — see
             findCorrectionPair's header note on why a null here is correct. */
          setCorrectionPair(findCorrectionPair(props.value || '', next, res.candidates));
          if (props.onSaved) props.onSaved(res);
          return;   // keep the editor open so the user can confirm glossary terms
        }
        if (props.onSaved) props.onSaved(res);
        if (props.onExitEdit) props.onExitEdit();
      }).catch(function () {
        setBusy(false);
        setValue(props.value || '');
        var toast = window.FS && window.FS.toast;
        if (toast) toast.show({ message: 'Could not save edit', tone: 'error', duration: 5000 });
      });
    }

    /* ✕ Cancel — discard the in-progress edit (restore last-saved value) and
       exit; never writes. */
    function cancel() {
      setValue(props.value || '');
      setCandidates([]);
      setCorrectionPair(null);
      if (props.onExitEdit) props.onExitEdit();
    }
    var IconBtn = window.FieldSight.IconButton;
    return React.createElement(React.Fragment, null,
      React.createElement('textarea', {
        className: 'fs-content-edit' + (busy ? ' fs-content-edit--busy' : ''),
        value: value, rows: props.rows || 2, disabled: busy,
        'aria-label': props.ariaLabel || props.field,
        onChange: function (e) { setValue(e.target.value); },
        /* blur no longer commits (explicit-save). Ctrl+Enter saves, Esc cancels. */
        onKeyDown: function (e) {
          if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        },
      }),
      React.createElement('div', { className: 'fs-content-edit__controls' },
        IconBtn ? React.createElement(IconBtn, {
          icon: 'check', size: 'sm', variant: 'ghost', disabled: busy,
          ariaLabel: 'Save', onClick: commit,
        }) : null,
        IconBtn ? React.createElement(IconBtn, {
          icon: 'x', size: 'sm', variant: 'ghost', disabled: busy,
          ariaLabel: 'Cancel', onClick: cancel,
        }) : null),
      candidates.length > 0 ? React.createElement(GlossaryConfirm, {
        candidates: candidates,
        onConfirmed: function (term) {
          setCandidates(function (cur) { return cur.filter(function (c) { return c !== term; }); });
        },
      }) : null,
      /* content-propagate (item #3) — sibling of GlossaryConfirm above.
         Requires a durable topicId (threaded in by every call site that
         also sets showGlossaryConfirm); no topicId, no offer. Keyed on the
         pair so a second edit producing a different pair remounts fresh
         (fresh preview) rather than reusing stale internal state. */
      correctionPair && props.topicId ? React.createElement(TopicCorrectionPropagate, {
        key:      props.topicId + '|' + correctionPair.before + '|' + correctionPair.after,
        topicId:  props.topicId,
        before:   correctionPair.before,
        after:    correctionPair.after,
        onApplied: function () { setCorrectionPair(null); },
      }) : null,
    );
  }

  /* editable-content-correction (Task 18 Step 1) — content_edits audit
     trail for one row, mirrors tasks.js's ActionHistoryPanel (fetch on
     mount, render a list). */
  function ContentHistoryPanel(props) {
    var dataRef = React.useState({ status: 'loading' });
    var data = dataRef[0], setData = dataRef[1];
    React.useEffect(function () {
      var alive = true;
      window.FS.api.actions.getContentHistory(props.table, props.id).then(function (res) {
        if (!alive) return;
        setData({ status: 'ok', edits: (res && res.edits) || [] });
      }).catch(function () { if (alive) setData({ status: 'error', edits: [] }); });
      return function () { alive = false; };
    }, [props.table, props.id]);
    if (data.status === 'loading') return React.createElement('div', { className: 'fs-muted' }, 'Loading…');
    if (!data.edits.length) return React.createElement('div', { className: 'fs-muted' }, 'No edits yet.');
    return React.createElement('ul', { className: 'fs-content-history' },
      data.edits.map(function (e) {
        var f = formatContentEdit(e);
        return React.createElement('li', { key: e.id, className: 'fs-content-history__item' },
          React.createElement('div', { className: 'fs-content-history__meta' },
            React.createElement('span', { className: 'fs-content-history__field' }, f.field),
            ' · ' + f.when + ' · edited by ' + f.who),
          React.createElement('div', { className: 'fs-content-history__diff' },
            f.segments.map(function (seg, i) {
              var cls = seg.type === 'del' ? 'fs-content-history__del'
                      : seg.type === 'ins' ? 'fs-content-history__ins'
                      : 'fs-content-history__same';
              return React.createElement('span', { key: i, className: cls }, seg.text);
            })));
      }));
  }

  function OverviewTab(props) {
    var topic = props.topic;
    var SafetyFlagRow = window.FieldSight.SafetyFlagRow;
    var ActionItemRow = window.FieldSight.ActionItemRow;
    var IconBtn        = window.FieldSight.IconButton;

    var actions = topic.action_items || [];
    var flags   = topic.safety_flags || [];
    var deciss  = topic.key_decisions || [];
    /* editable-content-correction — `findings` is the raw per-topic passthrough
       (Task 8, D3 "additive passthrough"); domain==='safety' entries are
       already surfaced above via `flags` (render_report_shape builds flags
       FROM the same findings when present), so this section only needs the
       rest (quality + any other future domain) to avoid showing the same
       row twice. */
    var findings = (topic.findings || []).filter(function (f) {
      return f && f.domain !== 'safety';
    });

    /* editable-content-correction — UX-only gate (backend patch_content ACL
       is authoritative); site_manager+/PM see it via content:edit,
       report authors see it on their own report via isOwnReport (threaded
       down from TimelineRightDetail below). hasContentEditPerm (the pure
       role-permission half, WITHOUT the isOwnReport OR-branch) additionally
       gates glossary promotion below — D7 requires site_manager+ for that,
       so an author editing their own report but below site_manager can
       correct text but not promote it to the glossary. */
    var caller = (window.AuthMock && window.AuthMock.currentUser) || null;
    var hasContentEditPerm = !!(window.FS && window.FS.can && window.FS.P
        && window.FS.can(caller, window.FS.P('content', 'edit')));
    var canEditContent = hasContentEditPerm || !!props.isOwnReport;
    var canConfirmGlossary = hasContentEditPerm && isSiteManagerPlus(caller);
    var topicRowId = topic.topic_row_id;   // durable topics.id (backend Task 8)

    /* Action items + safety flags render via the shared ActionItemRow /
       SafetyFlagRow composites (unmodified — Task 17 is scoped to
       timeline.js only), so a per-row pencil toggle swaps in an
       EditableText for just that field instead of duplicating the
       composite's own text node. `overrides` remembers the last-saved text
       per row (keyed by table+id) so the composite keeps showing the
       corrected value after the inline editor closes; both reset whenever
       the selected topic changes. */
    var editingRef = React.useState(null);
    var editingKey = editingRef[0], setEditingKey = editingRef[1];
    var overridesRef = React.useState({});
    var overrides = overridesRef[0], setOverrides = overridesRef[1];
    /* editable-content-correction (Task 18 Step 2) — Details/History split
       for this topic's content; resets to Details alongside the edit state
       whenever the selected topic changes. */
    var detailTabRef = React.useState('details');
    var detailTab = detailTabRef[0], setDetailTab = detailTabRef[1];
    React.useEffect(function () {
      setEditingKey(null);
      setOverrides({});
      setDetailTab('details');
    }, [topic.topic_id, topicRowId]);

    function editToggle(key, label) {
      if (!IconBtn || !canEditContent) return null;
      var active = editingKey === key;
      return React.createElement(IconBtn, {
        icon: active ? 'x' : 'pencil',
        ariaLabel: (active ? 'Cancel editing ' : 'Edit ') + label,
        size: 'sm', variant: 'ghost',
        onClick: function () { setEditingKey(active ? null : key); },
      });
    }

    /* editable-content-correction (Task 18 Step 2) — Details/History split,
       same shape as tasks.js's EvidenceTabs usage (~983): 'details' is
       everything below (unchanged from Task 17); 'history' renders
       ContentHistoryPanel against the topic's own durable id. Only shown
       once a durable id exists (meeting topics have none). */
    var detailsBody = React.createElement('div', { className: 'fs-topic-detail__overview' },
      /* life-conversation separation (Task 11) — reviewer-only affordance
         near the topic title: confirm/reject the machine's work_class call,
         soft-removing a confirmed-personal topic (createRedaction) and
         logging the human verdict (submitClassificationFeedback). Gated by
         the same canEditContent used by the edit affordances below. */
      canEditContent && topicRowId ? React.createElement(TopicReviewButtons, {
        topicRowId:     topicRowId,
        workClass:      topic.work_class,
        workConfidence: topic.work_confidence,
        category:       topic.category,
        onRemoved:      null,   // v1: toast + next data refresh; no onContentChanged prop exists here
      }) : null,
      React.createElement(EditableText, {
        /* key forces a fresh mount (and fresh internal useState) whenever the
           selected topic changes — EditableText seeds its textarea value
           from props.value ONLY at mount, and this element (unlike the
           per-row action/flag editors) is always rendered, never toggled
           off, so without a topic-scoped key it would keep showing the
           PREVIOUS topic's stale draft after switching topics. */
        key: 'summary-' + (topicRowId || topic.topic_id),
        editable: canEditContent && !!topicRowId, table: 'topics', id: topicRowId,
        field: 'summary', value: topic.summary || '', display: topic.summary,
        tag: 'p', className: 'fs-topic-detail__summary', rows: 3,
        ariaLabel: 'Edit topic summary', showGlossaryConfirm: canConfirmGlossary,
        topicId: topicRowId,
      }),

      deciss.length > 0
        ? React.createElement('div', { className: 'fs-topic-detail__section' },
            React.createElement('div', { className: 'fs-topic-detail__section-label' },
              'Key decisions'),
            React.createElement('ul', { className: 'fs-topic-detail__decisions' },
              deciss.map(function (d, i) {
                return React.createElement('li', { key: i }, d);
              }),
            ),
          )
        : null,

      actions.length > 0
        ? React.createElement('div', { className: 'fs-topic-detail__section' },
            React.createElement('div', { className: 'fs-topic-detail__section-label' },
              'Action items'),
            /* follow-up (T7 parity) — mirrors topic-card.js's sink+style
               treatment (~242-290): checked action items sink to the
               bottom while unfinished items keep their existing relative
               order. Pair each item with its ORIGINAL idx + derived
               checked state BEFORE sorting so actionIndex/lookupAction/key
               stay tied to the item's real backend position, not its
               sorted render position. .map() returns a fresh array, so
               .sort() here never mutates topic.action_items; the
               comparator only distinguishes checked-vs-not (no secondary
               tiebreaker), so it never reorders two items on the same
               side of the checked/unchecked split (Array.sort is stable
               in evergreen browsers). */
            actions.map(function (a, idx) {
              var state = window.FS.api.actions.lookupAction(props.actionState, props.userFolder, topic.topic_id, idx) || {};
              return { a: a, idx: idx, state: state, checked: !!state.checked };
            }).sort(function (x, y) {
              if (x.checked === y.checked) return 0;
              return x.checked ? 1 : -1;
            }).map(function (pair) {
              var a     = pair.a;
              var idx   = pair.idx;
              var state = pair.state;
              var key   = topic.topic_id + '_' + idx;
              /* editable-content-correction — text-edit toggle for this
                 action item (Task 17 Step 3). `override` is the latest
                 saved text (if any); ActionItemRow keeps rendering it via
                 `displayAction` so the row shows the correction immediately,
                 no full topic re-fetch needed. */
              var editKey  = 'action_items:' + a.id;
              var override = overrides[editKey];
              var displayAction = override !== undefined ? Object.assign({}, a, { action: override }) : a;
              var rowEditable = canEditContent && !!a.id;
              return React.createElement('div', {
                key:       key,
                className: 'fs-topic-detail__action-item'
                  + (pair.checked ? ' fs-row--resolved' : ''),
              },
                React.createElement('div', { className: 'fs-topic-detail__editable-row' },
                  React.createElement(ActionItemRow, {
                    date:           props.date,
                    topicId:        topic.topic_id,
                    actionIndex:    idx,
                    userFolder:     props.userFolder,
                    action:         displayAction,
                    initialChecked: pair.checked,
                    checkedBy:      state.checked_by,
                    /* fix/action-checkoff-sync (Bug 3) — was omitted, so the
                       right panel never showed the "· <time>" half of
                       "Checked by X · <time>" that the middle TopicCard
                       already renders (topic-card.js ~228). ActionItemRow
                       already handles both props; this just feeds it. */
                    checkedAt:      state.checked_at,
                  }),
                  rowEditable ? editToggle(editKey, 'action item text') : null,
                ),
                rowEditable && editingKey === editKey ? React.createElement(EditableText, {
                  editable: true, table: 'action_items', id: a.id, field: 'text',
                  value: override !== undefined ? override : (a.action || ''),
                  ariaLabel: 'Edit action item text', rows: 2,
                  showGlossaryConfirm: canConfirmGlossary, topicId: topicRowId,
                  onSaved: function (res) {
                    var next = res && res.row && res.row.text;
                    setOverrides(function (cur) {
                      var n = Object.assign({}, cur);
                      n[editKey] = next != null ? next : '';
                      return n;
                    });
                    setEditingKey(null);
                  },
                  onExitEdit: function () { setEditingKey(null); },
                }) : null,
              );
            }),
          )
        : null,

      flags.length > 0
        ? React.createElement('div', { className: 'fs-topic-detail__section' },
            React.createElement('div', {
              className: 'fs-topic-detail__section-label fs-topic-detail__section-label--danger',
            }, 'Safety flags'),
            flags.map(function (f, i) {
              /* editable-content-correction — text-edit toggle for this
                 safety flag (Task 17 Step 4). flag.source_table (either
                 'findings' or the legacy 'safety_observations' fallback)
                 threads straight into updateContent's table argument. */
              var editKey  = 'flag:' + (f.source_table || '') + ':' + f.id;
              var override = overrides[editKey];
              var displayFlag = override !== undefined ? Object.assign({}, f, { observation: override }) : f;
              var rowEditable = canEditContent && !!f.id;
              return React.createElement('div', { key: i },
                React.createElement('div', { className: 'fs-topic-detail__editable-row' },
                  React.createElement(SafetyFlagRow, { flag: displayFlag }),
                  rowEditable ? editToggle(editKey, 'safety flag observation') : null,
                ),
                rowEditable && editingKey === editKey ? React.createElement(EditableText, {
                  editable: true, table: f.source_table, id: f.id, field: 'observation',
                  value: override !== undefined ? override : (f.observation || ''),
                  ariaLabel: 'Edit safety flag observation', rows: 2,
                  showGlossaryConfirm: canConfirmGlossary, topicId: topicRowId,
                  onSaved: function (res) {
                    var next = res && res.row && res.row.observation;
                    setOverrides(function (cur) {
                      var n = Object.assign({}, cur);
                      n[editKey] = next != null ? next : '';
                      return n;
                    });
                    setEditingKey(null);
                  },
                  onExitEdit: function () { setEditingKey(null); },
                }) : null,
              );
            }),
          )
        : null,

      /* editable-content-correction (Task 17 Step 4) — findings not already
         covered by the Safety flags section above (i.e. quality-domain +
         any future domain). No pre-existing composite shows this content,
         so — unlike action items/flags — EditableText is the sole display
         surface here, exactly like the summary field above: always an
         inline editor when canEditContent, otherwise a plain read-only
         node. */
      findings.length > 0
        ? React.createElement('div', { className: 'fs-topic-detail__section' },
            React.createElement('div', { className: 'fs-topic-detail__section-label' },
              'Findings'),
            findings.map(function (f, i) {
              var rowEditable = canEditContent && !!f.id;
              var caption = [f.entity_name, f.entity_trade].filter(Boolean).join(' · ');
              return React.createElement('div', { key: f.id || i, className: 'fs-topic-detail__finding' },
                caption ? React.createElement('div', {
                  className: 'fs-topic-detail__finding-caption',
                }, caption) : null,
                React.createElement(EditableText, {
                  editable: rowEditable, table: 'findings', id: f.id, field: 'observation',
                  value: f.observation || '', display: f.observation,
                  tag: 'div', className: 'fs-topic-detail__finding-observation', rows: 2,
                  ariaLabel: 'Edit finding observation', showGlossaryConfirm: canConfirmGlossary,
                  topicId: topicRowId,
                }),
                (rowEditable || f.recommended_action) ? React.createElement(EditableText, {
                  editable: rowEditable, table: 'findings', id: f.id, field: 'recommended_action',
                  value: f.recommended_action || '', display: f.recommended_action,
                  tag: 'div', className: 'fs-topic-detail__finding-action', rows: 2,
                  ariaLabel: 'Edit finding recommended action', showGlossaryConfirm: canConfirmGlossary,
                  topicId: topicRowId,
                }) : null,
              );
            }),
          )
        : null,
    );

    var EvidenceTabs = window.FieldSight.EvidenceTabs;
    if (!topicRowId || !EvidenceTabs) return detailsBody;

    return React.createElement(React.Fragment, null,
      React.createElement(EvidenceTabs, {
        tabs: [
          { key: 'details', label: 'Details' },
          { key: 'history', label: 'History' },
        ],
        active:   detailTab,
        onChange: setDetailTab,
      }),
      detailTab === 'history'
        ? React.createElement(ContentHistoryPanel, { table: 'topics', id: topicRowId })
        : detailsBody,
    );
  }

  /* Body for a meeting topic's Overview tab — different schema than the
     daily report (BACKEND-CONTEXT §5.4): action_items.owner instead of
     responsible, key_decisions are objects with rationale + decided_by,
     no safety_flags, plus open_questions. */
  function MeetingOverviewTab(props) {
    var Badge = window.FieldSight.Badge;
    var topic = props.topic;

    var actions  = topic.action_items   || [];
    var deciss   = topic.key_decisions  || [];
    var openQs   = topic.open_questions || [];

    return React.createElement('div', { className: 'fs-topic-detail__overview' },
      topic.summary ? React.createElement('p', {
        className: 'fs-topic-detail__summary',
      }, topic.summary) : null,

      deciss.length > 0
        ? React.createElement('div', { className: 'fs-topic-detail__section' },
            React.createElement('div', { className: 'fs-topic-detail__section-label' },
              'Key decisions'),
            React.createElement('div', { className: 'fs-meeting-decisions' },
              deciss.map(function (d, i) {
                return React.createElement('div', {
                  key: i, className: 'fs-meeting-decision',
                },
                  React.createElement('div', { className: 'fs-meeting-decision__text' },
                    d.decision),
                  d.rationale ? React.createElement('div', {
                    className: 'fs-meeting-decision__rationale',
                  },
                    React.createElement('span', {
                      className: 'fs-meeting-decision__rationale-label',
                    }, 'Rationale · '),
                    d.rationale,
                  ) : null,
                  d.decided_by ? React.createElement('div', {
                    className: 'fs-meeting-decision__by',
                  }, 'Decided by ' + d.decided_by) : null,
                );
              }),
            ),
          )
        : null,

      actions.length > 0
        ? React.createElement('div', { className: 'fs-topic-detail__section' },
            React.createElement('div', { className: 'fs-topic-detail__section-label' },
              'Action items'),
            React.createElement('div', { className: 'fs-meeting-actions' },
              actions.map(function (a, i) {
                var p = (a.priority || '').toLowerCase();
                return React.createElement('div', {
                  key: i, className: 'fs-meeting-action',
                },
                  React.createElement('div', { className: 'fs-meeting-action__main' },
                    React.createElement('div', { className: 'fs-meeting-action__text' },
                      a.action),
                    React.createElement('div', { className: 'fs-meeting-action__meta' },
                      a.owner    ? React.createElement('span', null, a.owner) : null,
                      a.deadline ? React.createElement('span', null, 'Due ' + a.deadline) : null,
                    ),
                  ),
                  a.priority ? React.createElement(Badge, {
                    tone:    MEETING_PRIORITY_TONE[p] || 'neutral',
                    size:    'sm', variant: 'outline',
                  }, a.priority.charAt(0).toUpperCase() + a.priority.slice(1)) : null,
                );
              }),
            ),
            /* P-10 — read-only caption mirrors the MeetingTopicCard. */
            React.createElement('div', { className: 'fs-meeting-actions__readonly' },
              'Read-only — meeting actions are tracked in the minutes,',
              ' not the daily-action audit log.'),
          )
        : null,

      openQs.length > 0
        ? React.createElement('div', { className: 'fs-topic-detail__section' },
            React.createElement('div', { className: 'fs-topic-detail__section-label' },
              'Open questions'),
            React.createElement('ul', { className: 'fs-topic-detail__decisions' },
              openQs.map(function (q, i) {
                return React.createElement('li', { key: i }, q);
              }),
            ),
          )
        : null,
    );
  }

  function TimelineRightDetail(props) {
    var fs       = window.FieldSight;
    var IconBtn  = fs.IconButton;
    var Badge         = fs.Badge;
    var CategoryBadge = fs.CategoryBadge;

    var refTab = React.useState('overview');
    var tab    = refTab[0];
    var setTab = refTab[1];

    var refActions = React.useState({});
    var setActions = refActions[1];

    var sel = props.selectedItem;
    var isMeeting = sel && sel.kind === 'meeting_topic';
    var isDaily   = sel && sel.kind === 'topic';

    /* Load actions audit state once per (date) — only relevant for
       daily-report topics; meeting actions are read-only. */
    React.useEffect(function () {
      if (!isDaily || !sel || !sel.date) return;
      var cancelled = false;
      window.FS.api.actions.getActions(sel.date).then(function (res) {
        if (!cancelled) setActions(res.actions || {});
      });
      return function () { cancelled = true; };
    }, [isDaily, sel && sel.date]);

    /* Sprint 6.7.1 — same bus subscription as MiddleColumn but for
       this right-detail's action map. Keeps the OverviewTab's
       ActionItemRows synced when the user toggles in the middle
       column. */
    React.useEffect(function () {
      if (!isDaily || !sel || !sel.date) return undefined;
      var bus = window.FS && window.FS.actionsBus;
      if (!bus) return undefined;
      var myDate = sel.date;
      return bus.subscribe(function (payload) {
        if (!payload || payload.date !== myDate) return;
        setActions(function (cur) {
          var key = window.FS.api.actions.actionKey(payload.user_folder, payload.topic_id, payload.action_index);
          var next = Object.assign({}, cur || {});
          next[key] = {
            checked:    !!payload.checked,
            checked_by: payload.checked_by,
            checked_at: payload.checked_at,
          };
          return next;
        });
      });
    }, [isDaily, sel && sel.date]);

    /* Reset tab whenever a new topic is selected. A2-2 — when the
       selection carries a turnTime (Ask citation → transcript-window
       deep link), land straight on the Transcript tab so the flash is
       actually visible instead of hiding behind Overview; daily topics
       only (isMeeting has no transcript tab). */
    React.useEffect(function () {
      setTab(isDaily && sel && sel.turnTime ? 'transcript' : 'overview');
    }, [sel && sel.id, isDaily, sel && sel.turnTime]);

    if (!isDaily && !isMeeting) {
      return React.createElement('div', {
        className: 'fs-topic-detail__placeholder',
      },
        React.createElement('div', { className: 'fs-topic-detail__placeholder-title' },
          'Select a topic'),
        React.createElement('div', { className: 'fs-topic-detail__placeholder-body' },
          'Click any topic in the timeline to view its full detail.'),
      );
    }

    var topic = sel.topic;
    var range = parseTimeRange(topic.time_range);

    /* A2-2 — only ever set by the auto-select effect in
       TimelineMiddleColumn above (never read directly off the route),
       so it's scoped to exactly the topic that deep-link spotlighted —
       a topic the user opens by hand carries no turnTime. */
    var highlightTime = sel.turnTime || null;

    var TranscriptList = fs.TranscriptList;
    var AudioPlaylist  = fs.AudioPlaylist;
    var VideoPlayer    = fs.VideoPlayer;
    var PhotoGrid      = fs.PhotoGrid;
    var AskChat        = fs.AskChat;

    /* user-dimension audit key plan (Task 5) — report OWNER's folder,
       never the caller. sel.user is the section/topic owner folder set
       by the AggregatedDayView + single-user onSelect payloads above;
       sel.user_name is the display name fallback (folderName-derived)
       for callers that only set that. */
    var ownerFolder = sel.user || (sel.user_name && window.FS.api.folderName(sel.user_name)) || null;

    /* editable-content-correction — "own report" fallback for the UX-only
       canEditContent gate (Task 17): true when the signed-in caller IS the
       report owner, mirroring how ownerFolder is derived above. Threaded
       into OverviewTab as props.isOwnReport and reused below for the
       topic-title editor. */
    var rdCaller = (window.AuthMock && window.AuthMock.currentUser) || null;
    var isOwnReport = !!(ownerFolder && rdCaller && rdCaller.name
        && window.FS.api.folderName(rdCaller.name) === ownerFolder);

    /* Q7 (keyframe delete) — SAME canEditContent formula used elsewhere in
       this file: TimelineMiddleColumn ~1335 (hasContentEditPerm ||
       isOwnReport) and OverviewTab ~1894 (identical, via props.isOwnReport).
       Hoisted here — rather than reusing hasContentEditPermTitle below,
       which is computed further down (Step 5, title editor) after
       bodyByTab/PhotoGrid are built — so the PhotoGrid mount has it in
       scope without reordering that unrelated code. Threaded into
       PhotoGrid as `canEditContent` so it can gate the delete affordance
       on auto-generated keyframe photos only. */
    var hasContentEditPermPhotos = !!(window.FS && window.FS.can && window.FS.P
        && window.FS.can(rdCaller, window.FS.P('content', 'edit')));
    var canEditContent = hasContentEditPermPhotos || isOwnReport;

    var mediaProps = {
      date:  sel.date,
      user:  sel.user || (sel.user_name && window.FS.api.folderName(sel.user_name)),
      start: range.start,
      end:   range.end,
    };

    /* Tabs + body content depend on the topic kind. Meeting topics
       skip media tabs — meeting recordings aren't part of the daily
       report's recording bundle (BACKEND-CONTEXT §5.4 / §5.5). */
    var TABS = isMeeting ? MEETING_TABS : DAILY_TABS;

    var bodyByTab;
    if (isMeeting) {
      bodyByTab = {
        overview: React.createElement(MeetingOverviewTab, { topic: topic }),
        ask:      AskChat ? React.createElement(AskChat, {
          alertsProvider: makeAlertsProvider(null),
          date:        sel.date,
          user:        mediaProps.user,
          scope:       'both',  /* meeting transcripts may sit alongside; widen scope */
          topic_id:    topic.topic_id,
          placeholder: 'Ask about this meeting topic…',
          suggestions: [
            'What was decided?',
            'Who owns the follow-ups?',
            'Any open questions?',
          ],
        }) : null,
      };
    } else {
      bodyByTab = {
        overview:   React.createElement(OverviewTab, {
          topic: topic, date: sel.date, actionState: refActions[0], userFolder: ownerFolder,
          isOwnReport: isOwnReport,
        }),
        transcript: TranscriptList ? React.createElement(TranscriptList,
          Object.assign({}, mediaProps, {
            participants:  topic.participants || [],
            highlightTime: highlightTime,
          })) : null,
        audio:      AudioPlaylist  ? React.createElement(AudioPlaylist,  mediaProps) : null,
        video:      VideoPlayer    ? React.createElement(VideoPlayer,    mediaProps) : null,
        photos:     PhotoGrid      ? React.createElement(PhotoGrid, {
          photos:          topic.related_photos || [],
          /* P5: use the resolved folder, not sel.user_name. render_report_shape
             builds user_name as `first_name || ' ' || last_name`; an empty
             last_name yields a trailing space ("Ben_UCPK ") which folderName
             collapses to "Ben_UCPK_", a wrong S3 prefix -> the presign 403s and
             the photo never renders. ownerFolder is sel.user (the real folder
             from the route); folderName() is idempotent on it. */
          userDisplayName: ownerFolder || sel.user_name,
          date:            sel.date,
          canEditContent:  canEditContent,
        }) : null,
        ask:        AskChat        ? React.createElement(AskChat, {
          alertsProvider: makeAlertsProvider(null),
          date:        sel.date,
          user:        mediaProps.user,
          scope:       'both',
          topic_id:    topic.topic_id,
          placeholder: 'Ask about this topic…',
          suggestions: [
            'What was decided?',
            'Who is responsible for follow-ups?',
            'Were any risks flagged?',
          ],
        }) : null,
      };
    }

    /* editable-content-correction (Task 17 Step 5) — topic title, single
       row keyed off the same durable topics.id as the summary field
       (OverviewTab computes its own copy of this gate; safe for meeting
       topics too since they carry no topic_row_id, so `editable` is
       always false there regardless of canEditTitle). */
    var hasContentEditPermTitle = !!(window.FS && window.FS.can && window.FS.P
        && window.FS.can(rdCaller, window.FS.P('content', 'edit')));
    var canEditTitle = hasContentEditPermTitle || isOwnReport;
    var canConfirmGlossaryTitle = hasContentEditPermTitle && isSiteManagerPlus(rdCaller);
    var titleRowId = topic.topic_row_id;

    /* Status pill (meeting only) — sits next to the category badge. */
    var statusPill = isMeeting && topic.status
      ? React.createElement(Badge, {
          tone: MEETING_STATUS_TONE[topic.status] || 'neutral',
          size: 'sm', variant: 'outline',
        }, MEETING_STATUS_LABEL[topic.status] || topic.status)
      : null;

    return React.createElement('div', {
      className: 'fs-topic-detail' + (isMeeting ? ' fs-topic-detail--meeting' : ''),
    },

      /* Header */
      React.createElement('div', { className: 'fs-topic-detail__header' },
        React.createElement('div', { className: 'fs-topic-detail__header-main' },
          React.createElement('div', { className: 'fs-topic-detail__time' },
            topic.time_range || '—'),
          React.createElement(EditableText, {
            /* key forces a fresh mount per topic — see the matching comment
               on the summary EditableText above (same stale-draft risk). */
            key: 'title-' + (titleRowId || topic.topic_id || (sel && sel.id)),
            editable: canEditTitle && !!titleRowId, table: 'topics', id: titleRowId,
            field: 'title', value: topic.topic_title || '', display: topic.topic_title || '(untitled)',
            tag: 'h2', className: 'fs-topic-detail__title', rows: 1,
            ariaLabel: 'Edit topic title', showGlossaryConfirm: canConfirmGlossaryTitle,
            topicId: titleRowId,
          }),
          React.createElement('div', { className: 'fs-topic-detail__metaline' },
            CategoryBadge ? React.createElement(CategoryBadge, {
              category: topic.category,
            }) : null,
            statusPill,
            (topic.participants || []).length
              ? React.createElement('span', {
                  className: 'fs-topic-detail__participants',
                }, (topic.participants || []).join(' · '))
              : null,
          ),
        ),
        IconBtn ? React.createElement(IconBtn, {
          icon: 'x', ariaLabel: 'Close detail', size: 'sm',
          onClick: function () { if (props.onClose) props.onClose(); },
        }) : null,
      ),

      /* Tab strip */
      React.createElement('div', {
        className: 'fs-topic-detail__tabs',
        role:      'tablist',
      },
        TABS.map(function (t) {
          var active = t.key === tab;
          return React.createElement('button', {
            key:           t.key,
            type:          'button',
            role:          'tab',
            'aria-selected': active,
            className:     'fs-topic-detail__tab' + (active ? ' fs-topic-detail__tab--active' : ''),
            onClick:       function () { setTab(t.key); },
          }, t.label);
        }),
      ),

      /* Body */
      React.createElement('div', { className: 'fs-topic-detail__body' },
        bodyByTab[tab],
      ),
    );
  }

  /* ---------- Register -------------------------------------------------- */

  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.PAGES) window.FieldSight.PAGES = {};
  window.FieldSight.PAGES['/timeline'] = {
    Middle: TimelineMiddleColumn,
    Right:  TimelineRightDetail,
  };

  /* fix/closed-by-display — ContentHistoryPanel is generic over
     content.EDITABLE (which includes action_items), but was only ever
     mounted here with table:'topics'. Exposed on window.FieldSight so
     tasks.js's TasksRightDetail (loaded AFTER this file — see
     app-shell-preview.html script order) can mount the SAME panel for one
     action item's own row (table:'action_items', id: row.actionItemId),
     rather than duplicating the fetch-on-mount component. */
  window.FieldSight.ContentHistoryPanel = ContentHistoryPanel;

  /* feat/today-title-edit — same rationale/pattern as ContentHistoryPanel
     just above: EditableText is generic over content.EDITABLE (table/id/
     field are all props, not hardcoded here), was previously only ever
     mounted from inside this file (topic summary / action item text /
     safety flag observation), and is now also mounted by today.js's
     TodayRightDetail (loaded BEFORE this file in app-shell-preview.html,
     but that's fine — the reference is read at RENDER time, well after
     every page script has finished its top-level, synchronous
     window.FieldSight.* assignment) for the action-item title editor on
     /today, behind the same content:edit-or-own-report gate this file
     uses. Reuse, not a duplicate copy of the textarea/save/cancel/
     glossary-confirm logic. */
  window.FieldSight.EditableText = EditableText;

  /* Expose the pure life-sep override helpers to Node's test runner only
     (CommonJS). No-op in the browser (Babel standalone leaves `module`
     undefined), so the page bundle is unaffected. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      applyTopicOverrides: applyTopicOverrides,
      partitionTopics: partitionTopics,
      /* own-day-first landing + the way back out of a person's day */
      canSeeOverview: canSeeOverview,
      isAdminLike: isAdminLike,
      resolveTimelineScope: resolveTimelineScope,
      reconcileTopicOverrides: reconcileTopicOverrides,
      diffWords: diffWords,
      formatEditTime: formatEditTime,
      formatContentEdit: formatContentEdit,
      /* live recording KPIs */
      fmtRecordedTime: fmtRecordedTime,
      /* content-propagate (item #3) */
      findCorrectionPair: findCorrectionPair,
      TopicCorrectionPropagate: TopicCorrectionPropagate,
      /* session picker (feat 5) */
      shouldShowSessionPicker: shouldShowSessionPicker,
      filterTopicsBySession: filterTopicsBySession,
      groupSessionsByBlock: groupSessionsByBlock,
      formatParticipants: formatParticipants,
      formatSessionSummary: formatSessionSummary,
      formatExcludedNote: formatExcludedNote,
      /* meeting-scoped email draft (#10, mailto v1) */
      collectSessionActionItems: collectSessionActionItems,
      unionSessionParticipants: unionSessionParticipants,
      formatActionLine: formatActionLine,
      assembleEmailBody: assembleEmailBody,
      buildSessionEmailDraft: buildSessionEmailDraft,
    };
  }

})();
