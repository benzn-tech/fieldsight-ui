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
        React.createElement('div', { className: 'fs-report-view__facts' },
          vm.headerFacts(report).map(function (f, i) {
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
          return React.createElement(Section, { key: s.key, title: s.title, value: s.value });
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
