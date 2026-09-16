'use strict';

/*
 * Two loose ends of "Regenerate your own report".
 *
 * WAIT FOR THE WORD FILE TOO. The generator writes daily_report.json and then
 * daily_report.docx. The panel stopped waiting as soon as the JSON's generated_at
 * moved, so a poll that landed between the two writes declared the report done
 * beside the PREVIOUS generation's Word file -- the Download button and the size
 * shown would be stale. History rows now carry docx_generated_at
 * (fieldsight-pipeline #846); done means both moved. A report with no Word file,
 * or a backend that does not yet send the field, falls back to the JSON alone,
 * so nothing ever waits forever on a field that will not come.
 *
 * AUTHOR. The row's Author was always "—": the listing cannot see who generated a
 * report, but the report file records it (_report_metadata.generated_by: "system"
 * for the schedule, "backfill", or the requester's email since #840). The panel
 * reads it for the caller's OWN report -- the only one it may always open -- and
 * shows "Scheduled" for the schedule's two values.
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
  const constants = (PAGE.match(/  var PENDING_REGEN_KEY = [^\n]*\n  var PENDING_REGEN_TTL_MS = [^\n]*\n/) || [''])[0];
  // eslint-disable-next-line no-new-func
  return new Function(constants + parts.join('\n') + '\nreturn {' + names.join(',') + '};')();
}

const H = lift(['regenerationFinished', 'authorLabel', 'personName',
  'readPendingRegenerations', 'pendingRegenerationFor', 'rememberPendingRegeneration']);

const JSON_BEFORE = '2026-09-11T03:26:49+00:00';
const DOCX_BEFORE = '2026-09-11T03:26:50+00:00';
const JSON_NEW = '2026-09-15T03:09:57+00:00';
const DOCX_NEW = '2026-09-15T03:09:58+00:00';

/* ---- wait for the Word file ------------------------------------------------ */

test('THE test: a new JSON beside the old Word file is not done yet', () => {
  const midway = { generated_at: JSON_NEW, docx_key: 'x.docx', docx_generated_at: DOCX_BEFORE };
  assert.strictEqual(H.regenerationFinished(JSON_BEFORE, midway, DOCX_BEFORE), false);
});

test('done once both files moved', () => {
  const after = { generated_at: JSON_NEW, docx_key: 'x.docx', docx_generated_at: DOCX_NEW };
  assert.strictEqual(H.regenerationFinished(JSON_BEFORE, after, DOCX_BEFORE), true);
});

test('a report with no Word file is done on the JSON alone', () => {
  assert.strictEqual(H.regenerationFinished(JSON_BEFORE, { generated_at: JSON_NEW }, ''), true);
});

test('a backend that does not send docx_generated_at never makes the page wait forever', () => {
  const older = { generated_at: JSON_NEW, docx_key: 'x.docx', docx_size: 40024 };
  assert.strictEqual(H.regenerationFinished(JSON_BEFORE, older, DOCX_BEFORE), true);
});

test('a report that gains its first Word file is done', () => {
  const after = { generated_at: JSON_NEW, docx_key: 'x.docx', docx_generated_at: DOCX_NEW };
  assert.strictEqual(H.regenerationFinished(JSON_BEFORE, after, ''), true);
});

test('the two-argument call still means "the JSON moved"', () => {
  assert.strictEqual(H.regenerationFinished(JSON_BEFORE, { generated_at: JSON_NEW }), true);
  assert.strictEqual(H.regenerationFinished(JSON_BEFORE, { generated_at: JSON_BEFORE }), false);
});

test('the pending record keeps the Word file time across a reload', () => {
  const data = {};
  const s = { getItem: (k) => data[k] || null, setItem: (k, v) => { data[k] = v; } };
  const now = Date.now();
  H.rememberPendingRegeneration(s, 'k', { before: JSON_BEFORE, beforeDocx: DOCX_BEFORE, startedAt: now, folder: 'Ben_UCPK2' });
  assert.strictEqual(H.pendingRegenerationFor(s, 'k', 'Ben_UCPK2', now + 1000).beforeDocx, DOCX_BEFORE);
});

/* ---- author ------------------------------------------------------------------ */

test('the schedule is shown as Scheduled', () => {
  assert.strictEqual(H.authorLabel('system'), 'Scheduled');
  assert.strictEqual(H.authorLabel('backfill'), 'Scheduled');
});

test('THE test: a person is shown by name, never by email address', () => {
  assert.strictEqual(H.authorLabel('benlin.chch+ucpk2@gmail.com', 'Ben_Lin'), 'Ben Lin');
});

test('a value that is already a name is kept', () => {
  assert.strictEqual(H.authorLabel('Ben Lin', 'Ben_Lin'), 'Ben Lin');
});

test('a folder with no last name is not rendered with a trailing space', () => {
  assert.strictEqual(H.authorLabel('someone@example.com', 'Ben_UCPK_'), 'Ben UCPK');
});

test('an address with no folder to name it is a dash, never the address', () => {
  for (const f of [undefined, null, '', '_']) {
    assert.strictEqual(H.authorLabel('someone@example.com', f), '\u2014', String(f));
  }
});

test('nothing known is a dash, never a guess', () => {
  for (const v of [undefined, null, '', '   ', 7, {}]) assert.strictEqual(H.authorLabel(v), '—', String(v));
});

/* ---- wiring ---------------------------------------------------------------------- */

test('the panel passes the Word file time to every completion check', () => {
  const right = PAGE.match(/function ReportsRightDetail\(props\) \{[\s\S]*?\n  \}/)[0];
  const calls = right.match(/regenerationFinished\([^)]*\)/g) || [];
  assert.ok(calls.length >= 2, calls);
  calls.forEach((c) => assert.match(c, /,[^,]+,[^,]+\)$/, 'three arguments: ' + c));
});

test("the panel reads the author from the caller's own report", () => {
  const right = PAGE.match(/function ReportsRightDetail\(props\) \{[\s\S]*?\n  \}/)[0];
  assert.match(right, /React\.useEffect\(authorEffect\(caller, sel, setAuthor\)/);
  const effect = PAGE.match(/function authorEffect\([\s\S]*?\n  \}/)[0];
  assert.match(effect, /canRegenerateReport\(caller, sel\)/, 'own report only');
  assert.match(effect, /authorLabel\(/);
  assert.match(effect, /generated_by/);
  assert.match(effect, /reportFolder\(sel\.key\)/,
    'the author label needs the folder to name the person');
});
