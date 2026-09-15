'use strict';

/*
 * The viewer used to derive its own sections from the report's raw keys. The
 * backend now sends `sections` -- the reader's shape, in the template
 * Library's own vocabulary -- and rendering both produced three wrongs at
 * once, all of them visible in production on 2026-09-11:
 *
 *   1. A section titled "Sections". The derived path ends with "anything the
 *      generator adds later still appears, under a title derived from its
 *      key", which is a good rule that had never met a key holding the whole
 *      shape.
 *
 *   2. "Detailed Timeline", rendered from `topics`. The report owner asked for
 *      that to go ("不需要知道几点几点干了什么"). The backend removed it from the
 *      report a person reads and KEPT `topics` on the wire, because
 *      chunking.py splits the RAG index straight out of it -- so the viewer
 *      kept drawing it.
 *
 *   3. Every entry flattened to `titleCase(key)`: `String(value)`:
 *
 *          Waterproofing detail 216 - heavy dwang solution
 *          Status              in_progress
 *          Details             Stick with heavy dwang, on top of it
 *          Follow up needed    true
 *
 *      Database columns, verbatim, in a customer's report.
 *
 * These pin the new path. The DERIVED path is not deleted and is still
 * covered by read-a-report-in-the-browser.test.js: weekly and monthly reports
 * have no `sections`, and neither does any report generated before it existed.
 */

const test = require('node:test');
const assert = require('node:assert');

const vm = require('../scripts/api/report-view-model.js');

/* A daily report as the backend sends it today: BOTH shapes on the wire. */
const REPORT = {
  report_date: '2026-09-03', report_type: 'daily', site: 'UC PK',
  user_name: 'Ben_UCPK2',
  recording_session: {
    worker: 'Ben_UCPK2', recordings: 3, total_duration_display: '2m 52s', photos: 6,
    per_recording: [{ time: '07:02:13' }, { time: '12:30:00' }, { time: '17:45:45' }],
  },

  /* The machine's half. Still on the wire, still not for a reader. */
  topics: [{ topic_title: 'Ground floor', time_range: '10:00 – 10:03',
             summary: 'Checked the IT room.', action_items: [] }],
  quality_and_compliance: [{
    item: 'Waterproofing detail 216 - heavy dwang solution',
    status: 'in_progress',
    details: 'Stick with heavy dwang, on top of it',
    follow_up_needed: true,
  }],

  /* The reader's half. */
  sections: [
    { title: 'Summary', kind: 'narrative', body: 'A day on level three.' },
    { title: 'On Site', kind: 'kpi', fields: ['recordings', 'duration', 'photos'],
      values: { recordings: 3, duration: '2m 52s', photos: 6 } },
    { title: 'Actions', kind: 'table',
      fields: ['action', 'owner', 'due', 'priority', 'status'],
      rows: [
        { action: 'Chase the steel', owner: 'Ada', due: 'Monday',
          priority: 'high', status: 'open', mentions: 2 },
      ] },
    { title: 'Issues & Quality', kind: 'table',
      fields: ['item', 'status', 'detail'],
      rows: [{ item: 'Waterproofing detail 216 - heavy dwang solution',
               status: 'in_progress',
               detail: 'Stick with heavy dwang, on top of it' }] },
    { title: 'Open Questions', kind: 'list',
      items: ['Is 3604 a 150 or a 200?'] },
  ],
};

function titles(report) {
  return vm.sections(report).map(function (s) { return s.title; });
}

function byTitle(report, title) {
  return vm.sections(report).filter(function (s) { return s.title === title; })[0];
}

/* ---------- the three wrongs ------------------------------------------- */

test('there is no section called "Sections"', () => {
  assert.ok(titles(REPORT).indexOf('Sections') === -1,
    'the shape rendered itself as one of its own sections');
});

test('the timeline is not drawn, even though topics is still on the wire', () => {
  assert.ok(REPORT.topics.length > 0, 'the fixture must keep topics — RAG reads it');
  assert.ok(titles(REPORT).indexOf('Detailed Timeline') === -1);
});

