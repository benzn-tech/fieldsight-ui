'use strict';

/*
 * The button says "Download .docx" and has always presigned the .json.
 *
 * The generator writes a Word file beside every report — measured in
 * production: 183 of them, `daily_report.docx` 39 KiB next to
 * `daily_report.json` 25 KiB for the same day — but GET /api/reports/history
 * returned only the .json key, and `downloadReport` presigned whatever key it
 * was handed. Reported as "I can only see JSON from the web", with a
 * presigned URL ending `daily_report.json` pasted underneath a button
 * labelled .docx.
 *
 * The endpoint now carries `docx_key` when a Word file exists. `docx_key`
 * ABSENT is a real state, not an oversight: Word generation disables itself
 * when the python-docx layer is missing or built for the wrong runtime, and
 * one production day has a .json with no .docx beside it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs
  .readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'reports.js'), 'utf8')
  .replace(/\r\n/g, '\n');

/* reports.js is a browser IIFE with no export; lift the two pure helpers out
   and run the real definitions. */
function loadHelpers() {
  const parts = ['downloadKeyFor', 'downloadLabel'].map(function (n) {
    const m = SOURCE.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n  \\}'));
    assert.ok(m, n + ' has moved or been renamed');
    return m[0];
  });
  // eslint-disable-next-line no-new-func
  return new Function(parts.join('\n')
    + '\nreturn { downloadKeyFor, downloadLabel };')();
}

const { downloadKeyFor, downloadLabel } = loadHelpers();

const WITH_WORD = {
  type: 'daily', date: '2026-09-02',
  key: 'reports/2026-09-02/Ben_UCPK2/daily_report.json',
  docx_key: 'reports/2026-09-02/Ben_UCPK2/daily_report.docx',
  size: 25490, docx_size: 40243,
};
const WITHOUT_WORD = {
  type: 'daily', date: '2026-09-08',
  key: 'reports/2026-09-08/Ben_UCPK2/daily_report.json',
  size: 6095,
};

test('a report with a Word file downloads the Word file', () => {
  assert.strictEqual(downloadKeyFor(WITH_WORD),
    'reports/2026-09-02/Ben_UCPK2/daily_report.docx',
    'this is the whole defect: the .docx sat beside the .json and the button '
    + 'fetched the .json every time');
});

test('and the button says what it will actually hand over', () => {
  assert.strictEqual(downloadLabel(WITH_WORD), 'Download .docx');
});

test('a report with no Word file still downloads — the report, in the format it has', () => {
  assert.strictEqual(downloadKeyFor(WITHOUT_WORD),
    'reports/2026-09-08/Ben_UCPK2/daily_report.json');
});

test('and then the button stops claiming to be a Word file', () => {
  assert.strictEqual(downloadLabel(WITHOUT_WORD), 'Download .json',
    'a label that lies about the format is how this defect survived: the '
    + 'download worked, so nobody read the filename');
});

test('an older backend that sends no docx_key at all still works', () => {
  /* The frontend deploys independently of the API. Until the API carries the
     new field, every row looks like WITHOUT_WORD — which must degrade to
     today's behaviour, not to a broken button. */
  const legacy = { key: 'reports/2026-01-01/X/daily_report.json' };
  assert.strictEqual(downloadKeyFor(legacy), legacy.key);
  assert.strictEqual(downloadLabel(legacy), 'Download .json');
});

test('a row with nothing to download yields null rather than presigning undefined', () => {
  assert.strictEqual(downloadKeyFor(null), null);
  assert.strictEqual(downloadKeyFor({}), null);
});

test('the download path and the label are driven by the same function', () => {
  /* They disagreed for the life of the feature. Reading both from one place
     is what stops them drifting apart again. */
  assert.match(SOURCE, /var key = downloadKeyFor\(report\);/,
    'downloadReport must presign the resolved key, not report.key');
  assert.doesNotMatch(SOURCE, /presignedUrl\(report\.key\)/,
    'presigning report.key directly is the bug');
  assert.match(SOURCE, /\}, downloadLabel\(sel\)\),/,
    'the button label must come from the same resolution');
});

test('the File row names the file that will actually come down', () => {
  assert.match(SOURCE, /value: \(downloadKeyFor\(sel\) \|\| ''\)\.split\('\/'\)\.pop\(\)/,
    'showing the .json filename beside a .docx button is the same mismatch '
    + 'in the other direction');
});

test('batch export goes through the same resolution', () => {
  const fn = SOURCE.match(/async function batchExport\([\s\S]*?\n  \}/);
  assert.ok(fn, 'batchExport has moved or been renamed');
  assert.match(fn[0], /downloadReport\(capped\[i\]\)/,
    'the month export must not grow its own copy of the key logic — it would '
    + 'be the one place still shipping JSON');
});
