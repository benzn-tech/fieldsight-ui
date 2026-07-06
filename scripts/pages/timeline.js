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
         user list. */
      (user && isAdminLike((window.AuthMock && window.AuthMock.currentUser) || {}))
        ? React.createElement('button', {
            type:      'button',
            className: 'fs-btn fs-btn--tertiary fs-btn--sm',
            style:     { marginTop: '6px' },
            onClick:   function () {
              if (site) {
                window.FS.Router.navigate('/timeline?site=' + encodeURIComponent(site) + '&date=' + (date || ''));
                return;
              }
              var qs = '?date=' + (date || '');
              window.FS.Router.navigate('/timeline' + qs);
            },
          }, site ? '← All people on this site' : 'View another user ↺')
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
        /* Escape hatch — arriving here via "View another user ↺" left no
           way back to the report being viewed (user feedback 2026-07-06). */
        React.createElement('button', {
          type:      'button',
          className: 'fs-btn fs-btn--tertiary fs-btn--sm',
          style:     { marginTop: '10px' },
          onClick:   function () { window.history.back(); },
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
                actionState:   {},
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

    /* Sprint 6.7.2 — deeper precision: when /safety includes
       &flag=<idx>, highlight that specific safety_flag inside the
       target topic (not the whole topic card). null = whole-topic
       flash from 6.6.4. */
    var targetFlagIdx = params.flag != null && params.flag !== ''
      ? parseInt(params.flag, 10)
      : null;
    if (targetFlagIdx !== null && isNaN(targetFlagIdx)) targetFlagIdx = null;

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
      window.FS.api.sites.getSites()
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
          window.FS.Router.navigate('/timeline?date=' + resolved + qsUser + qsSite);
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
          window.FS.Router.navigate('/timeline?date=' + resolved + qsUser + qsSite);
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
          var key = payload.topic_id + '_' + payload.action_index;
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
      if (state.status !== 'ok' || targetTopicId === null) return;
      var report = state.report;
      if (!report || report._notFound || report.available_users) return;
      var key = date + '|' + targetTopicId;
      if (autoSelectKeyRef.current === key) return;
      var topic = (report.topics || []).filter(function (t) {
        return String(t.topic_id) === String(targetTopicId);
      })[0];
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
        });
      }
    }, [state.status, targetTopicId, date]);

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
          var isTarget = targetTopicId !== null && String(topic.topic_id) === String(targetTopicId);
          var defaultOpenProp = targetTopicId === null
            ? undefined
            : isTarget;
          return React.createElement(TopicCard, {
            key:         topic.topic_id,
            topic:       topic,
            date:        date,
            actionState: actionState,
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

  function OverviewTab(props) {
    var topic = props.topic;
    var SafetyFlagRow = window.FieldSight.SafetyFlagRow;
    var ActionItemRow = window.FieldSight.ActionItemRow;

    var actions = topic.action_items || [];
    var flags   = topic.safety_flags || [];
    var deciss  = topic.key_decisions || [];

    return React.createElement('div', { className: 'fs-topic-detail__overview' },
      topic.summary ? React.createElement('p', {
        className: 'fs-topic-detail__summary',
      }, topic.summary) : null,

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
            actions.map(function (a, idx) {
              var key = topic.topic_id + '_' + idx;
              var st  = (props.actionState || {})[key] || {};
              return React.createElement(ActionItemRow, {
                key:            key,
                date:           props.date,
                topicId:        topic.topic_id,
                actionIndex:    idx,
                action:         a,
                initialChecked: !!st.checked,
                checkedBy:      st.checked_by,
              });
            }),
          )
        : null,

      flags.length > 0
        ? React.createElement('div', { className: 'fs-topic-detail__section' },
            React.createElement('div', {
              className: 'fs-topic-detail__section-label fs-topic-detail__section-label--danger',
            }, 'Safety flags'),
            flags.map(function (f, i) {
              return React.createElement(SafetyFlagRow, { key: i, flag: f });
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
          var key = payload.topic_id + '_' + payload.action_index;
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

    /* Reset to overview tab whenever a new topic is selected. */
    React.useEffect(function () {
      setTab('overview');
    }, [sel && sel.id]);

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

    var TranscriptList = fs.TranscriptList;
    var AudioPlaylist  = fs.AudioPlaylist;
    var VideoPlayer    = fs.VideoPlayer;
    var PhotoGrid      = fs.PhotoGrid;
    var AskChat        = fs.AskChat;

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
          topic: topic, date: sel.date, actionState: refActions[0],
        }),
        transcript: TranscriptList ? React.createElement(TranscriptList,
          Object.assign({}, mediaProps, {
            participants: topic.participants || [],
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
          React.createElement('h2', { className: 'fs-topic-detail__title' },
            topic.topic_title || '(untitled)'),
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
