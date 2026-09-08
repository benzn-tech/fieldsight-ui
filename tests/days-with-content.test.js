'use strict';

/*
 * feat/days-with-content-not-reports.
 *
 * `hasReport` was read as "does this day exist". It means "extraction
 * produced topics", and on 2026-09-08 that hid 18 of prod's 42 capture days
 * — 166 photos and 83 sessions, including the two most recent days in the
 * system. Seven of those days hold photos and no audio at all, so no amount
 * of extraction reliability would ever bring them back.
 *
 * The trap these tests exist to pin: the obvious change (flip the predicate
 * in date-picker's intensity()) renders NOTHING, because intensity() is
 * driven by the topics count, the dot is only drawn under `i > 0`, and
 * composites.css has no `--i0` rule. A test that asserted on the predicate
 * would have passed against a no-op, so the picker assertions here go
 * through DayCell's rendered output instead.
 */
const test = require('node:test');
const assert = require('node:assert');

/* ---- shared window stub -------------------------------------------------- */

let orgCalls, legacyCalls, orgResponse, legacyResponse;

global.window = {
  FieldSight: {},
  FS: {
    api: {
      useMocks: false,
      timelineSource: 'aurora',
      orgBaseUrl: 'https://example.test/api',
      legacyReadFallback: true,
      orgRequest: function (path, opts) {
        orgCalls.push({ path: path, params: opts && opts.params });
        return Promise.resolve(orgResponse);
      },
      request: function (path, opts) {
        legacyCalls.push({ path: path, params: opts && opts.params });
        return Promise.resolve(legacyResponse);
      },
    },
  },
};

function reset() {
  orgCalls = [];
  legacyCalls = [];
  orgResponse = { dates: {} };
  legacyResponse = { dates: {} };
  global.window.FS.api.timelineSource = 'aurora';
  global.window.FS.api.orgBaseUrl = 'https://example.test/api';
}
reset();

const dates = require('../scripts/api/dates.js');
/* dates.js must be loaded first: data-window and the picker both read
   FS.api.dates.hasContent off the live registry. */
global.window.FS.api.dates = { hasContent: dates.hasContent };
const dataWindow = require('../scripts/api/data-window.js');

/* ---- hasContent ---------------------------------------------------------- */

test('hasContent: report-only, uploads-only, both, neither', () => {
  assert.strictEqual(dates.hasContent({ hasReport: true,  hasUploads: false }), true);
  assert.strictEqual(dates.hasContent({ hasReport: false, hasUploads: true  }), true);
  assert.strictEqual(dates.hasContent({ hasReport: true,  hasUploads: true  }), true);
  assert.strictEqual(dates.hasContent({ hasReport: false, hasUploads: false }), false);
});

test('hasContent: an ABSENT hasUploads falls through to hasReport', () => {
  /* The legacy path, mock mode and any backend older than pipeline #775
     never send the field. Absence is the fallback, not a missing case —
     this is what guarantees no behaviour change where it is not sent. */
  assert.strictEqual(dates.hasContent({ hasReport: true }),  true);
  assert.strictEqual(dates.hasContent({ hasReport: false }), false);
  assert.strictEqual(dates.hasContent({}), false);
  assert.strictEqual(dates.hasContent(null), false);
  assert.strictEqual(dates.hasContent(undefined), false);
});

/* ---- the opt-in actually goes on the wire -------------------------------- */

test('the aurora path asks for uploads; the legacy path does not', async () => {
  reset();
  orgResponse = { dates: { '2026-09-07': { hasReport: false, hasUploads: true } } };
  await dates.fetchDates({ months: 24 });

  assert.strictEqual(orgCalls.length, 1);
  assert.strictEqual(orgCalls[0].params.uploads, 1,
    'without this the backend returns the topics-only index and the whole feature is dark');
  assert.strictEqual(legacyCalls.length, 0);
});

test('the legacy path is left byte-identical', async () => {
  reset();
  global.window.FS.api.timelineSource = 'report';   // kill switch → legacy
  await dates.fetchDates({ months: 3, site: 's1', user: 'Neil_Blunden' });

  assert.strictEqual(orgCalls.length, 0);
  assert.strictEqual(legacyCalls.length, 1);
  assert.deepStrictEqual(Object.keys(legacyCalls[0].params).sort(),
    ['months', 'site', 'user'],
    'get_dates ignores unknown params, so sending uploads there would be a silent no-op');
});

/* ---- the span ------------------------------------------------------------ */

