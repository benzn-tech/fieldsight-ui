/* ==========================================================================
   FieldSight Safety Page — Sprint 6.1 (middle column) / 6.2 (right detail)
   --------------------------------------------------------------------------
   /safety — cross-day rollup of safety_observations + topic-level
   safety_flags. Reads via the Sprint 6.0 compliance aggregator.

   Middle column:
     • Header — title + context line (range + row count)
     • Range toolbar — Today | Last 7 days | Pick date (single-day mode
       opens DatePicker)
     • KpiStrip — total flags · high-risk · sites affected · open vs
       closed
     • List — rows grouped by date desc, each item is a SafetyFlagRow.
       Click → set selectedFlag in SafetyContext.

   Right detail:
     • Sprint 6.1 ships a placeholder ('Select a flag…' message).
     • Sprint 6.2 replaces it with full-context inspection (status
       badge, observation, action, location, source-report link).

   Architecture mirrors /tasks (Sprint 4.2):
     SafetyProvider holds { status, mode, date, fromTo, rows, totals,
                            selectedFlag } via SafetyContext.

   Registers as window.FieldSight.PAGES['/safety']
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  var DEFAULT_DAYS = 7;

  /* ---------- Helpers --------------------------------------------------- */

  function fmtDate(yyyymmdd) {
    if (!yyyymmdd) return '';
    var p = String(yyyymmdd).split('-').map(Number);
    if (p.length !== 3) return yyyymmdd;
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return p[2] + ' ' + months[p[1] - 1] + ' ' + p[0];
  }

  function fmtDateLong(yyyymmdd) {
    if (!yyyymmdd) return '';
    var p = String(yyyymmdd).split('-').map(Number);
    if (p.length !== 3) return yyyymmdd;
    var months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
    var days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return days[d.getUTCDay()] + ', ' + p[2] + ' ' + months[p[1] - 1] + ' ' + p[0];
  }

  function groupByDate(rows) {
    var byDate = {};
    rows.forEach(function (r) {
      if (!byDate[r.date]) byDate[r.date] = [];
      byDate[r.date].push(r);
    });
    return Object.keys(byDate).sort().reverse().map(function (date) {
      return { date: date, rows: byDate[date] };
    });
  }

  function totalsFromRows(rows) {
    var sites = {};
    var high = 0, openCt = 0, closedCt = 0;
    rows.forEach(function (r) {
      if (r.site) sites[r.site] = true;
      if (r.risk_level === 'high') high += 1;
      if (r.status === 'resolved') closedCt += 1;
      else openCt += 1;
    });
    return {
      total: rows.length,
      high:  high,
      sites: Object.keys(sites).length,
      open:  openCt,
      closed: closedCt,
    };
  }

  /* ---------- SafetyContext --------------------------------------------- */

  var SafetyContext = React.createContext(null);

  function SafetyProvider(props) {
    var caller = (window.AuthMock && window.AuthMock.currentUser) || {};
    var depKey = (caller.name || '') + '|' + (caller.role || '') + '|' + (caller.isAdmin ? 'admin' : '');

    /* mode: 'week' (last 7 days incl. today) or 'day' (single date). */
    var refMode = React.useState('week');
    var mode    = refMode[0];
    var setMode = refMode[1];

    /* When in 'day' mode, this is the picked date. Initialised to
       today; user clicks the picker chip to enter day mode. */
    var refDay = React.useState(window.FS.api.todayNZDT());
    var day    = refDay[0];
    var setDay = refDay[1];

    var refState = React.useState({ status: 'loading' });
    var state    = refState[0];
    var setState = refState[1];

    /* Compute the from/to range for the current mode + day. */
    var today = window.FS.api.todayNZDT();
    var range;
    if (mode === 'week') {
      range = { from: window.FS.api.addDaysISO(today, -(DEFAULT_DAYS - 1)), to: today };
    } else if (mode === 'today') {
      range = { from: today, to: today };
    } else {
      range = { from: day, to: day };
    }

    React.useEffect(function () {
      var cancelled = false;
      setState({ status: 'loading' });

      window.FS.api.compliance.getSafetyRange({
        from: range.from, to: range.to,
      }).then(function (res) {
        if (cancelled) return;
        if (res && res._accessDenied) {
          setState({ status: 'access_denied', message: res.error });
          return;
        }
        var rows = (res && res.rows) || [];
        setState({
          status:  'ok',
          rows:    rows,
          from:    range.from,
          to:      range.to,
          totals:  totalsFromRows(rows),
          groups:  groupByDate(rows),
          dates:   (res && res.dates) || [],
          user:    res.user || null,
        });
      }).catch(function (err) {
        if (cancelled) return;
        setState({ status: 'error', error: err });
      });

      return function () { cancelled = true; };
    }, [depKey, mode, day]);

    var refSel = React.useState(null);
    var sel    = refSel[0];
    var setSel = refSel[1];

    var ctx = {
      state:        state,
      mode:         mode,
      day:          day,
      setMode:      function (m) { setSel(null); setMode(m); },
      setDay:       function (d) { setSel(null); setDay(d); setMode('day'); },
      selectedFlag: sel,
      setSelected:  setSel,
    };
    return React.createElement(SafetyContext.Provider, { value: ctx },
      props.children);
  }

  /* ---------- Range toolbar -------------------------------------------- */

  function RangeToolbar(props) {
    var DatePicker = window.FieldSight.DatePicker;
    var ctx = props.ctx;
    var refOpen = React.useState(false);
    var open    = refOpen[0];
    var setOpen = refOpen[1];

    function chip(key, label, isActive) {
      return React.createElement('button', {
        key:       key,
        type:      'button',
        className: 'fs-safety__chip' + (isActive ? ' fs-safety__chip--active' : ''),
        onClick:   function () {
          if (key === 'pick') { setOpen(!open); return; }
          ctx.setMode(key);
          setOpen(false);
        },
      }, label);
    }

    return React.createElement('div', { className: 'fs-safety__toolbar' },
      React.createElement('div', { className: 'fs-safety__chips' },
        chip('today',  'Today',         ctx.mode === 'today'),
        chip('week',   'Last 7 days',   ctx.mode === 'week'),
        chip('pick',   ctx.mode === 'day' ? fmtDate(ctx.day) : 'Pick date…',
             ctx.mode === 'day'),
      ),
      open && DatePicker
        ? React.createElement('div', { className: 'fs-safety__picker-wrap' },
            React.createElement(DatePicker, {
              date:        ctx.day,
              onChange:    function (d) {
                ctx.setDay(d);
                setOpen(false);
              },
              monthsRange: 3,
            }))
        : null,
    );
  }

  /* ---------- Middle column -------------------------------------------- */

  function SafetyMiddleColumn(props) {
    var fs            = window.FieldSight;
    var KpiStrip      = fs.KpiStrip;
    var StatCard      = fs.StatCard;
    var SafetyFlagRow = fs.SafetyFlagRow;
    var Badge         = fs.Badge;
    var AccessDenied  = fs.AccessDenied;

    var ctx = React.useContext(SafetyContext);
    if (!ctx) {
      console.warn('[SafetyMiddleColumn] SafetyContext missing');
      return null;
    }
    var state = ctx.state;
    var onSelect = props.onSelect || function () {};

    /* Header is always visible — toolbar should be reachable even
       during loading/empty states. */
    var header = React.createElement('div', { className: 'fs-safety__header' },
      React.createElement('h2', { className: 'fs-safety__title' }, 'Safety'),
      React.createElement('div', { className: 'fs-safety__subtitle' },
        'Flags and observations across your accessible reports'),
    );
    var toolbar = React.createElement(RangeToolbar, { ctx: ctx });

    if (state.status === 'loading') {
      return React.createElement('div', { className: 'fs-safety' },
        header, toolbar,
        React.createElement('div', { className: 'fs-safety__loading' },
          'Loading safety data…'),
      );
    }
    if (state.status === 'error') {
      return React.createElement('div', { className: 'fs-safety' },
        header, toolbar,
        React.createElement('div', { className: 'fs-safety__empty' },
          'Could not load safety data. ' + (state.error && state.error.message || '')),
      );
    }
    if (state.status === 'access_denied') {
      return React.createElement('div', { className: 'fs-safety' },
        header,
        AccessDenied
          ? React.createElement(AccessDenied, {
              scope:   'safety data',
              message: state.message,
            })
          : React.createElement('div', null, 'Access denied.'),
      );
    }

    var totals = state.totals || { total: 0, high: 0, sites: 0, open: 0, closed: 0 };
    var groups = state.groups || [];
    var rangeLabel = state.from === state.to
      ? fmtDate(state.from)
      : fmtDate(state.from) + ' → ' + fmtDate(state.to);

    return React.createElement('div', { className: 'fs-safety' },
      header,
      toolbar,

      /* Meta line */
      React.createElement('div', { className: 'fs-safety__meta' },
        totals.total + (totals.total === 1 ? ' flag · ' : ' flags · ') + rangeLabel),

      /* KPI strip */
      React.createElement(KpiStrip, null,
        React.createElement(StatCard, { value: totals.total, label: 'Total flags' }),
        React.createElement(StatCard, {
          value: totals.high, label: 'High risk',
          tone:  totals.high > 0 ? 'danger' : 'neutral',
        }),
        React.createElement(StatCard, { value: totals.sites, label: 'Sites affected' }),
        React.createElement(StatCard, {
          value: totals.open + ' / ' + totals.closed,
          label: 'Open / closed',
          tone:  totals.open > 0 ? 'warning' : 'success',
        }),
      ),

      /* Grouped list */
      groups.length === 0
        ? React.createElement('div', { className: 'fs-safety__empty' },
            'No safety flags in this window.')
        : React.createElement('div', { className: 'fs-safety__groups' },
            groups.map(function (g) {
              return React.createElement('div', { key: g.date, className: 'fs-safety__group' },
                React.createElement('div', { className: 'fs-safety__group-header' },
                  React.createElement('span', { className: 'fs-safety__group-date' },
                    fmtDateLong(g.date)),
                  React.createElement('span', { className: 'fs-safety__group-count' },
                    g.rows.length + (g.rows.length === 1 ? ' flag' : ' flags')),
                ),
                React.createElement('div', { className: 'fs-safety__group-rows' },
                  g.rows.map(function (row) {
                    var isSel = ctx.selectedFlag && ctx.selectedFlag.id === row.id;
                    return React.createElement('button', {
                      key:       row.id,
                      type:      'button',
                      className: 'fs-safety__row-btn'
                        + (isSel ? ' fs-safety__row-btn--active' : ''),
                      onClick:   function () {
                        ctx.setSelected(row);
                        onSelect({ kind: 'safety_flag', id: row.id, row: row });
                      },
                    },
                      React.createElement(SafetyFlagRow, {
                        flag: {
                          observation:        row.observation,
                          risk_level:         row.risk_level,
                          recommended_action: row.recommended_action,
                          location:           row.location,
                          who_raised:         row.who_raised,
                        },
                        dense: true,
                      }),
                      React.createElement('div', { className: 'fs-safety__row-meta' },
                        row.topic_title !== 'Site safety observations'
                          ? React.createElement('span', { className: 'fs-safety__row-topic' },
                              'From: ' + row.topic_title)
                          : null,
                      ),
                    );
                  }),
                ),
              );
            }),
          ),
    );
  }

  /* ---------- Right detail (placeholder for 6.1, beefed up in 6.2) ----- */

  function SafetyRightDetail(props) {
    var ctx = React.useContext(SafetyContext);
    var sel = ctx && ctx.selectedFlag;

    if (!sel) {
      return React.createElement('div', { className: 'fs-safety-detail__placeholder' },
        React.createElement('div', { className: 'fs-safety-detail__placeholder-title' },
          'Select a flag'),
        React.createElement('div', { className: 'fs-safety-detail__placeholder-body' },
          'Pick any flag in the list to see its full detail and source report.'),
      );
    }

    /* Sprint 6.1 minimal detail — Sprint 6.2 replaces with full
       inspection panel (status badge, source-report link, linked
       actions). */
    return React.createElement('div', { className: 'fs-safety-detail' },
      React.createElement('h2', { className: 'fs-safety-detail__title' },
        sel.observation),
      React.createElement('div', { className: 'fs-safety-detail__body' },
        'Detail panel — built out in Sprint 6.2.'),
    );
  }

  /* ---------- Register --------------------------------------------------- */

  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.PAGES) window.FieldSight.PAGES = {};
  window.FieldSight.PAGES['/safety'] = {
    Middle:   SafetyMiddleColumn,
    Right:    SafetyRightDetail,
    Provider: SafetyProvider,
  };

})();
