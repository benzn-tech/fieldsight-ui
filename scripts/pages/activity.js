/* ==========================================================================
   FieldSight Activity Page — Sprint 4.1
   --------------------------------------------------------------------------
   /activity — time-sorted feed of "what just happened" across recent
   days. Distinct from /timeline (which is one structured report per
   date+user); Activity is a scannable stream with date-header
   grouping.

   Middle column:
     • Header: title + range caption + "Load more" affordance
     • Date-grouped feed rows (one ActivityFeedRow per topic), most
       recent date at the top, most recent time at the top within each
       group.

   Right detail:
     • Selected topic preview: time, title, summary, participants,
       counts (decisions / actions / safety flags / photos)
     • CTA: "Open in timeline" → /timeline?date=…&user=…

   Architecture:
     • ActivityProvider owns the page state via ActivityContext —
       mirrors SitesProvider / TodayProvider (Sprint 3 P-07 pattern).
     • Default range: last 5 days with reports (cap protects perf —
       fans out N getTimeline calls). "Load more" extends N by 5.

   Worker rule (BACKEND-CONTEXT §3): user is forced to caller's
   folder name client-side here too (mock api doesn't enforce it).

   Registers as window.FieldSight.PAGES['/activity']
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var INITIAL_DAYS = 5;
  var LOAD_STEP    = 5;

  /* ---------- Helpers --------------------------------------------------- */

  function callerFolder() {
    var u = (window.AuthMock && window.AuthMock.currentUser) || {};
    if (!u.name) return null;
    return window.FS.api.folderName(u.name);
  }

  function isAdminLike(user) {
    return user && (user.role === 'admin' || user.role === 'gm' || user.isAdmin);
  }

  /* Topic time_range uses an en-dash: "07:00 – 07:30". Returns "07:00"
     or '—' for unparseable strings. */
  function startTime(time_range) {
    if (!time_range) return '—';
    var m = String(time_range).match(/(\d{1,2}):(\d{2})/);
    if (!m) return '—';
    var h = m[1].length === 1 ? '0' + m[1] : m[1];
    return h + ':' + m[2];
  }

  function dateLabel(yyyymmdd, today) {
    if (!yyyymmdd) return '';
    if (today && yyyymmdd === today) return 'Today';
    if (today) {
      var prev = window.FS.api.addDaysISO(today, -1);
      if (yyyymmdd === prev) return 'Yesterday';
    }
    var p = String(yyyymmdd).split('-').map(Number);
    if (p.length !== 3) return yyyymmdd;
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return days[d.getUTCDay()] + ' ' + p[2] + ' ' + months[p[1] - 1];
  }

  /* ---------- ActivityContext ------------------------------------------ */

  var ActivityContext = React.createContext(null);

  function ActivityProvider(props) {
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
    var depKey = (caller.name || '') + '|' + (caller.role || '') + '|' + (caller.isAdmin ? 'admin' : '');

    /* `daysToLoad` is the cap: 5 by default, +5 each "Load more". */
    var refDays = React.useState(INITIAL_DAYS);
    var daysToLoad    = refDays[0];
    var setDaysToLoad = refDays[1];

    var refState = React.useState({ status: 'loading' });
    var state    = refState[0];
    var setState = refState[1];

    React.useEffect(function () {
      var cancelled = false;
      setState({ status: 'loading' });

      var user = caller.role === 'worker' || !isAdminLike(caller)
        ? callerFolder()
        : null;

      window.FS.api.dates.getDates({ months: 1 }).then(function (datesRes) {
        if (cancelled) return null;
        if (datesRes && datesRes._accessDenied) {
          setState({ status: 'access_denied', message: datesRes.error });
          return null;
        }
        var datesMap = (datesRes && datesRes.dates) || {};
        var datesWithReports = Object.keys(datesMap)
          .filter(function (d) { return datesMap[d] && datesMap[d].hasReport; })
          .sort()
          .reverse()
          .slice(0, daysToLoad);

        if (datesWithReports.length === 0) {
          setState({ status: 'ok', rows: [], dates: [], today: window.FS.api.todayNZDT() });
          return null;
        }

        return Promise.all(datesWithReports.map(function (d) {
          return window.FS.api.timeline.getTimeline({ date: d, user: user })
            .then(function (r) { return { date: d, report: r }; });
        })).then(function (perDay) {
          if (cancelled) return;

          var rows = [];
          var anyDenied = perDay.some(function (x) { return x.report && x.report._accessDenied; });
          if (anyDenied) {
            setState({ status: 'access_denied', message: 'Some reports denied for your role' });
            return;
          }

          perDay.forEach(function (x) {
            var r = x.report;
            if (!r || r._notFound || r.available_users) return;
            (r.topics || []).forEach(function (t) {
              rows.push({
                id:           x.date + '_topic_' + t.topic_id,
                date:         x.date,
                time_label:   startTime(t.time_range),
                topic_id:     t.topic_id,
                topic:        t,
                speaker:      (t.participants || [])[0] || r.user_name,
                snippet:      t.summary || t.topic_title,
                category:     t.category,
                user_name:    r.user_name,
                user_folder:  r.user_name ? window.FS.api.folderName(r.user_name) : null,
              });
            });
          });

          /* Sort desc by (date, time). */
          rows.sort(function (a, b) {
            if (a.date !== b.date) return a.date < b.date ? 1 : -1;
            return a.time_label < b.time_label ? 1 : -1;
          });

          setState({
            status: 'ok',
            rows:   rows,
            dates:  datesWithReports,
            today:  window.FS.api.todayNZDT(),
          });
        });
      }).catch(function (err) {
        if (cancelled) return;
        setState({ status: 'error', error: err });
      });

      return function () { cancelled = true; };
    }, [depKey, daysToLoad]);

    function loadMore() { setDaysToLoad(function (n) { return n + LOAD_STEP; }); }

    var ctx = { state: state, daysToLoad: daysToLoad, loadMore: loadMore };
    return React.createElement(ActivityContext.Provider, { value: ctx },
      props.children);
  }

  /* ---------- ActivityMiddleColumn ------------------------------------- */

  function ActivityMiddleColumn(props) {
    var fs              = window.FieldSight;
    var ActivityFeedRow = fs.ActivityFeedRow;
    var Button          = fs.Button;
    var onSelect        = props.onSelect || function () {};

    var ctx = React.useContext(ActivityContext);
    if (!ctx) {
      console.warn('[ActivityMiddleColumn] ActivityContext missing');
      return null;
    }
    var state = ctx.state;

    if (state.status === 'loading') {
      return React.createElement('div', { className: 'fs-activity' },
        React.createElement('div', { className: 'fs-activity__loading' },
          'Loading activity…'),
      );
    }

    if (state.status === 'error') {
      return React.createElement('div', { className: 'fs-activity' },
        React.createElement('div', { className: 'fs-activity__empty' },
          'Could not load activity. ' + (state.error && state.error.message || '')),
      );
    }

    if (state.status === 'access_denied') {
      var AccessDenied = fs.AccessDenied;
      return React.createElement('div', { className: 'fs-activity' },
        AccessDenied
          ? React.createElement(AccessDenied, {
              scope:   'this activity feed',
              message: state.message,
            })
          : React.createElement('div', null, 'Access denied.'),
      );
    }

    var rows  = state.rows  || [];
    var today = state.today || null;
    var selectedId = props.selectedItem && props.selectedItem.kind === 'activity_topic'
      ? props.selectedItem.id
      : null;

    if (rows.length === 0) {
      return React.createElement('div', { className: 'fs-activity' },
        React.createElement(Header, {
          rowCount: 0, dayCount: (state.dates || []).length, ctx: ctx,
        }),
        React.createElement('div', { className: 'fs-activity__empty' },
          'No activity in the last ' + ctx.daysToLoad + ' days.'),
      );
    }

    /* Group rows by date, preserving order. */
    var groups = [];
    var currentDate = null;
    rows.forEach(function (row) {
      if (row.date !== currentDate) {
        groups.push({ date: row.date, rows: [] });
        currentDate = row.date;
      }
      groups[groups.length - 1].rows.push(row);
    });

    return React.createElement('div', { className: 'fs-activity' },

      React.createElement(Header, {
        rowCount: rows.length, dayCount: (state.dates || []).length, ctx: ctx,
      }),

      React.createElement('div', { className: 'fs-activity__feed' },
        groups.map(function (g) {
          return React.createElement(React.Fragment, { key: g.date },
            React.createElement('div', { className: 'fs-activity__date-header' },
              dateLabel(g.date, today)),
            React.createElement('div', { className: 'fs-activity__group' },
              g.rows.map(function (row) {
                return React.createElement(ActivityFeedRow, {
                  key:      row.id,
                  row:      row,
                  selected: selectedId === row.id,
                  onSelect: function () {
                    onSelect({
                      kind:        'activity_topic',
                      id:          row.id,
                      topic_id:    row.topic_id,
                      topic:       row.topic,
                      date:        row.date,
                      user:        row.user_folder,
                      user_name:   row.user_name,
                    });
                  },
                });
              }),
            ),
          );
        }),
      ),

      /* Load more — only show if we got back as many days as we asked for. */
      (state.dates || []).length >= ctx.daysToLoad
        ? React.createElement('div', { className: 'fs-activity__load-more' },
            React.createElement(Button, {
              variant: 'secondary', size: 'sm',
              onClick: ctx.loadMore,
            }, 'Load more (+' + LOAD_STEP + ' days)'),
          )
        : null,
    );
  }

  function Header(props) {
    return React.createElement('div', { className: 'fs-activity__header' },
      React.createElement('h2', { className: 'fs-activity__title' }, 'Activity'),
      React.createElement('div', { className: 'fs-activity__subtitle' },
        props.rowCount + ' '
          + (props.rowCount === 1 ? 'event' : 'events')
          + ' across last ' + props.ctx.daysToLoad + ' days'
          + (props.dayCount < props.ctx.daysToLoad
              ? ' · ' + props.dayCount + ' with reports'
              : '')),
    );
  }

  /* ---------- ActivityRightDetail -------------------------------------- */

  function ActivityRightDetail(props) {
    var fs            = window.FieldSight;
    var Card          = fs.Card;
    var Badge         = fs.Badge;
    var Button        = fs.Button;
    var IconBtn       = fs.IconButton;
    var CategoryBadge = fs.CategoryBadge;

    var sel = props.selectedItem;

    if (!sel || sel.kind !== 'activity_topic') {
      return React.createElement('div', { className: 'fs-activity-detail__placeholder' },
        React.createElement('div', { className: 'fs-activity-detail__placeholder-title' },
          'Select an event'),
        React.createElement('div', { className: 'fs-activity-detail__placeholder-body' },
          'Pick any row in the feed for a quick preview, then jump into the full timeline.'),
      );
    }

    var topic = sel.topic || {};
    var counts = {
      decisions:    (topic.key_decisions  || []).length,
      actions:      (topic.action_items   || []).length,
      safety_flags: (topic.safety_flags   || []).length,
      photos:       (topic.related_photos || []).length,
    };

    function openInTimeline() {
      var qs = '?date=' + encodeURIComponent(sel.date);
      if (sel.user) qs += '&user=' + encodeURIComponent(sel.user);
      window.FS.Router.navigate('/timeline' + qs);
    }

    return React.createElement('div', { className: 'fs-activity-detail' },

      React.createElement('div', { className: 'fs-activity-detail__header' },
        React.createElement('div', { className: 'fs-activity-detail__header-main' },
          React.createElement('div', { className: 'fs-activity-detail__time' },
            (topic.time_range || '—') + '  ·  ' + (sel.date || '')),
          React.createElement('h2', { className: 'fs-activity-detail__title' },
            topic.topic_title || '(untitled topic)'),
          React.createElement('div', { className: 'fs-activity-detail__metaline' },
            CategoryBadge && topic.category
              ? React.createElement(CategoryBadge, { category: topic.category })
              : null,
            (topic.participants || []).length
              ? React.createElement('span', {
                  className: 'fs-activity-detail__participants',
                }, (topic.participants || []).join(' · '))
              : null,
          ),
        ),
        IconBtn ? React.createElement(IconBtn, {
          icon: 'x', ariaLabel: 'Close detail', size: 'sm',
          onClick: function () { if (props.onClose) props.onClose(); },
        }) : null,
      ),

      topic.summary
        ? React.createElement('p', { className: 'fs-activity-detail__summary' },
            topic.summary)
        : null,

      /* Counts strip */
      React.createElement('div', { className: 'fs-activity-detail__counts' },
        React.createElement(CountChip, {
          label: 'Decisions', value: counts.decisions,
        }),
        React.createElement(CountChip, {
          label: 'Actions',   value: counts.actions,
        }),
        React.createElement(CountChip, {
          label: 'Safety',    value: counts.safety_flags,
          tone:  counts.safety_flags > 0 ? 'danger' : 'neutral',
        }),
        React.createElement(CountChip, {
          label: 'Photos',    value: counts.photos,
        }),
      ),

      /* Action footer */
      React.createElement('div', { className: 'fs-activity-detail__actions' },
        React.createElement(Button, {
          size: 'sm', leftIcon: 'arrow-right',
          onClick: openInTimeline,
        }, 'Open in timeline'),
      ),
    );
  }

  function CountChip(props) {
    var className = 'fs-activity-detail__count'
      + (props.tone === 'danger' ? ' fs-activity-detail__count--danger' : '');
    return React.createElement('div', { className: className },
      React.createElement('div', { className: 'fs-activity-detail__count-value' },
        props.value),
      React.createElement('div', { className: 'fs-activity-detail__count-label' },
        props.label),
    );
  }

  /* ---------- Register --------------------------------------------------- */

  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.PAGES) window.FieldSight.PAGES = {};
  window.FieldSight.PAGES['/activity'] = {
    Middle:   ActivityMiddleColumn,
    Right:    ActivityRightDetail,
    Provider: ActivityProvider,
  };

})();