test('a quality entry is a row with columns, not a dump of its columns', () => {
  const s = byTitle(REPORT, 'Issues & Quality');
  assert.strictEqual(s.kind, 'table');
  assert.deepStrictEqual(s.body.columns.map(function (c) { return c.label; }),
    ['Item', 'Status', 'Detail']);
  assert.deepStrictEqual(s.body.rows, [[
    'Waterproofing detail 216 - heavy dwang solution',
    'in_progress',
    'Stick with heavy dwang, on top of it',
  ]]);
});

test('a field the backend did not declare never reaches a reader', () => {
  /* `follow_up_needed` and `mentions` are on the rows; neither is in `fields`.
     The old renderer printed every key it found, which is how "Follow up
     needed  true" got in front of a customer. */
  const flat = JSON.stringify(vm.sections(REPORT));
  assert.ok(flat.indexOf('follow_up_needed') === -1);
  assert.ok(flat.indexOf('Follow up needed') === -1);
  assert.ok(flat.indexOf('Mentions') === -1);
});

/* ---------- the shapes render ------------------------------------------ */

test('the sections come out in the order the backend put them', () => {
  assert.deepStrictEqual(titles(REPORT),
    ['Summary', 'On Site', 'Actions', 'Issues & Quality', 'Open Questions']);
});

test('a narrative section is its text', () => {
  const s = byTitle(REPORT, 'Summary');
  assert.strictEqual(s.kind, 'narrative');
  assert.strictEqual(s.body, 'A day on level three.');
});

test('a kpi section is labelled values', () => {
  const s = byTitle(REPORT, 'On Site');
  assert.deepStrictEqual(s.body, [
    { label: 'Recordings', value: '3' },
    { label: 'Duration', value: '2m 52s' },
    { label: 'Photos', value: '6' },
  ]);
});

test('a list section is its items', () => {
  assert.deepStrictEqual(byTitle(REPORT, 'Open Questions').body,
    ['Is 3604 a 150 or a 200?']);
});

test('the actions table keeps the column order the backend declared', () => {
  assert.deepStrictEqual(
    byTitle(REPORT, 'Actions').body.columns.map(function (c) { return c.key; }),
    ['action', 'owner', 'due', 'priority', 'status']);
});

/* ---------- a column with nothing in it -------------------------------- */

test('a column every row leaves blank is dropped, not left as an empty header', () => {
  /* The live case: the report generator's own extraction carries no `status`
     at all, while org-api's rows do. A "Status" header over five blanks is a
     claim that five things have no status. */
  const r = Object.assign({}, REPORT, { sections: [{
    title: 'Actions', kind: 'table', fields: ['action', 'owner', 'status'],
    rows: [{ action: 'Chase the steel', owner: 'Ada' },
           { action: 'Book the crane', owner: 'Sam' }],
  }] });
  assert.deepStrictEqual(
    byTitle(r, 'Actions').body.columns.map(function (c) { return c.key; }),
    ['action', 'owner']);
});

test('a zero is a value and is kept', () => {
  /* "Photos 0" is a fact about the day. Treating falsy as absent would hide
     it and leave the reader to assume nobody looked. */
  const r = Object.assign({}, REPORT, { sections: [{
    title: 'On Site', kind: 'kpi', fields: ['photos'], values: { photos: 0 },
  }] });
  assert.deepStrictEqual(byTitle(r, 'On Site').body,
    [{ label: 'Photos', value: '0' }]);
});

/* ---------- degrading ---------------------------------------------------- */

test('an empty sections array falls back rather than showing nothing', () => {
  /* A report whose sections could not be built still has content, and a blank
     modal is the worst of the three outcomes. */
  const r = Object.assign({}, REPORT, { sections: [] });
  const t = titles(r);
  assert.ok(t.indexOf('Quality & Compliance') !== -1, t.join(', '));
});

