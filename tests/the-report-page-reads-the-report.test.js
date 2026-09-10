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
  recording_session: { recordings: 3, total_duration_display: '2m 52s', photos: 6 },

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
