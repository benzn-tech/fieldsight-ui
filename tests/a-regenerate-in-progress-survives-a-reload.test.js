'use strict';

/*
 * A regenerate in progress must still read as in progress after a reload.
 *
 * Reported by the owner on 2026-09-15: click Regenerate, see "Generating your
 * report…", then refresh or go to another page and come back -- and the panel shows
 * the Regenerate button again. The generator is still running, but the screen says
 * nothing happened, so the natural conclusion is that it failed, and the natural
 * next step is to click again and generate a second time.
 *
 * The waiting state lived only in the detail panel's component state. Anything that
 * unmounts the panel lost it: a reload, a route change, selecting another report.
 *
 * So the click is recorded in localStorage, per report key:
 *   {before, startedAt, folder}
 * and the panel resumes from it. Three rules are pinned here:
 *
 *   IT EXPIRES. After 15 minutes -- the generator's own timeout -- a record is not
 *   "still generating", it is stale, and resuming it would show a spinner forever.
 *
 *   IT BELONGS TO THE PERSON WHO CLICKED. A shared browser with a different login
 *   must not see someone else's "Generating…".
 *
 *   IT FINISHES WHILE YOU ARE AWAY. If the report was rewritten after the click,
 *   coming back shows it as done, not as generating.
 *
 * Stated limit: another device or browser does not see it. That needs the server to
 * say a report is in progress, which is a larger change.
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
  assert.ok(constants, 'PENDING_REGEN_KEY / PENDING_REGEN_TTL_MS have moved');
  // eslint-disable-next-line no-new-func
  return new Function(constants + parts.join('\n') + '\nreturn {' + names.join(',') + '};')();
}

const H = lift([
  'readPendingRegenerations', 'pendingRegenerationFor',
  'rememberPendingRegeneration', 'forgetPendingRegeneration', 'regenerationFinished',
]);

function fakeStorage(initial) {
  const data = Object.assign({}, initial || {});
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

const KEY = 'reports/2026-09-03/Ben_UCPK2/daily_report.json';
const BEFORE = '2026-09-11T03:26:49+00:00';
const NOW = 1789400000000;

test('THE test: a click is still pending after the panel is gone', () => {
  const s = fakeStorage();
  H.rememberPendingRegeneration(s, KEY, { before: BEFORE, startedAt: NOW, folder: 'Ben_UCPK2' });
  // ... a reload: nothing in memory, only storage
  const p = H.pendingRegenerationFor(s, KEY, 'Ben_UCPK2', NOW + 60 * 1000);
  assert.ok(p, 'coming back must find the regenerate still in progress');
  assert.strictEqual(p.before, BEFORE);
  assert.strictEqual(p.startedAt, NOW);
});

test('it expires with the generator timeout, never spinning forever', () => {
  const s = fakeStorage();
  H.rememberPendingRegeneration(s, KEY, { before: BEFORE, startedAt: NOW, folder: 'Ben_UCPK2' });
  assert.ok(H.pendingRegenerationFor(s, KEY, 'Ben_UCPK2', NOW + 14 * 60 * 1000));
  assert.strictEqual(H.pendingRegenerationFor(s, KEY, 'Ben_UCPK2', NOW + 16 * 60 * 1000), null);
});

test("another login in the same browser does not see it", () => {
  const s = fakeStorage();
  H.rememberPendingRegeneration(s, KEY, { before: BEFORE, startedAt: NOW, folder: 'Ben_UCPK2' });
  assert.strictEqual(H.pendingRegenerationFor(s, KEY, 'Neil_Blunden', NOW + 1000), null);
  assert.strictEqual(H.pendingRegenerationFor(s, KEY, '', NOW + 1000), null);
});

test('forgetting it clears only that report', () => {
  const s = fakeStorage();
  const other = 'reports/2026-09-02/Ben_UCPK2/daily_report.json';
  H.rememberPendingRegeneration(s, KEY, { before: BEFORE, startedAt: NOW, folder: 'Ben_UCPK2' });
  H.rememberPendingRegeneration(s, other, { before: BEFORE, startedAt: NOW, folder: 'Ben_UCPK2' });
  H.forgetPendingRegeneration(s, KEY);
  assert.strictEqual(H.pendingRegenerationFor(s, KEY, 'Ben_UCPK2', NOW + 1000), null);
  assert.ok(H.pendingRegenerationFor(s, other, 'Ben_UCPK2', NOW + 1000));
});

test('coming back after it finished reads as done, not generating', () => {
  // The panel uses regenerationFinished(pending.before, sel) on resume.
  assert.strictEqual(H.regenerationFinished(BEFORE, { generated_at: '2026-09-15T03:09:57+00:00' }), true);
  assert.strictEqual(H.regenerationFinished(BEFORE, { generated_at: BEFORE }), false);
});

test('unreadable or blocked storage is simply "nothing pending", never a crash', () => {
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('x'); } };
  assert.deepStrictEqual(H.readPendingRegenerations(broken, NOW), {});
  assert.doesNotThrow(() => H.rememberPendingRegeneration(broken, KEY, { before: BEFORE, startedAt: NOW, folder: 'Ben_UCPK2' }));
  assert.doesNotThrow(() => H.forgetPendingRegeneration(broken, KEY));
  assert.deepStrictEqual(H.readPendingRegenerations(fakeStorage({ 'fs.reports.pendingRegenerate': '{not json' }), NOW), {});
  assert.deepStrictEqual(H.readPendingRegenerations(null, NOW), {});
});

/* ---- wiring ---------------------------------------------------------------- */

test('the panel records the click and resumes from the record', () => {
  const right = PAGE.match(/function ReportsRightDetail\(props\) \{[\s\S]*?\n  \}/)[0];
  assert.match(right, /rememberPendingRegeneration\(/, 'the click must be recorded');
  assert.match(right, /pendingRegenerationFor\(/, 'opening the report must resume from the record');
  assert.match(right, /forgetPendingRegeneration\(/, 'done and timeout must clear it');
});

test('the list shows which report is still generating', () => {
  const middle = PAGE.match(/function ReportsMiddleColumn\(props\) \{[\s\S]*?\n  \}/)[0];
  assert.match(middle, /pendingRegenerationFor\(/);
  assert.match(middle, /Generating/);
});