test('a malformed sections value falls back and still hides the junk section', () => {
  /* Whatever `sections` turns out to be, it is never content: it is in
     META_KEYS, so the derived path cannot render it under a derived title. */
  [null, 'nonsense', 42, {}, [null, 'x', {}], [{ kind: 'table' }]].forEach(function (bad) {
    const r = Object.assign({}, REPORT, { sections: bad });
    const t = titles(r);
    assert.ok(t.indexOf('Sections') === -1, 'sections rendered for ' + JSON.stringify(bad));
    assert.ok(t.length > 0, 'nothing rendered for ' + JSON.stringify(bad));
  });
});

test('a section with an unknown kind is shown as a list rather than dropped', () => {
  const r = Object.assign({}, REPORT, { sections: [
    { title: 'Deliveries', kind: 'gantt', items: ['Steel on Tuesday'] },
  ] });
  const s = byTitle(r, 'Deliveries');
  assert.strictEqual(s.kind, 'list');
  assert.deepStrictEqual(s.body, ['Steel on Tuesday']);
});

test('a section with a title and nothing in it is skipped', () => {
  const r = Object.assign({}, REPORT, { sections: [
    { title: 'Summary', kind: 'narrative', body: '   ' },
    { title: 'Safety', kind: 'list', items: [] },
    { title: 'Actions', kind: 'table', fields: ['action'], rows: [] },
    { title: 'Open Questions', kind: 'list', items: ['Real one'] },
  ] });
  assert.deepStrictEqual(titles(r), ['Open Questions']);
});

test('an object in a cell is left out rather than printed as [object Object]', () => {
  const r = Object.assign({}, REPORT, { sections: [{
    title: 'Actions', kind: 'table', fields: ['action', 'owner'],
    rows: [{ action: 'Chase the steel', owner: { name: 'Ada' } }],
  }] });
  const s = byTitle(r, 'Actions');
  assert.deepStrictEqual(s.body.columns.map(function (c) { return c.key; }), ['action']);
  assert.ok(JSON.stringify(s.body).indexOf('object Object') === -1);
});

test('null and odd reports still do not throw', () => {
  [null, undefined, 'x', 42, {}].forEach(function (bad) {
    assert.doesNotThrow(function () { vm.sections(bad); });
  });
});

/* ---------- what the review caught ------------------------------------- */

test('every derived section is marked raw, because one string tells them apart', () => {
  /* The modal branches on `s.kind === 'raw'`. Lose the marker on the derived
     path and a weekly report reaches the generated renderer with `body`
     undefined — `body.map` throws inside render, and React blanks the WHOLE
     modal. A missing section is a bug; a blank modal is an outage. */
  const WEEKLY = {
    report_date: '2026-08-16', report_type: 'weekly', site: 'UC PK',
    executive_summary: ['A week.'], safety_trends: ['Fewer near misses.'],
  };
  vm.sections(WEEKLY).forEach(function (s) {
    assert.strictEqual(s.kind, 'raw', s.title + ' lost its raw marker');
    assert.ok('value' in s, s.title + ' has no value for the raw renderer');
  });
});

test('a thin day does not bring the timeline back', () => {
  /* `sections: []` means the backend built the reader's shape and it came out
     empty — or `build` raised and it wrote []. Falling all the way back would
     resurrect the Detailed Timeline and the raw entries on exactly the days
     nobody is watching. */
  [[], [{ title: 'Summary', kind: 'narrative', body: '   ' }]].forEach(function (thin) {
    const r = Object.assign({}, REPORT, { sections: thin });
    const t = titles(r);
    assert.ok(t.indexOf('Detailed Timeline') === -1,
      'timeline came back for ' + JSON.stringify(thin));
    assert.ok(t.indexOf('Quality & Compliance') !== -1,
      'a thin report should still show its content, not a blank modal');
  });
});

test('a report that never had sections still shows its timeline', () => {
  /* The distinction that makes the rule above safe: "the generator spoke and
     had nothing" is not "this report predates sections". */
  const legacy = Object.assign({}, REPORT);
  delete legacy.sections;
  assert.ok(titles(legacy).indexOf('Detailed Timeline') !== -1);
});

