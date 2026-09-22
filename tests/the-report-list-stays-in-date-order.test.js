'use strict';

/*
 * The reports archive is ordered by the day each report is ABOUT.
 *
 * It used to be ordered by generated_at -- the S3 object's LastModified --
 * which overrode the ordering the server had already applied
 * (lambda_org_api._read_org_report_history ends with
 * `reports.sort(key=lambda r: r["date"], reverse=True)`). Two sorts on two
 * different keys, and the client's won.
 *
 * Nobody could see the difference until a report was regenerated: re-running
 * an old one rewrites its object, LastModified jumps to now, and the report
 * about the 11th climbs above the one about the 21st. That is the report in
 * the first test below, taken from what the archive actually showed.
 *
 * THE test is `a regenerated old report does not climb`. If only one test
 * survives, keep that one: it is the whole reason this comparator exists, and
 * it is the only one here that fails under the old generated_at ordering.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'reports.js'), 'utf8')
  .replace(/\r\n/g, '\n');

function lift(names) {
  const parts = names.map(function (n) {
    const m = PAGE.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n  \\}'));
    assert.ok(m, n + ' has moved or been renamed');
    return m[0];
  });
  // eslint-disable-next-line no-new-func
  return new Function(parts.join('\n') + '\nreturn {' + names.join(',') + '};')();
}

const H = lift(['compareReportRows', 'sortReportRows']);

const dates = (rows) => H.sortReportRows(rows).map((r) => r.date);
const keys = (rows) => H.sortReportRows(rows).map((r) => r.key);

/* ---- THE test -------------------------------------------------------------- */

test('THE test: a regenerated old report does not climb above newer dates', () => {
  /* The 11th is re-run NOW, so it holds the most recent generated_at of every
     row here. That is the only shape that catches the bug: if the re-run is
     merely newer than the report's own date but older than the newest report
     in the list, generated_at and date happen to agree and the old ordering
     looks correct. It is the day the report is about that must decide, so the
     11th belongs at the bottom however recently it was written. */
  const rows = [
    { key: 'a/2026-09-11_daily_report.json', date: '2026-09-11', generated_at: '2026-09-22T09:00:00+00:00' },
    { key: 'a/2026-09-21_daily_report.json', date: '2026-09-21', generated_at: '2026-09-21T16:00:00+00:00' },
    { key: 'a/2026-09-20_daily_report.json', date: '2026-09-20', generated_at: '2026-09-20T16:00:00+00:00' },
  ];
  assert.deepStrictEqual(dates(rows), ['2026-09-21', '2026-09-20', '2026-09-11']);
});

/* ---- ordering -------------------------------------------------------------- */

test('newest report date first', () => {
  const rows = [
    { key: 'b', date: '2026-08-31', generated_at: '2026-08-31T16:00:00+00:00' },
    { key: 'c', date: '2026-09-01', generated_at: '2026-09-01T16:00:00+00:00' },
  ];
  assert.deepStrictEqual(dates(rows), ['2026-09-01', '2026-08-31']);
});

test('regenerating does not move a row at all when its date is unchanged', () => {
  const before = [
    { key: 'a', date: '2026-09-21', generated_at: '2026-09-21T16:00:00+00:00' },
    { key: 'b', date: '2026-09-20', generated_at: '2026-09-20T16:00:00+00:00' },
    { key: 'c', date: '2026-09-19', generated_at: '2026-09-19T16:00:00+00:00' },
  ];
  /* Same rows, but the middle one has just been re-run. */
  const after = before.map((r) => (r.key === 'b'
    ? Object.assign({}, r, { generated_at: '2026-09-22T09:00:00+00:00' })
    : r));
  assert.deepStrictEqual(keys(after), keys(before));
});

/* ---- same date, more than one report --------------------------------------- */

test('same date: the freshest of them comes first', () => {
  const rows = [
    { key: 'weekly', date: '2026-09-19', generated_at: '2026-09-19T05:00:00+00:00' },
    { key: 'daily', date: '2026-09-19', generated_at: '2026-09-19T16:00:00+00:00' },
  ];
  assert.deepStrictEqual(keys(rows), ['daily', 'weekly']);
});

test('same date and same generated_at still has ONE order, not an arbitrary one', () => {
  const rows = [
    { key: 'z', date: '2026-09-19', generated_at: '2026-09-19T16:00:00+00:00' },
    { key: 'a', date: '2026-09-19', generated_at: '2026-09-19T16:00:00+00:00' },
  ];
  assert.deepStrictEqual(keys(rows), ['a', 'z']);
  /* And it does not depend on the order they arrived in. */
  assert.deepStrictEqual(keys(rows.slice().reverse()), ['a', 'z']);
});

/* ---- a row we cannot place in time ----------------------------------------- */

test('a dateless row sinks; it never heads the list', () => {
  /* date === '' is what the server sends when REPORT_DATE_IN_KEY_RE finds no
     date in the key -- and such a row was written most recently of all, so
     the old ordering put it first. */
  const rows = [
    { key: 'odd', date: '', generated_at: '2026-09-22T23:59:00+00:00' },
    { key: 'a', date: '2026-09-21', generated_at: '2026-09-21T16:00:00+00:00' },
  ];
  assert.deepStrictEqual(keys(rows), ['a', 'odd']);
});

test('a row missing date/generated_at entirely does not throw', () => {
  const rows = [{ key: 'a' }, { key: 'b', date: '2026-09-21' }];
  assert.deepStrictEqual(keys(rows), ['b', 'a']);
});

/* ---- the caller's contract ------------------------------------------------- */

test('sortReportRows does not mutate what it was given', () => {
  const rows = [
    { key: 'a', date: '2026-09-11', generated_at: '2026-09-20T02:00:00+00:00' },
    { key: 'b', date: '2026-09-21', generated_at: '2026-09-21T16:00:00+00:00' },
  ];
  const asGiven = rows.map((r) => r.key);
  H.sortReportRows(rows);
  assert.deepStrictEqual(rows.map((r) => r.key), asGiven);
});

test('no rows at all is an empty list, not a crash', () => {
  assert.deepStrictEqual(H.sortReportRows(undefined), []);
  assert.deepStrictEqual(H.sortReportRows(null), []);
  assert.deepStrictEqual(H.sortReportRows([]), []);
});