test('computeSpan widens to a day that was captured but never summarised', () => {
  const span = dataWindow.computeSpan({
    '2026-08-20': { hasReport: false, hasUploads: true, topics: 0 },  // 56 photos on prod
    '2026-08-22': { hasReport: true,  hasUploads: true, topics: 5 },
    '2026-09-07': { hasReport: false, hasUploads: true, topics: 0 },
  });
  assert.strictEqual(span.earliest, '2026-08-20');
  assert.strictEqual(span.latest,   '2026-09-07');
});

test('computeSpan is unchanged when hasUploads is absent', () => {
  const span = dataWindow.computeSpan({
    '2026-08-20': { hasReport: false, topics: 0 },
    '2026-08-22': { hasReport: true,  topics: 5 },
  });
  assert.strictEqual(span.earliest, '2026-08-22');
  assert.strictEqual(span.latest,   '2026-08-22');
});

test("computeSpan on a map with nothing in it stays null/null", () => {
  const span = dataWindow.computeSpan({});
  assert.strictEqual(span.earliest, null);
  assert.strictEqual(span.latest,   null);
});

/* ---- the calendar cell --------------------------------------------------- */

global.React = {
  createElement: function (type, props) {
    return {
      type: type,
      props: props || {},
      children: Array.prototype.slice.call(arguments, 2),
    };
  },
  Fragment: 'Fragment',
  useState: function (v) { return [v, function () {}]; },
  useEffect: function () {},
  useRef: function (v) { return { current: v }; },
};

const picker = require('../scripts/composites/date-picker.js');

function dotClasses(cell) {
  /* The dots live in the last child span; walk rather than index so this
     does not silently pass if the tree is reshaped. */
  const out = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    const cn = node.props && node.props.className;
    /* `cell-dot--`, not `cell-dot`: the container span is `cell-dots`. */
    if (typeof cn === 'string' && cn.indexOf('cell-dot--') !== -1) out.push(cn);
    (node.children || []).forEach(function (c) {
      if (Array.isArray(c)) c.forEach(walk); else walk(c);
    });
  }(cell));
  return out;
}

test('a captured-but-not-summarised day RENDERS a glyph', () => {
  const cell = picker.DayCell({
    iso: '2026-08-20', label: '20',
    meta: { hasReport: false, hasUploads: true, topics: 0, safety: 0, photos: 56, sessions: 0 },
  });
  const dots = dotClasses(cell);

  /* The assertion that matters. intensity() still returns 0 here — asserting
     on the predicate instead of the output would pass against a change that
     draws nothing at all. */
  assert.strictEqual(picker.intensity(
    { hasReport: false, hasUploads: true, topics: 0 }), 0);
  assert.ok(dots.some(function (c) { return c.indexOf('cell-dot--content') !== -1; }),
    'expected an outline dot; got ' + JSON.stringify(dots));
  assert.ok(!dots.some(function (c) { return /cell-dot--i[123]/.test(c); }),
    'must not claim a density shade for topics: 0');
});

test('the cell announces what arrived instead of "no report"', () => {
  const cell = picker.DayCell({
    iso: '2026-08-20', label: '20',
    meta: { hasReport: false, hasUploads: true, topics: 0, photos: 56, sessions: 0 },
  });
  assert.strictEqual(cell.props['aria-label'], '2026-08-20, 56 photos');

  const both = picker.DayCell({
    iso: '2026-07-13', label: '13',
    meta: { hasReport: false, hasUploads: true, topics: 0, photos: 7, sessions: 17 },
  });
  assert.strictEqual(both.props['aria-label'], '2026-07-13, 7 photos, 17 recordings');
});

test('a day with a report is untouched — same shade, same label', () => {
  const cell = picker.DayCell({
    iso: '2026-08-22', label: '22',
    meta: { hasReport: true, topics: 8, safety: 2 },
  });
  const dots = dotClasses(cell);
  assert.ok(dots.some(function (c) { return c.indexOf('cell-dot--i2') !== -1; }));
  assert.ok(!dots.some(function (c) { return c.indexOf('cell-dot--content') !== -1; }),
    'a summarised day gets its density dot, not the outline one');
  assert.strictEqual(cell.props['aria-label'], '2026-08-22, 8 topics, 2 safety');
});

test('a day with nothing on it still renders nothing and says so', () => {
  const cell = picker.DayCell({ iso: '2026-08-24', label: '24', meta: null });
  assert.deepStrictEqual(dotClasses(cell), []);
  assert.strictEqual(cell.props['aria-label'], '2026-08-24, no report');
});

/* ---- the landing date ---------------------------------------------------- */

