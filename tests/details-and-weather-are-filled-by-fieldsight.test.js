'use strict';

/*
 * "Report details" and "Weather" are written by FieldSight, not the model
 * (pipeline report_facts; owner, 2026-09-29: the code decides). In the editor
 * they arrive from the module picker, have no layout to choose and no note to
 * give -- the model never sees them, so a note would be a promise nothing
 * keeps.
 *
 * THE test is `a normal section cannot be switched into one the code writes`:
 * doing so would silently take it out of the model's plan.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'library.js'), 'utf8')
  .replace(/\r\n/g, '\n');

// eslint-disable-next-line no-new-func
const CODE_KINDS = new Function(SRC.match(/var CODE_KINDS = \{[^}]*\};/)[0] + ' return CODE_KINDS;')();
// eslint-disable-next-line no-new-func
const KIND_LABEL = new Function(SRC.match(/var KIND_LABEL = \{[\s\S]*?\};/)[0] + ' return KIND_LABEL;')();

function offered(kind) {
  const m = SRC.match(/Object\.keys\(KIND_LABEL\)\.filter\((function \(k\) \{[\s\S]*?\})\)/);
  assert.ok(m, 'the kind options are no longer filtered');
  // eslint-disable-next-line no-new-func
  const f = new Function('CODE_KINDS', 'sec', 'return ' + m[1] + ';')(CODE_KINDS, { kind });
  return Object.keys(KIND_LABEL).filter(f);
}

test('THE: a normal section cannot be switched into one the code writes', () => {
  const opts = offered('narrative');
  assert.ok(!opts.includes('header') && !opts.includes('weather'));
  assert.ok(opts.includes('checklist') && opts.includes('table'));
});

test('a code section still shows its own kind', () => {
  assert.ok(offered('weather').includes('weather'));
  assert.strictEqual(KIND_LABEL.header, 'Report details');
});

test('its layout cannot be changed and it takes no note', () => {
  assert.match(SRC, /disabled:\s+!!CODE_KINDS\[sec\.kind\]/);
  assert.match(SRC, /sec\.module && !CODE_KINDS\[sec\.kind\] && React\.createElement\('label', \{ className: 'fs-library__editor-note' \}/);
});

test('Test render draws both', () => {
  assert.match(SRC, /case 'header':/);
  assert.match(SRC, /case 'weather':/);
});
