/* ==========================================================================
   FieldSight ReportViewerModal — Layer 5 composite
   --------------------------------------------------------------------------
   Reads a generated report in the browser. Deliberately plain: headings,
   bullets and label/value lines, in the order the Word document uses.

   Why it exists: the only way to read a report was to download it. The
   download button hands over a .docx, which needs Word, and before that it
   was handing over raw JSON. Neither is a way to glance at yesterday.

   The content is fetched with the same presigned URL the download uses. That
   works from the browser because the data bucket carries a CORS rule allowing
   GET from the Amplify origins (an out-of-band configuration — see the
   pipeline's CLAUDE.md; it is not in any template and must not be "cleaned
   up").

   Exported to: window.FieldSight.ReportViewerModal
   ========================================================================== */

/* global React, window */

(function () {
  'use strict';

  function view() {
    return (window.FS && window.FS.api && window.FS.api.reportView) || null;
  }

  function h(tag, cls, children) {
    return React.createElement(tag, cls ? { className: cls } : null, children);
  }

  /* ---------- the shape the generator sends -------------------------------

     `report_sections.py` emits the same section vocabulary the template
     Library uses, so each kind gets the rendering it was designed for instead
     of the one-size fallback below. That fallback turned a quality entry into

         Waterproofing detail 216 — heavy dwang solution
         Status              in_progress
         Details             Stick with heavy dwang, on top of it
         Follow up needed    true

     -- database columns, verbatim, in a customer's report. As a table with
     declared columns the same row reads as a row, and `follow_up_needed` is
     not in `fields` at all, so it never reaches a reader. */

  function GeneratedSection(props) {
    var body = props.body;
    var inner;

    if (props.kind === 'narrative') {
      if (typeof body !== 'string') return null;
      inner = h('p', 'fs-report-view__para', body);

    } else if (props.kind === 'kpi') {
      if (!Array.isArray(body)) return null;
      inner = h('div', 'fs-report-view__facts fs-report-view__facts--inline',
        body.map(function (kv, i) {
          return React.createElement('div',
            { key: i, className: 'fs-report-view__kv' },
            h('span', 'fs-report-view__k', kv.label),
            h('span', 'fs-report-view__v', kv.value));
        }));

    } else if (props.kind === 'table') {
      if (!body || !Array.isArray(body.columns) || !Array.isArray(body.rows)) return null;
      /* The wrapper scrolls, not the modal: an Actions table is five columns
         wide and a phone is not. */
      inner = h('div', 'fs-report-view__tablewrap',
        React.createElement('table', { className: 'fs-report-view__table' },
          React.createElement('thead', null,
            React.createElement('tr', null, body.columns.map(function (c) {
              return React.createElement('th', { key: c.key }, c.label);
            }))),
          React.createElement('tbody', null, body.rows.map(function (row, i) {
            return React.createElement('tr', { key: i }, row.map(function (cell, j) {
              return React.createElement('td', { key: j }, cell);
            }));
          }))));

    } else {
      /* list and photos. Photos arrive as bare filenames -- this modal has no
         presigner, and a grid of broken images would be worse than a count,
         so the names are listed and the thumbnails wait for the day the
         viewer can fetch them.

         The guard is not defensive noise. Two section shapes reach this file
         and they are told apart by one string: lose `kind: 'raw'` on the
         derived path and a weekly report arrives here with `body` undefined,
         `body.map` throws inside render, and React blanks the WHOLE modal --
         a crash, not a missing section. */
      if (!Array.isArray(body)) return null;
      inner = h('ul', 'fs-report-view__list',
        body.map(function (item, i) {
          return React.createElement('li',
            { key: i, className: 'fs-report-view__item' },
            h('div', 'fs-report-view__item-head', item));
        }));
    }

    return React.createElement('div', { className: 'fs-report-view__section' },
      h('h3', 'fs-report-view__h', props.title),
      inner);
  }

  function Section(props) {
    var vm = view();
    var value = props.value;

    /* A plain string section (quality_summary) is a paragraph, not a
       one-item list pretending to be bullets. */
    if (typeof value === 'string') {
      return React.createElement('div', { className: 'fs-report-view__section' },
        React.createElement('h3', { className: 'fs-report-view__h' }, props.title),
        React.createElement('p', { className: 'fs-report-view__para' }, value));
    }

    var items = Array.isArray(value) ? value : [value];
    return React.createElement('div', { className: 'fs-report-view__section' },
      React.createElement('h3', { className: 'fs-report-view__h' }, props.title),
      React.createElement('ul', { className: 'fs-report-view__list' },
        items.map(function (entry, i) {
          var line = vm.entryLines(entry);
          return React.createElement('li', { key: i, className: 'fs-report-view__item' },
            React.createElement('div', { className: 'fs-report-view__item-head' }, line.headline),
            line.details.length
              ? React.createElement('div', { className: 'fs-report-view__item-meta' },
                  line.details.map(function (d, j) {
                    return React.createElement('div', { key: j, className: 'fs-report-view__kv' },
                      React.createElement('span', { className: 'fs-report-view__k' }, d.label),
                      React.createElement('span', { className: 'fs-report-view__v' }, d.value));
                  }))
              : null);
        })));
  }

  var SESSION_NUMBERS = { Recordings: 1, 'Total audio': 1, Photos: 1 };

  function headerFactsFor(vm, report) {
    var facts = vm.headerFacts(report);
    var hasKpi = (vm.sections(report) || []).some(function (s) {
      return s.kind === 'kpi';
    });
    if (!hasKpi) return facts;
    return facts.filter(function (f) { return !SESSION_NUMBERS[f.label]; });
  }

  function ReportViewerModal(props) {
    var Modal = window.FieldSight && window.FieldSight.ModalOverlay;
    var vm = view();
    if (!Modal || !vm || !props.open) return null;

    var report = props.report || null;
    var status = props.status || (report ? 'ok' : 'loading');

    var body;
    if (status === 'loading') {
      body = React.createElement('div', { className: 'fs-report-view__state' }, 'Loading report…');
    } else if (status === 'error') {
      body = React.createElement('div', { className: 'fs-report-view__state' },
        props.error || 'Could not load this report.');
    } else {
      var weather = vm.weatherLine(report.weather);
      var note    = vm.weatherNote(report);
      body = React.createElement('div', { className: 'fs-report-view' },
        /* Identity only when the report carries an "On Site" KPI section:
           without this the same three numbers are on screen twice, once from
           `recording_session` here and once from the section built out of it,
           and they disagree about zero (the header hides `Photos 0`, the
           section shows it). */
        React.createElement('div', { className: 'fs-report-view__facts' },
          headerFactsFor(vm, report).map(function (f, i) {
            return React.createElement('div', { key: i, className: 'fs-report-view__kv' },
              React.createElement('span', { className: 'fs-report-view__k' }, f.label),
              React.createElement('span', { className: 'fs-report-view__v' }, f.value));
          })),

        /* Weather sits above the narrative, as it does in the report the
           customer asked for — and when it is missing it says so rather than
           quietly not being there. */
        React.createElement('div', { className: 'fs-report-view__section' },
          React.createElement('h3', { className: 'fs-report-view__h' }, 'Weather'),
          weather
            ? React.createElement('p', { className: 'fs-report-view__para' }, weather)
            : React.createElement('p', { className: 'fs-report-view__para fs-report-view__para--muted' }, note)),

        vm.sections(report).map(function (s) {
          return s.kind === 'raw'
            ? React.createElement(Section,
                { key: s.key, title: s.title, value: s.value })
            : React.createElement(GeneratedSection,
                { key: s.key, title: s.title, kind: s.kind, body: s.body });
        }));
    }

    return React.createElement(Modal, {
      open:    true,
      size:    'lg',
      title:   report ? vm.reportTitle(report) : 'Report',
      onClose: props.onClose,
    }, body);
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.ReportViewerModal = ReportViewerModal;

})();