test('findLatestReportDate lands on the newest day with CONTENT', () => {
  const timeline = require('../scripts/pages/timeline.js');
  const latest = timeline.findLatestReportDate({
    '2026-09-02': { hasReport: true,  topics: 6 },
    '2026-09-06': { hasReport: false, hasUploads: true, topics: 0 },
    '2026-09-07': { hasReport: false, hasUploads: true, topics: 0 },
  });
  assert.strictEqual(latest, '2026-09-07',
    'landing on 09-02 put the user two days behind their own newest recording');
});

test('findLatestReportDate returns null when the map holds nothing', () => {
  const timeline = require('../scripts/pages/timeline.js');
  assert.strictEqual(timeline.findLatestReportDate({}), null);
  assert.strictEqual(timeline.findLatestReportDate(null), null);
});

/* ---- Evidence: the day it can now see ------------------------------------ */

const eg = require('../scripts/api/evidence-grouping.js');

test('a no-report day with photos becomes a renderable report shape', () => {
  const r = eg.reportFromUploadFacts({
    message: 'No report for Neil_Blunden on 2026-08-20',
    date: '2026-08-20', user: 'Neil_Blunden',
    uploads: { sessions: 0, duration_s: 0, photos: 2 },
    photo_filenames: ['neil_blunden_2026-08-20_09-00-00.jpg',
                      'neil_blunden_2026-08-20_14-31-02.jpg'],
    day_state: 'captured',
  });

  assert.strictEqual(r.user_name, 'Neil Blunden',
    'the 404 body spells the folder `user`; photosForReport reads `user_name`');
  const rows = eg.photosForReport(r);
  assert.strictEqual(rows.length, 2);
  rows.forEach(function (row) {
    assert.strictEqual(row.userDisplayName, 'Neil Blunden',
      'PhotoGrid builds the S3 key from this — undefined here resolves no photo');
    assert.strictEqual(row.topic_id, null, 'unbound, not bound to topic 0');
  });
});

test('the other two 404s carry no filenames and yield nothing', () => {
  /* cross-user clip and deleted-sources both look like a no-report day and
     both withhold the counts on purpose. Testing the payload rather than the
     status code is what keeps them out. */
  assert.strictEqual(eg.reportFromUploadFacts(
    { message: 'No in-scope report for X on D', date: 'D', user: 'X' }), null);
  assert.strictEqual(eg.reportFromUploadFacts({ user: 'X', photo_filenames: [] }), null);
  assert.strictEqual(eg.reportFromUploadFacts(null), null);
  assert.strictEqual(eg.reportFromUploadFacts(undefined), null);
});

/* ---- the aggregated day view -------------------------------------------- */

test('capturedFolders surfaces the folders that captured but did not report', () => {
  const timeline = require('../scripts/pages/timeline.js');
  const out = timeline.capturedFolders([
    { user: { folder_name: 'Sam_Yu', name: 'Sam Yu' },
      report: { _notFound: true, raw: { user: 'Sam_Yu',
        uploads: { sessions: 1, duration_s: 60, photos: 0 }, day_state: 'captured' } } },
    { user: { folder_name: 'Ben_UCPK', name: 'Ben UCPK' },
      report: { _notFound: true, raw: { user: 'Ben_UCPK',
        photo_filenames: ['a.jpg'] } } },
    /* withheld 404s — no counts, no filenames */
    { user: { folder_name: 'Clipped', name: 'Clipped' },
      report: { _notFound: true, raw: { user: 'Clipped', message: 'no in-scope report' } } },
    /* nothing to say at all */
    { user: { folder_name: 'Bare', name: 'Bare' }, report: { _notFound: true } },
    /* a real report is not this view's business */
    { user: { folder_name: 'Has_Report', name: 'Has Report' },
      report: { topics: [] } },
  ]);

  assert.deepStrictEqual(out.map(function (c) { return c.user.folder_name; }),
    ['Ben_UCPK', 'Sam_Yu'], 'sorted by display name, withheld/bare/reported dropped');
  assert.strictEqual(out[1].facts.uploads.sessions, 1,
    'facts are passed through verbatim — NoReportState already reads this shape');
});

test('capturedFolders on an ordinary day returns nothing to render', () => {
  const timeline = require('../scripts/pages/timeline.js');
  assert.deepStrictEqual(timeline.capturedFolders([
    { user: { folder_name: 'A', name: 'A' }, report: { topics: [{ topic_id: 0 }] } },
  ]), []);
  assert.deepStrictEqual(timeline.capturedFolders([]), []);
  assert.deepStrictEqual(timeline.capturedFolders(null), []);
});
