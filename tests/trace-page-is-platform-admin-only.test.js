'use strict';

/*
 * /trace shows what the pipeline did with every customer's recordings (owner,
 * 2026-10-05), so ONLY the platform admin sees it. A company admin also has
 * isAdmin=true -- which passes every permission check -- so the nav must
 * check the role itself, not the permission.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');

global.window = global.window || {};
require('../scripts/fs-globals.js');
const FS = global.window.FS;

global.window.FieldSight = global.window.FieldSight || {};
const page = require('../scripts/pages/trace.js');

test('THE only the platform admin sees Trace', () => {
  assert.strictEqual(FS.canSeeNav('trace', { role: 'platform_admin', isAdmin: true }), true);
  assert.strictEqual(FS.canSeeNav('trace', { role: 'admin', isAdmin: true }), false,
    'a company admin passes every permission -- the role is what decides');
  assert.strictEqual(FS.canSeeNav('trace', { role: 'gm' }), false);
  assert.strictEqual(FS.canSeeNav('trace', 'platform_admin'), false, 'a bare role string is not a session');
});

test('every other nav item is unchanged for a company admin', () => {
  assert.strictEqual(FS.canSeeNav('settings', { role: 'admin', isAdmin: true }), true);
  assert.strictEqual(FS.canSeeNav('library', { role: 'admin', isAdmin: true }), true);
});

test('it is in the nav, with an icon, and the page is loaded', () => {
  const nav = read('scripts', 'left-nav.js');
  assert.match(nav, /items: \['sites', 'team', 'trace'\]/);
  assert.match(nav, /trace:\s+'list-tree'/);
  assert.match(read('app-shell-preview.html'), /scripts\/pages\/trace\.js\?v=\d+/);
  assert.strictEqual(FS.NAV_ITEMS.trace.path, '/trace');
  assert.ok(global.window.FieldSight.PAGES['/trace'].Middle);
});

test('it asks the pipeline for the day and the funnel', () => {
  const org = read('scripts', 'api', 'org.js');
  assert.match(org, /api\.orgRequest\('\/trace\/day', \{ params: \{ date: opts\.date, folder: opts\.folder \|\| undefined \} \}\)/);
  assert.match(org, /api\.orgRequest\('\/trace\/funnel', \{ params: \{ from: opts\.from, to: opts\.to \} \}\)/);
  assert.match(org, /getTraceDay: getTraceDay,/);
  assert.match(org, /getTraceFunnel: getTraceFunnel,/);
});

test('a step reads as one line, in New Zealand time', () => {
  assert.strictEqual(page.detailLine({ pass: 'final', topics: 4, dropped: [], site: null }),
    'pass final · topics 4');
  assert.strictEqual(page.detailLine({ topic: { id: 't1', title: 'Level 1' } }), 'topic Level 1');
  assert.strictEqual(page.nzTime('2026-10-04T22:02:08.000+00:00'), '11:02:08');
  assert.strictEqual(page.daysBefore('2026-10-05', 6), '2026-09-29');
});

test('the page counts nothing itself: every funnel number is the pipeline\'s', () => {
  const src = read('scripts', 'pages', 'trace.js');
  for (const c of page.FUNNEL_COLUMNS) {
    assert.ok(typeof c[1] === 'function');
  }
  assert.ok(!/\.filter\(function \(e\) \{ return e\.step/.test(src), 'no counting of events in the page');
});
