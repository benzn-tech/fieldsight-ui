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

  /* The photographs, fetched one presigned URL at a time.

     The backend now sends `{name, key}`; before it did, `related_photos` held
     bare filenames and nothing downstream could find the image, which is why
     "why are the photos not in the report" had no better answer than a list of
     names. A photo with no key still renders as its name -- honest, and better
     than a broken image.

     Failures are per photo, not per section: one object the caller cannot
     presign must not take the other eleven down with it. */
  function PhotoGrid(props) {
    var items = props.items;
    var state = React.useState({});
    var urls = state[0], setUrls = state[1];

    React.useEffect(function () {
      var media = window.FS && window.FS.api && window.FS.api.media;
      if (!media || !media.getUrl) return;
      var live = true;
      items.forEach(function (ph) {
        if (!ph.key) return;
        Promise.resolve(media.getUrl(ph.key)).then(function (url) {
          if (live && url) {
            setUrls(function (prev) {
              if (prev[ph.key]) return prev;
              var next = {};
              Object.keys(prev).forEach(function (k) { next[k] = prev[k]; });
              next[ph.key] = url;
              return next;
            });
          }
        }, function () { /* this photo stays a name */ });
      });
      return function () { live = false; };
    }, [items]);

    return h('div', 'fs-report-view__photos', items.map(function (ph, i) {
      var url = ph.key ? urls[ph.key] : null;
      return React.createElement('figure',
        { key: i, className: 'fs-report-view__photo' },
        url ? React.createElement('img', {
          src: url, alt: ph.name, loading: 'lazy',
          className: 'fs-report-view__photo-img',
        }) : null,
        React.createElement('figcaption',
          { className: 'fs-report-view__photo-cap' }, ph.name));
    }));
  }

  /* Weather impact runs yellow to red; everything else keeps the neutral chip.
     The severity words are the backend's (`report_sections._WEATHER_SCALE`),
     and a word this does not know stays neutral rather than guessing a colour
     -- a wrong colour on a safety line is worse than no colour. */
  var CHIP_TONE = {
    low: 'fs-report-view__chip--low',
    /* An action's priority and a safety risk use `medium` where the weather
       scale says `moderate`; they mean the same thing to a reader and must not
       be the only chip on the page with no colour. */
    medium: 'fs-report-view__chip--moderate',
    moderate: 'fs-report-view__chip--moderate',
    high: 'fs-report-view__chip--high',
    severe: 'fs-report-view__chip--severe',
  };

  function chipTone(status) {
    return CHIP_TONE[String(status || '').toLowerCase()] || '';
  }

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

    } else if (props.kind === 'entries') {
      /* A thing, the state it is in, and one line about it. This replaced a
         four-column table for Quality and for Safety: columns of prose read as
         a spreadsheet of paragraphs, and they do not line up anyway, because
         `note` is a sentence and `status` is a word. */
      if (!Array.isArray(body)) return null;
      inner = h('ul', 'fs-report-view__entries', body.map(function (e, i) {
        return React.createElement('li',
          { key: i, className: 'fs-report-view__entry' },
          React.createElement('div', { className: 'fs-report-view__entry-head' },
            h('span', 'fs-report-view__entry-title', e.title),
            e.status
              ? h('span', 'fs-report-view__chip ' + chipTone(e.status),
                  e.status.replace(/_/g, ' '))
              : null),
          e.note ? h('div', 'fs-report-view__entry-note', e.note) : null);
      }));

    } else if (props.kind === 'photos') {
      if (!Array.isArray(body)) return null;
      inner = React.createElement(PhotoGrid, { items: body });

    } else {
      /* list. Photos used to arrive as bare filenames -- this modal has no
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
      /* The generator sends a Weather SECTION now. Rendering the old block
         beside it puts the same sentence on screen twice -- and the block
         cannot show the impact level, which is the half worth reading. */
      var generated = vm.sections(report) || [];
      var hasWeatherSection = generated.some(function (s) {
        return s.title === 'Weather';
      });
      var weather = hasWeatherSection ? null : vm.weatherLine(report.weather);
      var note    = hasWeatherSection ? null : vm.weatherNote(report);
      var subtitle = vm.reportSubtitle ? vm.reportSubtitle(report) : '';
      body = React.createElement('div', { className: 'fs-report-view' },

        /* The modal's own title bar carries the NAME of the report; which site
           and which day sit here, smaller, because they are what changes. */
        subtitle
          ? h('div', 'fs-report-view__subtitle', subtitle)
          : null,

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
        hasWeatherSection ? null : React.createElement(
          'div', { className: 'fs-report-view__section' },
          React.createElement('h3', { className: 'fs-report-view__h' }, 'Weather'),
          weather
            ? React.createElement('p', { className: 'fs-report-view__para' }, weather)
            : React.createElement('p', { className: 'fs-report-view__para fs-report-view__para--muted' }, note)),

        generated.map(function (s) {
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
      title:   report
        ? (vm.reportHeading ? vm.reportHeading(report) : vm.reportTitle(report))
        : 'Report',
      onClose: props.onClose,
    }, body);
  }

  if (!window.FieldSight) window.FieldSight = {};
  window.FieldSight.ReportViewerModal = ReportViewerModal;

})();
