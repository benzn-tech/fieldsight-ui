'use strict';
/*
 * SOURCE SCAN, not a behaviour test. app-shell.js cannot be required under
 * Node (no module.exports, reads window.FS.tokens at load), so this pins the
 * two copies of the middle-column rule (JS constants + CSS limits) to each
 * other and to spec 2026-09-15 §9.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const js  = read('scripts', 'app-shell.js');
const css = read('styles', 'app-shell.css');

function jsConst(name) {
  const m = js.match(new RegExp('const ' + name + '\\s*=\\s*(\\d+)'));
  assert.ok(m, name + ' not found in app-shell.js');
  return Number(m[1]);
}
function cssMiddle(prop) {
  const block = css.match(/(^|\n)\.middle-column\s*\{([^}]*)\}/);
  assert.ok(block, '.middle-column block not found');
  const m = block[2].match(new RegExp(prop + ':\\s*(\\d+)px'));
  assert.ok(m, prop + ' not found in the first .middle-column block');
  return Number(m[1]);
}

test('middle column constants are 420 / 360 / 560', () => {
  assert.strictEqual(jsConst('MIDDLE_WIDTH_DEFAULT'), 420);
  assert.strictEqual(jsConst('MIDDLE_WIDTH_MIN'), 360);
  assert.strictEqual(jsConst('MIDDLE_WIDTH_MAX'), 560);
});

test('default lies within [min, max]', () => {
  const d = jsConst('MIDDLE_WIDTH_DEFAULT');
  assert.ok(d >= jsConst('MIDDLE_WIDTH_MIN') && d <= jsConst('MIDDLE_WIDTH_MAX'));
});

test('CSS limits equal the JS limits', () => {
  assert.strictEqual(cssMiddle('min-width'), jsConst('MIDDLE_WIDTH_MIN'));
  assert.strictEqual(cssMiddle('max-width'), jsConst('MIDDLE_WIDTH_MAX'));
});

test('storage key is versioned .v2 so old saved widths are ignored', () => {
  const m = js.match(/middleWidth:\s*'([^']+)'/);
  assert.ok(m);
  assert.ok(m[1].endsWith('.v2'), 'key was ' + m[1]);
});

test('initial read is clamped (DragDivider.read does not clamp)', () => {
  assert.match(js, /dd\.clamp\(\s*dd\.read\(\s*STORAGE_KEYS\.middleWidth/);
});
