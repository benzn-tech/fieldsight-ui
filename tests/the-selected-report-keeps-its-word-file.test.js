'use strict';

/*
 * The history endpoint names the Word file and the page still offered the JSON.
 *
 * Reproduced on dev on 2026-09-14, signed in as Ben_UCPK2: the app's own
 * getReportsHistory(50) returned the 3 Sep row WITH
 *   docx_key: "reports/2026-09-03/Ben_UCPK2/daily_report.docx"
 * and the detail panel for that same row read "FILE daily_report.json" and
 * "Download .json".
 *
 * The row's click handler did not hand the row to the detail panel. It built a
 * NEW object from a fixed list of fields -- kind, id, key, type, date,
 * generated_at, size, author, site -- and docx_key was not on the list. So every
 * report in the archive lost its Word file the moment it was clicked.
 *
 * download-the-word-file-not-the-json.test.js stayed green through all of it,
 * because it feeds downloadLabel an object that already carries docx_key -- a
 * shape no producer on the page ever built. This file tests the object the
 * page actually builds.
 *
 * The fix is not a longer list. The row is passed through whole, so the next
 * field the endpoint learns to send cannot be dropped here the same way.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs
  .readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'reports.js'), 'utf8')
  .replace(/\r\n/g, '\n');

function loadHelpers() {
  const parts = ['reportSelection', 'downloadKeyFor', 'downloadLabel'].map(function (n) {
    const m = SOURCE.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n  \\}'));
    assert.ok(m, n + ' has moved or been renamed');
    return m[0];
  });
  // eslint-disable-next-line no-new-func
  return new Function(parts.join('\n')
    + '\nreturn { reportSelection, downloadKeyFor, downloadLabel };')();
}

const { reportSelection, downloadKeyFor, downloadLabel } = loadHelpers();

/* Verbatim from the dev history response for Ben_UCPK2, 2026-09-14. */
const ROW = {
  key: 'reports/2026-09-03/Ben_UCPK2/daily_report.json',
  type: 'daily', date: '2026-09-03',
  generated_at: '2026-09-11T03:26:49+00:00',
  size: 346775,
  docx_key: 'reports/2026-09-03/Ben_UCPK2/daily_report.docx',
  docx_size: 40763,
};

test('THE test: clicking a report keeps its Word file', () => {
  const sel = reportSelection(ROW);
  assert.strictEqual(sel.docx_key, ROW.docx_key,
    'the selection object dropped docx_key, so the panel offered the .json');
  assert.strictEqual(downloadLabel(sel), 'Download .docx');
  assert.strictEqual(downloadKeyFor(sel), ROW.docx_key);
});

test('the File row names the Word file for the selected report', () => {
  // The panel renders (downloadKeyFor(sel) || '').split('/').pop().
  assert.strictEqual((downloadKeyFor(reportSelection(ROW)) || '').split('/').pop(),
    'daily_report.docx');
});

test('a report without a Word file still offers the JSON, honestly labelled', () => {
  const noWord = Object.assign({}, ROW);
  delete noWord.docx_key;
  delete noWord.docx_size;
  const sel = reportSelection(noWord);
  assert.ok(!('docx_key' in sel), 'absent must stay absent, not become undefined-valued');
  assert.strictEqual(downloadLabel(sel), 'Download .json');
});

test('the selection still says what it is', () => {
  const sel = reportSelection(ROW);
  assert.strictEqual(sel.kind, 'report');
  assert.strictEqual(sel.id, ROW.key);
  assert.strictEqual(sel.key, ROW.key);
});

test('every field the endpoint sends reaches the panel, including ones not invented yet', () => {
  const future = Object.assign({ template_version: 'v3' }, ROW);
  assert.strictEqual(reportSelection(future).template_version, 'v3',
    'a fixed field list is how docx_key was lost; it must not come back');
});

test('the selection does not alias the row it came from', () => {
  const row = Object.assign({}, ROW);
  reportSelection(row).size = 0;
  assert.strictEqual(row.size, ROW.size);
});

test('the row click is wired to reportSelection', () => {
  // Wiring only; the behaviour is pinned above.
  assert.ok(/props\.onSelect\(reportSelection\(r\)\)/.test(SOURCE),
    'the list row must hand the panel reportSelection(r), not a hand-built object');
});
