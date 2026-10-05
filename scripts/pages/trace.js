/* ==========================================================================
   FieldSight /trace -- what the pipeline did with every customer's recordings
   --------------------------------------------------------------------------
   Owner, 2026-10-05: like an agent's tool-call list -- which steps ran on a
   recording, how many model calls they made, whether a template or keyword
   fired, and what was looked for and NOT found. platform_admin only (the
   nav item and the endpoints both check the role).

   Two tabs, both straight from the pipeline (GET /trace/funnel, /trace/day;
   trace_views computes every number -- the page counts nothing itself):

     Funnel  per folder over a range (last 7 days by default): how far the
             recordings got, and what the model calls cost.
     Day     one day: the folders with activity; pick one to see each
             recording's steps in time order.

   Registers as window.FieldSight.PAGES['/trace']
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  function h() { return React.createElement.apply(React, arguments); }

  function isoDay(d) {
    return d.toISOString().slice(0, 10);
  }

  function daysBefore(iso, n) {
    var d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - n);
    return isoDay(d);
  }

  /* Event times are UTC; people read New Zealand time. */
  function nzTime(at) {
    if (!at) return '';
    try {
      return new Date(at).toLocaleTimeString('en-NZ',
        { timeZone: 'Pacific/Auckland', hour12: false });
    } catch (e) { return at; }
  }

  /* An event's detail as one readable line: "topics 4 · pass final". */
  function detailLine(detail) {
    if (!detail || typeof detail !== 'object') return '';
    return Object.keys(detail).filter(function (k) {
      var v = detail[k];
      return v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length);
    }).map(function (k) {
      var v = detail[k];
      if (v && typeof v === 'object') {
        v = Array.isArray(v) ? v.join(', ') : (v.title || JSON.stringify(v));
      }
      return k.replace(/_/g, ' ') + ' ' + v;
    }).join(' · ');
  }

  function num(n) {
    return (n === null || n === undefined) ? '–' : Number(n).toLocaleString('en-NZ');
  }

  /* Funnel columns: [label, render(total)] -- the order a recording travels. */
  var FUNNEL_COLUMNS = [
    ['Recordings', function (t) { return num(t.recordings_extracted); }],
    ['With topics', function (t) { return num(t.recordings_with_topics); }],
    ['Places (timed)', function (t) { return num(t.location_markers) + ' (' + num(t.markers_timed) + ')'; }],
    ['Photos', function (t) { return num(t.photos); }],
    ['By place', function (t) { return num(t.photos_by_location); }],
    ['Unplaced', function (t) { return num(t.photos_unbound); }],
    ['Reports', function (t) {
      return num(t.template_reports) + (t.template_report_errors ? ' (' + t.template_report_errors + ' failed)' : '');
    }],
    ['Checklists answered', function (t) { return num(t.checklists_answered) + ' / ' + num(t.checklists); }],
    ['Glossary used / learned', function (t) { return num(t.glossary_applied) + ' / ' + num(t.glossary_learned); }],
    ['Model calls', function (t) { return num(t.llm_calls); }],
    ['Tokens in / out', function (t) { return num(t.prompt_tokens) + ' / ' + num(t.completion_tokens); }],
    ['Model time', function (t) { return t.llm_seconds ? Math.round(t.llm_seconds) + ' s' : '–'; }],
  ];

  function useLoad(fn, deps) {
    var st = React.useState({ status: 'loading' });
    React.useEffect(function () {
      var alive = true;
      st[1]({ status: 'loading' });
      Promise.resolve().then(fn).then(function (data) {
        if (alive) st[1]({ status: 'ok', data: data });
      }).catch(function (err) {
        if (alive) st[1]({ status: 'error', message: (err && err.message) || 'Could not load', code: err && err.status });
      });
      return function () { alive = false; };
    }, deps);
    return st[0];
  }

  function Status(props) {
    var s = props.state;
    if (s.status === 'loading') return h('p', { className: 'fs-trace__muted' }, 'Loading…');
    if (s.status === 'error') {
      return h('p', { className: 'fs-trace__error' },
        s.code === 403 ? 'Only the platform admin can read traces.' : s.message);
    }
    return null;
  }

  function Funnel(props) {
    var api = window.FS.api.org;
    var state = useLoad(function () {
      return api.getTraceFunnel({ from: props.from, to: props.to });
    }, [props.from, props.to]);
    if (state.status !== 'ok') return h(Status, { state: state });
    var rows = (state.data && state.data.folders) || [];
    if (!rows.length) {
      return h('p', { className: 'fs-trace__muted' }, 'No traced activity in this range.');
    }
    return h('div', { className: 'fs-trace__table-wrap' },
      h('table', { className: 'fs-trace__table' },
        h('thead', null, h('tr', null,
          h('th', null, 'Company'), h('th', null, 'Person'),
          FUNNEL_COLUMNS.map(function (c) { return h('th', { key: c[0] }, c[0]); }))),
        h('tbody', null, rows.map(function (r) {
          return h('tr', { key: r.folder },
            h('td', null, r.company_name || '–'),
            h('td', null, h('button', {
              type: 'button', className: 'fs-trace__link',
              onClick: function () { props.onOpenFolder(r.folder); },
            }, r.folder)),
            FUNNEL_COLUMNS.map(function (c) { return h('td', { key: c[0] }, c[1](r.total || {})); }));
        }))));
  }

  function EventRow(props) {
    var e = props.event;
    var cost = e.model ? [e.model.split('/').pop(), e.prompt_tokens ? num(e.prompt_tokens) + ' in' : null,
      e.completion_tokens ? num(e.completion_tokens) + ' out' : null,
      e.seconds ? e.seconds + ' s' : null].filter(Boolean).join(' · ') : (e.seconds ? e.seconds + ' s' : '');
    return h('li', { className: 'fs-trace__event fs-trace__event--' + String(e.result || '').replace(/[^a-z_]/g, '') },
      h('span', { className: 'fs-trace__time' }, nzTime(e.at)),
      h('span', { className: 'fs-trace__step' }, e.step),
      h('span', { className: 'fs-trace__result' }, e.result),
      h('span', { className: 'fs-trace__detail' },
        detailLine(e.detail),
        e.evidence ? h('q', { className: 'fs-trace__evidence' }, e.evidence) : null,
        cost ? h('span', { className: 'fs-trace__cost' }, cost) : null));
  }

  function Day(props) {
    var api = window.FS.api.org;
    var state = useLoad(function () {
      return api.getTraceDay({ date: props.date, folder: props.folder });
    }, [props.date, props.folder]);
    if (state.status !== 'ok') return h(Status, { state: state });
    var d = state.data || {};
    if (!props.folder) {
      var folders = d.folders || [];
      if (!folders.length) return h('p', { className: 'fs-trace__muted' }, 'Nothing was traced on this day.');
      return h('ul', { className: 'fs-trace__folders' }, folders.map(function (f) {
        return h('li', { key: f.folder },
          h('button', { type: 'button', className: 'fs-trace__link',
            onClick: function () { props.onOpenFolder(f.folder); } }, f.folder),
          h('span', { className: 'fs-trace__muted' },
            (f.company_name ? f.company_name + ' · ' : '') + num(f.recordings) + ' recordings · ' +
            num(f.events) + ' steps · ' + num(f.llm_calls) + ' model calls · ' +
            num(f.prompt_tokens) + ' tokens in'));
      }));
    }
    var recs = d.recordings || [];
    return h('div', null,
      h('button', { type: 'button', className: 'fs-trace__link',
        onClick: function () { props.onOpenFolder(null); } }, '← All people'),
      recs.length ? null : h('p', { className: 'fs-trace__muted' }, 'Nothing traced for ' + props.folder + ' on this day.'),
      recs.map(function (r) {
        return h('section', { key: r.trace_id, className: 'fs-trace__recording' },
          h('h3', { className: 'fs-trace__recording-title' },
            (r.session || 'No recording') + ' — ' + nzTime(r.first) + ' to ' + nzTime(r.last) +
            ' · ' + num(r.llm_calls) + ' model calls'),
          h('ol', { className: 'fs-trace__events' },
            (r.events || []).map(function (e, i) { return h(EventRow, { key: i, event: e }); })));
      }));
  }

  function TraceMiddle() {
    var today = (window.FS.api.todayNZDT && window.FS.api.todayNZDT()) || isoDay(new Date());
    var tabRef = React.useState('funnel');
    var tab = tabRef[0]; var setTab = tabRef[1];
    var fromRef = React.useState(daysBefore(today, 6));
    var toRef = React.useState(today);
    var dateRef = React.useState(today);
    var folderRef = React.useState(null);

    function openFolder(folder) {
      /* From the funnel: the range's last day, where the latest activity is. */
      if (tab === 'funnel' && folder) dateRef[1](toRef[0]);
      folderRef[1](folder);
      setTab('day');
    }

    var controls = tab === 'funnel'
      ? h('div', { className: 'fs-trace__controls' },
          h('label', null, 'From ', h('input', { type: 'date', value: fromRef[0],
            onChange: function (e) { fromRef[1](e.target.value); } })),
          h('label', null, 'To ', h('input', { type: 'date', value: toRef[0],
            onChange: function (e) { toRef[1](e.target.value); } })))
      : h('div', { className: 'fs-trace__controls' },
          h('label', null, 'Day ', h('input', { type: 'date', value: dateRef[0],
            onChange: function (e) { dateRef[1](e.target.value); } })));

    return h('div', { className: 'fs-page fs-trace' },
      h('div', { className: 'fs-trace__header' },
        h('h1', { className: 'fs-trace__title' }, 'Trace'),
        h('div', { className: 'fs-trace__tabs', role: 'tablist' },
          ['funnel', 'day'].map(function (k) {
            return h('button', { key: k, type: 'button', role: 'tab', 'aria-selected': tab === k,
              className: 'fs-trace__tab' + (tab === k ? ' fs-trace__tab--on' : ''),
              onClick: function () { setTab(k); } }, k === 'funnel' ? 'Funnel' : 'Day');
          }))),
      controls,
      tab === 'funnel'
        ? h(Funnel, { from: fromRef[0], to: toRef[0], onOpenFolder: openFolder })
        : h(Day, { date: dateRef[0], folder: folderRef[0], onOpenFolder: openFolder }));
  }

  if (!window.FieldSight) window.FieldSight = {};
  if (!window.FieldSight.PAGES) window.FieldSight.PAGES = {};
  window.FieldSight.PAGES['/trace'] = {
    Middle: TraceMiddle,
    layout: 'full-width',
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { detailLine: detailLine, nzTime: nzTime, daysBefore: daysBefore,
                       FUNNEL_COLUMNS: FUNNEL_COLUMNS };
  }
})();