test('a meeting is named on screen somewhere', () => {
  /* A meeting's compat report deliberately leaves `site` empty and carries
     `meeting_title`. That key is in META_KEYS so it is never content — which
     left the name of the meeting appearing nowhere at all. */
  const meeting = {
    report_date: '2026-09-03', report_type: 'daily', site: '',
    meeting_title: 'Subcontractor coordination',
    executive_summary: ['Discussed the programme.'],
  };
  assert.ok(vm.reportTitle(meeting).indexOf('Subcontractor coordination') !== -1,
    vm.reportTitle(meeting));
});

test('a real site still beats a meeting title', () => {
  assert.ok(vm.reportTitle(Object.assign({}, REPORT,
    { meeting_title: 'Should not win' })).indexOf('UC PK') !== -1);
});

test('a kind borrowed from Object.prototype is not a kind', () => {
  const r = Object.assign({}, REPORT, { sections: [
    { title: 'Odd', kind: 'constructor', items: ['Still readable'] },
  ] });
  assert.strictEqual(byTitle(r, 'Odd').kind, 'list');
});

/* ---------- the header and the photographs ----------------------------- */

test('the report is named, and what changes sits underneath', () => {
  /* "Daily Site Report: UC PK — 2026-09-03" makes a reader parse a sentence
     to learn they are looking at a daily report. The name is the heading; the
     site and the day are the line under it. */
  assert.strictEqual(vm.reportHeading(REPORT), 'Daily Site Report');
  assert.strictEqual(vm.reportSubtitle(REPORT), 'UC PK · Thursday 3 September 2026');
});

test('the day is named by its weekday, which is how anyone remembers it', () => {
  assert.strictEqual(vm.longDay('2026-09-03'), 'Thursday 3 September 2026');
  assert.strictEqual(vm.longDay('2026-09-09'), 'Wednesday 9 September 2026');
});

test('the date is read as UTC, not as local midnight', () => {
  /* BUG-19: `new Date('2026-09-03')` is UTC midnight, and printing it with
     local getters in NZ (UTC+12/+13) yields the 3rd or the 4th depending on
     the season. A report would be filed under the wrong weekday for half the
     year, and only for half the year. */
  ['2026-01-15', '2026-07-15'].forEach(function (iso) {
    assert.ok(vm.longDay(iso).indexOf(iso.slice(8).replace(/^0/, '')) !== -1,
      iso + ' -> ' + vm.longDay(iso));
  });
});

test('a weekly report keeps its span in the subtitle', () => {
  const weekly = { report_type: 'weekly', site: 'UC PK', report_date: '2026-08-16',
                   period: { start: '2026-08-10', end: '2026-08-16' } };
  assert.strictEqual(vm.reportHeading(weekly), 'Weekly Site Report');
  assert.ok(vm.reportSubtitle(weekly).indexOf('→') !== -1, vm.reportSubtitle(weekly));
});

test('the header is site, user, date and time — and nothing about the recording', () => {
  const map = {};
  vm.headerFacts(REPORT).forEach(function (f) { map[f.label] = f.value; });
  assert.deepStrictEqual(Object.keys(map), ['Site', 'User', 'Date', 'Time']);
  assert.strictEqual(map.Time, '07:02 – 17:45');
});

test('one recording is a time, not a span that reads as a stuck clock', () => {
  assert.strictEqual(vm.sessionSpan({ per_recording: [{ time: '09:15:00' }] }), '09:15');
  assert.strictEqual(vm.sessionSpan({}), '');
  assert.strictEqual(vm.sessionSpan({ per_recording: [{ time: 'nonsense' }] }), '');
});

test('quality and safety are the same shape, and it is not a table', () => {
  /* Asked for directly: "我不关心你是用列表还是表格，我希望和上面统一", and the
     table form was 冗长 — four columns of prose read as a spreadsheet of
     paragraphs, and they never line up because `note` is a sentence and
     `status` is a word. */
  const r = Object.assign({}, REPORT, { sections: [
    { title: 'Issues & Quality', kind: 'entries', items: [
      { title: 'PS4 outstanding', status: 'concern', note: 'Chase the engineer' }] },
    { title: 'Safety', kind: 'entries', items: [
      { title: 'Loose cable', status: 'low', note: 'Level 2 · Tape it' }] },
  ] });
  const q = byTitle(r, 'Issues & Quality'), s = byTitle(r, 'Safety');
  assert.strictEqual(q.kind, 'entries');
  assert.strictEqual(s.kind, 'entries');
  assert.deepStrictEqual(Object.keys(q.body[0]), Object.keys(s.body[0]));
  assert.deepStrictEqual(q.body[0],
    { title: 'PS4 outstanding', status: 'concern', note: 'Chase the engineer' });
});

