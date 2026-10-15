'use strict';

/*
 * A checklist report names what was not done (owner, 2026-10-16): items the
 * recording never addressed, and items answered No. Unknown gaps say nothing
 * -- never "All items covered".
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

global.window = global.window || {};
global.window.localStorage = global.window.localStorage || { getItem: () => null, setItem: () => {} };
const cr = require('../scripts/api/checklist-reports.js');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');

const R = { id: 'r1', status: 'done', templateName: 'Pre-pour', checkName: 'level 2', startAt: '10:59:09' };
const G = (nc, f) => ({ notCovered: Array(nc).fill({ n: 1, text: 'x', checklist: 'P' }),
                        failed: Array(f).fill({ n: 2, text: 'y', checklist: 'P' }) });

test('THE a done report says how many items were not covered and failed', () => {
  assert.strictEqual(cr.gapWords(Object.assign({}, R, { gaps: G(3, 2) })), '3 not covered · 2 failed');
  assert.strictEqual(cr.gapWords(Object.assign({}, R, { gaps: G(1, 0) })), '1 not covered');
  assert.strictEqual(cr.gapWords(Object.assign({}, R, { gaps: G(0, 1) })), '1 failed');
});

test('nothing missing is said only when the gaps are known', () => {
  assert.strictEqual(cr.gapWords(Object.assign({}, R, { gaps: G(0, 0) })), 'All items covered');
  assert.strictEqual(cr.gapWords(Object.assign({}, R, { gaps: null })), '');
  assert.strictEqual(cr.gapWords(R), '');
  assert.strictEqual(cr.gapWords(Object.assign({}, R, { status: 'pending', gaps: G(3, 0) })), '');
});

test('the day card and the bell both show the gap words', () => {
  assert.match(read('scripts', 'pages', 'timeline.js'), /gapWords\(/);
  assert.match(read('scripts', 'composites', 'notification-bell.js'), /gapWords\(/);
  assert.match(read('styles', 'composites.css'), /\.fs-checklist-reports__gaps/);
});
