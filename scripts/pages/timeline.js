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

  function isAdminLike(user) {
    return user && (user.role === 'admin' || user.role === 'gm' || user.isAdmin);
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
      (user && isAdminLike((window.AuthMock && window.AuthMock.currentUser) || {}))
        ? React.createElement('button', {
            type:      'button',
            className: 'fs-btn fs-btn--tertiary fs-btn--sm',
            style:     { marginTop: '6px' },
            onClick:   function () {
              window.FS.Router.navigate('/timeline?date=' + (date || '')
                + (site ? '&site=' + encodeURIComponent(site) : ''));
            },
          }, site ? '← All people on this site' : '← Back to overview')
        : null,
    );
  }

  /* ---------- KpiStrip wired from report metadata ---------------------- */

  function ReportKpis(props) {
    var KpiStrip = window.FieldSight.KpiStrip;
    var StatCard = window.FieldSight.StatCard;
    var report = props.report || {};

    var topics  = (report.topics || []).length;
    var safetyCount = (report.topics || []).reduce(function (acc, t) {
      var tagged = (t.category === 'safety') || ((t.safety_flags || []).length > 0);
      return acc + (tagged ? 1 : 0);
    }, 0);
    var meta = report._report_metadata || {};

    return React.createElement(KpiStrip, null,
      React.createElement(StatCard, {
        value: topics, label: 'Topics',
      }),
      React.createElement(StatCard, {
        value: safetyCount, label: 'Safety', tone: safetyCount > 0 ? 'danger' : 'neutral',
      }),
      React.createElement(StatCard, {
        value: meta.recordings_processed || 0, label: 'Recordings',
      }),
      React.createElement(StatCard, {
        value: meta.total_words ? meta.total_words.toLocaleString() : 0,
        label: 'Words',
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

      window.FS.api.sites.getSiteUsers(props.site).then(function (res) {
        if (cancelled) return;
        var users  = (res && res.users) || [];
        var thunks = users.map(function (u) {
          return function () {
            return window.FS.api.timeline.getTimeline({ date: props.date, user: u.folder_name })
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

    return React.createElement(React.Fragment, null,
      sections.map(function (section) {
        var report         = section.report;
        var sectionUser     = section.user.folder_name;
        var sectionUserName = report.user_name;
        var roleLabel = section.user.role
          ? section.user.role.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); })
          : null;

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
            React.createElement('button', {
              type:      'button',
              className: 'fs-btn fs-btn--tertiary fs-btn--sm',
              onClick:   function () {
                window.FS.Router.navigate('/timeline?site=' + encodeURIComponent(props.site)
                  + '&date=' + props.date + '&user=' + encodeURIComponent(sectionUser));
              },
            }, 'View only'),
          ),
          React.createElement(ReportKpis, { report: report }),
          (report.executive_summary || []).length > 0
            ? React.createElement(ExecutiveSummaryCard, { bullets: report.executive_summary })
            : null,
          React.createElement('div', { className: 'fs-timeline-page__section-label' },
            'Topics'),
          React.createElement('div', { className: 'fs-timeline-page__topics' },
            (report.topics || []).map(function (topic) {
              return React.createElement(TopicCard, {
                key:           topic.topic_id,
                topic:         topic,
                date:          props.date,
                actionState:   actionsMap,
                userFolder:    sectionUser,
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

    /* 联动 — deep-link project sync: a route carrying &site (a cross-project
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

    if (caller.role === 'worker') user = callerFolder();
    if (!user && !site && !isAdminLike(caller)) user = callerFolder();

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

    var refState = React.useState({ status: 'loading' });
    var state    = refState[0];
    var setState = refState[1];

    var retryRef   = React.useState(0);
    var retryCount = retryRef[0];
    var setRetry   = retryRef[1];

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
      }).catch(function (err) {
        if (cancelled) return;
        setState({ status: 'error', error: { code: (err && err.status) || 0, message: (err && err.message) || 'Could not load report', retryable: true }, retry: function () { setRetry(function (n) { return n + 1; }); } });
      });
      return function () { cancelled = true; };
    }, [date, user, retryCount]);

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
    if (site && !user) {
      return React.createElement('div', { className: 'fs-timeline-page' },
        React.createElement(PageHeader, {
          date: date, user: null,
          site: site,
        }),
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

    /* ---- Daily report view (default) ---- */
    return React.createElement('div', {
      className: 'fs-timeline-page',
    },
      React.createElement(PageHeader, {
        date: date, user: user, report: report,
        site: site,
      }),
      React.createElement(ViewToggle),
      React.createElement(ReportKpis, { report: report }),
      React.createElement(ExecutiveSummaryCard, {
        bullets: report.executive_summary,
      }),
      React.createElement('div', { className: 'fs-timeline-page__section-label' },
        'Topics'),
      React.createElement('div', { className: 'fs-timeline-page__topics' },
        (report.topics || []).map(function (topic) {
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
          return React.createElement(TopicCard, {
            key:         topic.topic_id,
            topic:       topic,
            date:        date,
            actionState: actionState,
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

  /* editable-content-correction — inline free-text editor. Blur (or Ctrl+Enter)
     commits via updateContent(table, id, {field: value}); optimistic, reverts +
     toasts on failure. Read-only fallback renders `display`. */
  function EditableText(props) {
    var editable = props.editable;
    var ref = React.useState(props.value || '');
    var value = ref[0], setValue = ref[1];
    var busyRef = React.useState(false);
    var busy = busyRef[0], setBusy = busyRef[1];

    if (!editable) {
      return React.createElement(props.tag || 'span',
        { className: props.className }, props.display != null ? props.display : (props.value || '—'));
    }
    function commit() {
      var next = value;
      if (next === (props.value || '')) return;
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
        if (props.onSaved) props.onSaved(res);
      }).catch(function () {
        setBusy(false);
        setValue(props.value || '');
        var toast = window.FS && window.FS.toast;
        if (toast) toast.show({ message: 'Could not save edit', tone: 'error', duration: 5000 });
      });
    }
    return React.createElement('textarea', {
      className: 'fs-content-edit' + (busy ? ' fs-content-edit--busy' : ''),
      value: value, rows: props.rows || 2, disabled: busy,
      'aria-label': props.ariaLabel || props.field,
      onChange: function (e) { setValue(e.target.value); },
      onBlur: commit,
      onKeyDown: function (e) { if (e.ctrlKey && e.key === 'Enter') commit(); },
    });
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
       down from TimelineRightDetail below). */
    var caller = (window.AuthMock && window.AuthMock.currentUser) || null;
    var canEditContent = !!(window.FS && window.FS.can && window.FS.P
        && window.FS.can(caller, window.FS.P('content', 'edit'))) || !!props.isOwnReport;
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
    React.useEffect(function () {
      setEditingKey(null);
      setOverrides({});
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

    return React.createElement('div', { className: 'fs-topic-detail__overview' },
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
        ariaLabel: 'Edit topic summary',
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
                  onSaved: function (res) {
                    var next = res && res.row && res.row.text;
                    setOverrides(function (cur) {
                      var n = Object.assign({}, cur);
                      n[editKey] = next != null ? next : '';
                      return n;
                    });
                    setEditingKey(null);
                  },
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
                  onSaved: function (res) {
                    var next = res && res.row && res.row.observation;
                    setOverrides(function (cur) {
                      var n = Object.assign({}, cur);
                      n[editKey] = next != null ? next : '';
                      return n;
                    });
                    setEditingKey(null);
                  },
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
                  ariaLabel: 'Edit finding observation',
                }),
                (rowEditable || f.recommended_action) ? React.createElement(EditableText, {
                  editable: rowEditable, table: 'findings', id: f.id, field: 'recommended_action',
                  value: f.recommended_action || '', display: f.recommended_action,
                  tag: 'div', className: 'fs-topic-detail__finding-action', rows: 2,
                  ariaLabel: 'Edit finding recommended action',
                }) : null,
              );
            }),
          )
        : null,
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
          userDisplayName: sel.user_name,
          date:            sel.date,
        }) : null,
        ask:        AskChat        ? React.createElement(AskChat, {
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
    var canEditTitle = !!(window.FS && window.FS.can && window.FS.P
        && window.FS.can(rdCaller, window.FS.P('content', 'edit'))) || isOwnReport;
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
            ariaLabel: 'Edit topic title',
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

})();