test('an entry with no note or status is still an entry', () => {
  const r = Object.assign({}, REPORT, { sections: [
    { title: 'Safety', kind: 'entries', items: [{ title: 'Loose cable' }, 'Bare string'] },
  ] });
  assert.deepStrictEqual(byTitle(r, 'Safety').body, [
    { title: 'Loose cable', status: '', note: '' },
    { title: 'Bare string', status: '', note: '' },
  ]);
});

test('a photo carries a key, because a filename cannot be fetched', () => {
  /* Why photos were never IN the report: `related_photos` held bare
     filenames, so nothing downstream could presign one. */
  const r = Object.assign({}, REPORT, { sections: [
    { title: 'Photos', kind: 'photos', items: [
      { name: 'a.jpg', key: 'users/Ben_UCPK2/pictures/2026-09-03/a.jpg' }] },
  ] });
  assert.deepStrictEqual(byTitle(r, 'Photos').body,
    [{ name: 'a.jpg', key: 'users/Ben_UCPK2/pictures/2026-09-03/a.jpg' }]);
});

test('a photo from an older report still shows its name', () => {
  /* Reports generated before the key existed carry plain strings. A name with
     no thumbnail is honest; a broken image is not. */
  const r = Object.assign({}, REPORT, { sections: [
    { title: 'Photos', kind: 'photos', items: ['old.jpg'] },
  ] });
  assert.deepStrictEqual(byTitle(r, 'Photos').body, [{ name: 'old.jpg', key: '' }]);
});

/* ---------- weather impact, and what got done -------------------------- */

test('the weather impact level is the only thing that gets a colour', () => {
  /* Yellow through red, asked for directly. A word the frontend does not know
     stays neutral rather than guessing: a wrong colour on a safety line is
     worse than no colour at all. */
  const modal = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'scripts', 'composites',
                         'report-viewer-modal.js'), 'utf8');
  ['low', 'moderate', 'high', 'severe'].forEach(function (level) {
    assert.ok(modal.indexOf(level + ": 'fs-report-view__chip--" + level + "'") !== -1,
      level + ' has no tone');
  });
  const css = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'styles', 'composites.css'), 'utf8');
  ['low', 'moderate', 'high', 'severe'].forEach(function (level) {
    assert.ok(css.indexOf('.fs-report-view__chip--' + level) !== -1,
      level + ' has no rule');
  });
});

test('a weather section carries its lines and its impact', () => {
  const r = Object.assign({}, REPORT, { sections: [{
    title: 'Weather', kind: 'entries', items: [
      { title: 'Slight rain', status: 'moderate',
        note: 'rain affects earthworks and pours' },
      { title: 'Temperature: 11.2°C – 13.5°C', status: '', note: '' },
      { title: 'Rainfall: 5.9mm', status: '', note: '' },
      { title: 'Maximum wind speed: 22.2 km/h', status: '', note: '' },
    ] }] });
  const w = byTitle(r, 'Weather');
  assert.strictEqual(w.kind, 'entries');
  assert.strictEqual(w.body.length, 4);
  assert.strictEqual(w.body[0].status, 'moderate');
  assert.strictEqual(w.body[1].status, '', 'a measurement is not an impact');
});

test('work completed is its own list', () => {
  const r = Object.assign({}, REPORT, { sections: [{
    title: 'Work Completed', kind: 'list',
    items: ['Continued groundworks despite slight rain',
            'Progressed with foundation preparations'] }] });
  assert.deepStrictEqual(byTitle(r, 'Work Completed').body,
    ['Continued groundworks despite slight rain',
     'Progressed with foundation preparations']);
});
