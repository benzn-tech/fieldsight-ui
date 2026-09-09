/* ==========================================================================
   FieldSight · Report view model
   --------------------------------------------------------------------------
   Turns a report JSON into an ordered list of plain sections a viewer can
   render without knowing anything about report types.

   WHY A VIEW MODEL AND NOT A TEMPLATE PER TYPE. Daily, weekly and monthly
   reports do not share a schema. A daily carries `quality_and_compliance`,
   `safety_observations`, `critical_dates_and_deadlines` and `topics`; a weekly
   carries `safety_trends`, `progress_highlights`, `outstanding_actions`,
   `quality_summary` and `next_week_priorities`. A viewer written against the
   daily shape shows a weekly report as a title and nothing else — silently,
   because every lookup just misses.

   So the known sections are declared, in the order the Word document uses, and
   anything present is rendered. Anything ABSENT is skipped rather than
   rendered empty: an empty "Safety Observations" heading is a claim that
   nothing was observed, which is not the same as the model not having emitted
   the field.

   Exported to:
     window.FS.api.reportView   (browser)
     module.exports             (node:test)
   ========================================================================== */

(function () {
  'use strict';

  /* Not content: identity, provenance and the raw session numbers, all of
     which the viewer renders as a header rather than as a section. */
  var META_KEYS = {
    report_date: 1, report_type: 1, user_name: 1, device: 1, site: 1,
    site_id: 1, role: 1, period: 1, recording_session: 1, weather: 1,
    _report_metadata: 1,
  };

  /* Section order follows the Word document (lambda_report_generator.py
     :912-1039) so the two renderings of one report do not disagree about what
     comes first. Anything the generator adds later still appears — at the end,
     under a title derived from its key — rather than being dropped. */
  var KNOWN_ORDER = [
    ['executive_summary',           'Executive Summary'],
    ['progress_highlights',         'Progress Highlights'],
    ['quality_and_compliance',      'Quality & Compliance'],
    ['quality_summary',             'Quality Summary'],
    ['safety_observations',         'Safety Observations'],
    ['safety_trends',               'Safety Trends'],
    ['outstanding_actions',         'Outstanding Actions'],
    ['critical_dates_and_deadlines','Critical Dates & Deadlines'],
    ['next_week_priorities',        'Next Week Priorities'],
    ['topics',                      'Detailed Timeline'],
  ];

  function titleCase(key) {
    return String(key || '').replace(/_/g, ' ')
      .replace(/^./, function (c) { return c.toUpperCase(); });
  }

  function isEmpty(v) {
    if (v == null) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'string') return v.trim() === '';
    if (typeof v === 'object') return Object.keys(v).length === 0;
    return false;
  }

  /* ---------- the title line -------------------------------------------- */

  var TYPE_WORD = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

  function reportTitle(report) {
    if (!report) return 'Report';
    var type = TYPE_WORD[report.report_type] || titleCase(report.report_type || 'Site');
    var site = report.site || '';
    var when = report.report_date || '';
    /* A weekly report's `report_date` is the period end; showing the range is
       what makes it readable as a week rather than as a very quiet day. */
    var p = report.period;
    if (p && p.start && p.end) when = p.start + ' → ' + p.end;
    return type + ' Site Report' + (site ? ': ' + site : '') + (when ? ' — ' + when : '');
  }

  /* ---------- the header facts ------------------------------------------ */

  function headerFacts(report) {
    var out = [];
    if (!report) return out;
    var s = report.recording_session || {};
    function push(label, value) {
      if (value !== undefined && value !== null && value !== '' && value !== 0) {
        out.push({ label: label, value: String(value) });
      }
    }
    push('Site', report.site);
    push('Worker', s.worker || report.user_name);
    push('Role', s.role ? String(s.role).replace(/_/g, ' ') : null);
    if (s.workers && s.workers.length) push('Workers', s.workers.join(', '));
    push('Recordings', s.recordings);
    push('Total audio', s.total_duration_display);
    if (s.total_words) push('Words transcribed', Number(s.total_words).toLocaleString('en-NZ'));
    push('Photos', s.photos);
    return out;
  }

  /* ---------- weather ---------------------------------------------------- */

  /* One sentence, from the block the report generator already stores. The
     numbers are rendered exactly as recorded — this is a measurement, and
     rounding it in the viewer would make two renderings of one report
     disagree. */
  function weatherLine(w) {
    if (!w) return null;
    var bits = [];
    if (w.condition_label) bits.push(w.condition_label);
    if (w.temp_min_c != null && w.temp_max_c != null) {
      bits.push(w.temp_min_c + '–' + w.temp_max_c + '°C');
    }
    if (w.precip_mm != null) bits.push(w.precip_mm + ' mm rain');
    if (w.windspeed_kmh != null) bits.push('wind to ' + w.windspeed_kmh + ' km/h');
    return bits.length ? bits.join(' · ') : null;
  }

  /* ABSENT IS A FACT WITH A CAUSE, and the viewer should say which. Every
     production report currently has `weather: null`, and not because the
     weather could not be fetched: the generator reads the site coordinate from
     config/user_mapping.json, where all five sites have null lat/lng, while
     the coordinates entered in the web UI live in the Aurora `sites` table.
     Two sources, one of them empty. Saying "not recorded" is honest; saying
     nothing at all leaves a reader to conclude the weather was unremarkable. */
  function weatherNote(report) {
    if (!report) return null;
    if (report.weather) return null;
    return 'Not recorded for this report — the site had no coordinate when it was generated.';
  }

  /* ---------- sections --------------------------------------------------- */

  function sections(report) {
    if (!report || typeof report !== 'object') return [];
    var out = [];
    var seen = {};

    KNOWN_ORDER.forEach(function (pair) {
      var key = pair[0], title = pair[1];
      seen[key] = 1;
      var v = report[key];
      if (isEmpty(v)) return;
      out.push({ key: key, title: title, value: v });
    });

    /* Whatever the generator adds next. Rendering it under a derived title
       beats dropping it: a field nobody wired into the viewer is invisible in
       exactly the way `weather` was. */
    Object.keys(report).forEach(function (key) {
      if (seen[key] || META_KEYS[key]) return;
      if (key.charAt(0) === '_') return;
      var v = report[key];
      if (isEmpty(v)) return;
      out.push({ key: key, title: titleCase(key), value: v });
    });

    return out;
  }

  /* ---------- one entry to plain lines ----------------------------------- */

  /* Sections hold strings, or objects whose shape differs per section. Rather
     than a renderer per shape, an entry becomes a headline plus labelled
     detail lines — which is what "not fancy" asks for and what survives the
     generator adding a field. */
  var HEADLINE_KEYS = ['observation', 'item', 'action', 'context', 'title',
                       'topic_title', 'summary', 'text'];
  var SKIP_KEYS = { related_photos: 1, topic_id: 1 };

  function entryLines(entry) {
    if (entry == null) return { headline: '', details: [] };
    if (typeof entry !== 'object') return { headline: String(entry), details: [] };

    var headline = '';
    var usedKey = null;
    for (var i = 0; i < HEADLINE_KEYS.length; i++) {
      var k = HEADLINE_KEYS[i];
      if (entry[k] && typeof entry[k] === 'string') { headline = entry[k]; usedKey = k; break; }
    }

    var details = [];
    Object.keys(entry).forEach(function (k) {
      if (k === usedKey || SKIP_KEYS[k]) return;
      var v = entry[k];
      if (isEmpty(v) && v !== false) return;
      if (Array.isArray(v)) {
        var flat = v.map(function (x) {
          return (x && typeof x === 'object') ? entryLines(x).headline : String(x);
        }).filter(Boolean);
        if (flat.length) details.push({ label: titleCase(k), value: flat.join('; ') });
        return;
      }
      if (typeof v === 'object') return;          /* nested objects stay out */
      details.push({ label: titleCase(k), value: String(v) });
    });

    if (!headline && details.length) {
      /* No recognised headline key: promote the first detail so the entry is
         never rendered as a bullet with nothing on it. */
      headline = details[0].label + ': ' + details[0].value;
      details = details.slice(1);
    }
    return { headline: headline, details: details };
  }

  var api = {
    reportTitle:  reportTitle,
    headerFacts:  headerFacts,
    weatherLine:  weatherLine,
    weatherNote:  weatherNote,
    sections:     sections,
    entryLines:   entryLines,
  };

  if (typeof window !== 'undefined') {
    if (!window.FS) window.FS = {};
    if (!window.FS.api) window.FS.api = {};
    window.FS.api.reportView = api;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})();
