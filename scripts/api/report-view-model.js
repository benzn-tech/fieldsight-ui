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
    /* `sections` is the reader's whole shape, not a field inside the report,
       and `meeting_title` is identity. Without them here the fallback below
       renders the entire section list AGAIN as one section titled "Sections",
       under a title derived from the key -- which is what production did the
       day the generator started emitting it. Kept even though `sections` is
       normally consumed above, because the fallback is what runs when it
       arrives malformed, and that is exactly when a junk section is least
       welcome. */
    sections: 1, meeting_title: 1,
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

  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
                  'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];

  /* UTC arithmetic, never `new Date('2026-09-03')` read as local: in NZ that
     parses as UTC midnight and prints as the 3rd or the 4th depending on the
     season, which is BUG-19 and has bitten the calendar already. */
  function longDay(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return '';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (isNaN(d.getTime())) return '';
    return WEEKDAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' '
      + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  /* THE NAME OF THE THING. Everything that varies -- which site, which day --
     moved to the line underneath, because a heading that reads "Daily Site
     Report: UC PK — 2026-09-03" makes the reader parse a sentence to learn
     they are looking at a daily report. */
  function reportHeading(report) {
    if (!report) return 'Report';
    var type = TYPE_WORD[(report || {}).report_type]
      || titleCase((report || {}).report_type || 'Site');
    return type + ' Site Report';
  }

  /* The site and the day, in words. A weekday is how somebody remembers a day
     on site; 2026-09-03 is how a database does. */
  function reportSubtitle(report) {
    if (!report) return '';
    var bits = [];
    var site = report.site || report.meeting_title || '';
    if (site) bits.push(site);
    var p = report.period;
    if (p && p.start && p.end) {
      bits.push(longDay(p.start) + ' → ' + longDay(p.end));
    } else {
      var day = longDay(report.report_date);
      if (day) bits.push(day);
    }
    return bits.join(' \u00b7 ');
  }

  function reportTitle(report) {
    if (!report) return 'Report';
    var type = TYPE_WORD[report.report_type] || titleCase(report.report_type || 'Site');
    /* A meeting's compat report deliberately leaves `site` empty -- a meeting
       is not a site walk -- and carries `meeting_title` instead. That key is
       in META_KEYS so it is never rendered as content, which left the name of
       the meeting appearing NOWHERE: the modal said "Daily Site Report —
       2026-09-03" for a meeting called "Subcontractor coordination". */
    var site = report.site || report.meeting_title || '';
    var when = report.report_date || '';
    /* A weekly report's `report_date` is the period end; showing the range is
       what makes it readable as a week rather than as a very quiet day. */
    var p = report.period;
    if (p && p.start && p.end) when = p.start + ' → ' + p.end;
    return type + ' Site Report' + (site ? ': ' + site : '') + (when ? ' — ' + when : '');
  }

  /* ---------- the header facts ------------------------------------------ */

  /* FOUR FACTS. It used to carry the session's counts as well -- recordings,
     total audio, words transcribed, photos -- and the report's owner asked for
     them to go: "多少分钟。多少个字啊？多少，这些都不要了". They describe the
     recording, not the day, and a reader who wants to know how the day went is
     not helped by learning it took 1,267 files.

     `Time` replaces the durations with the one temporal fact that is about the
     day: when the first recording started and the last one ended. */
  function headerFacts(report) {
    var out = [];
    if (!report) return out;
    var s = report.recording_session || {};
    function push(label, value) {
      if (value !== undefined && value !== null && value !== '' && value !== 0) {
        out.push({ label: label, value: String(value) });
      }
    }
    push('Site', report.site || report.meeting_title);
    push('User', s.worker || report.user_name);
    push('Date', longDay(report.report_date) || report.report_date);
    push('Time', sessionSpan(s));
    return out;
  }

  /* When the day started and when it stopped, from the per-recording list the
     report already carries. Not a duration: 1091 minutes of audio across a day
     is a fact about the microphone. `07:02 – 17:45` is a fact about the day.

     One recording is a point in time, not a span, and rendering "07:02 – 07:02"
     would read as a stuck clock. */
  function sessionSpan(s) {
    var recs = (s && Array.isArray(s.per_recording)) ? s.per_recording : [];
    var times = recs.map(function (r) {
      return String((r && r.time) || '').slice(0, 5);
    }).filter(function (t) { return /^\d{2}:\d{2}$/.test(t); }).sort();
    if (!times.length) return '';
    var first = times[0], last = times[times.length - 1];
    return first === last ? first : (first + ' \u2013 ' + last);
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

  /* ---------- the reader's shape, when the generator sent one ------------

     `report.sections` is built by the backend (src/report_sections.py) in the
     Library template's own vocabulary -- {title, kind, fields} with `kind` one
     of narrative/kpi/list/table/photos. When it is there it IS the report a
     person is meant to read, and deriving a second set of sections from the
     raw keys beside it produces three separate wrongs at once, all of which
     production showed:

       - a junk section titled "Sections" (the fallback rendering the shape);
       - "Detailed Timeline", rendered from `topics` -- which the report owner
         asked to remove and which the backend now keeps ONLY because
         chunking.py splits the RAG index straight out of it;
       - every entry dumped as `titleCase(key)`: `value`, so a reader saw
         "Status in_progress" and "Follow up needed true" -- database columns,
         verbatim, in a customer's report.

     The derived path stays for weekly and monthly reports, which have no
     `sections`, and for every report generated before this existed. */

  var SECTION_KINDS = { narrative: 1, kpi: 1, list: 1, table: 1,
                        entries: 1, photos: 1 };

  function fromGenerator(report) {
    var raw = report.sections;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    var out = [];
    raw.forEach(function (s, i) {
      if (!s || typeof s !== 'object') return;
      var title = typeof s.title === 'string' ? s.title.trim() : '';
      if (!title) return;
      /* An unknown kind is rendered as a list rather than dropped: a section
         the backend adds next should look plain, not disappear. */
      var kind = (typeof s.kind === 'string'
                  && Object.prototype.hasOwnProperty.call(SECTION_KINDS, s.kind))
        ? s.kind : 'list';
      var body = sectionBody(s, kind);
      if (body === null) return;              /* nothing in it to show */
      out.push({ key: 'gen-' + i, title: title, kind: kind, body: body });
    });
    return out.length ? out : null;
  }

  /* One shape per kind, normalised here so the viewer never has to guess. */
  function sectionBody(s, kind) {
    if (kind === 'narrative') {
      var text = typeof s.body === 'string' ? s.body.trim() : '';
      return text || null;
    }
    if (kind === 'kpi') {
      var vals = s.values && typeof s.values === 'object' ? s.values : {};
      var pairs = (Array.isArray(s.fields) ? s.fields : Object.keys(vals))
        .map(function (f) { return { label: titleCase(f), value: cellText(vals[f]) }; })
        .filter(function (p) { return p.value !== ''; });
      return pairs.length ? pairs : null;
    }
    if (kind === 'table') {
      var fields = (Array.isArray(s.fields) ? s.fields : []).filter(function (f) {
        return typeof f === 'string' && f;
      });
      var rows = (Array.isArray(s.rows) ? s.rows : []).filter(function (r) {
        return r && typeof r === 'object';
      });
      if (!fields.length || !rows.length) return null;
      /* A column every row leaves blank is a header with nothing under it.
         `status` is the live one: the report generator's own extraction has no
         status at all, while org-api's rows carry one. */
      var used = fields.filter(function (f) {
        return rows.some(function (r) { return cellText(r[f]) !== ''; });
      });
      if (!used.length) return null;
      return {
        columns: used.map(function (f) { return { key: f, label: titleCase(f) }; }),
        rows: rows.map(function (r) {
          return used.map(function (f) { return cellText(r[f]); });
        }),
      };
    }
    if (kind === 'entries') {
      /* A thing, the state it is in, and one line about it. Not a table: four
         columns of prose read as a spreadsheet of paragraphs, and the columns
         do not line up anyway, because `note` is a sentence and `status` is a
         word. */
      var entries = (Array.isArray(s.items) ? s.items : [])
        .map(function (e) {
          if (!e || typeof e !== 'object') {
            var plain = cellText(e);
            return plain ? { title: plain, status: '', note: '' } : null;
          }
          var t = cellText(e.title);
          if (!t) return null;
          return { title: t, status: cellText(e.status), note: cellText(e.note) };
        })
        .filter(Boolean);
      return entries.length ? entries : null;
    }

    if (kind === 'photos') {
      /* `{name, key}` since the backend started sending something a fetch can
         use. A bare string is a pre-change report: the name is shown, and
         there is no key to presign, so no thumbnail -- which is honest rather
         than a broken image. */
      var photos = (Array.isArray(s.items) ? s.items : [])
        .map(function (ph) {
          if (typeof ph === 'string') {
            return ph.trim() ? { name: ph.trim(), key: '' } : null;
          }
          if (!ph || typeof ph !== 'object') return null;
          var name = cellText(ph.name) || cellText(ph.key);
          if (!name) return null;
          return { name: name, key: cellText(ph.key) };
        })
        .filter(Boolean);
      return photos.length ? photos : null;
    }

    /* list. */
    var items = (Array.isArray(s.items) ? s.items : [])
      .map(cellText).filter(Boolean);
    return items.length ? items : null;
  }

  /* Cells are strings. `false` and `0` are values a reader may need, so they
     are rendered rather than treated as empty -- but `null`/`undefined` are
     absence, and an object in a cell is a shape nobody designed a column for
     and is left out instead of printed as [object Object]. */
  function cellText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return '';
    return String(v).trim();
  }

  function sections(report) {
    if (!report || typeof report !== 'object') return [];

    var generated = fromGenerator(report);
    if (generated) return generated;

    /* THE GENERATOR SPOKE AND HAD NOTHING TO SHOW. `sections` being an array
       means the backend built the reader's shape; an empty or all-empty one
       means that day produced nothing for it, or `build` raised and the
       backend wrote `[]`. Falling all the way back would then resurrect the
       two things the report owner asked to be rid of -- the Detailed Timeline
       and the raw `Follow up needed  true` entries -- on precisely the days
       nobody is watching. So the raw content still renders, minus the
       timeline: a thin report is better than a blank modal, and `topics` was
       never for a reader. */
    var spoke = Array.isArray(report.sections);

    var out = [];
    var seen = {};

    KNOWN_ORDER.forEach(function (pair) {
      var key = pair[0], title = pair[1];
      seen[key] = 1;
      if (spoke && key === 'topics') return;
      var v = report[key];
      if (isEmpty(v)) return;
      out.push({ key: key, title: title, kind: 'raw', value: v });
    });

    /* Whatever the generator adds next. Rendering it under a derived title
       beats dropping it: a field nobody wired into the viewer is invisible in
       exactly the way `weather` was. */
    Object.keys(report).forEach(function (key) {
      if (seen[key] || META_KEYS[key]) return;
      if (key.charAt(0) === '_') return;
      var v = report[key];
      if (isEmpty(v)) return;
      out.push({ key: key, title: titleCase(key), kind: 'raw', value: v });
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
    cellText:       cellText,
    longDay:        longDay,
    sessionSpan:    sessionSpan,
    reportHeading:  reportHeading,
    reportSubtitle: reportSubtitle,
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
