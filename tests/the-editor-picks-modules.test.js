'use strict';

/*
 * The Library editor builds a report from modules (pipeline report_modules;
 * owner, 2026-09-30): "+ Add section" offers the modules, a module section's
 * wording is shown and fixed, the customer adds one note, and a custom section
 * that looks like a module is OFFERED the switch, never converted.
 *
 * THE test is `a module section keeps its module and note through the save
 * mapping`. This file's editor has twice dropped a field it could set -- the
 * page kept showing it, only the report disagreed -- and a module section
 * saved without `module` would become a custom section carrying a stale copy
 * of our text that no wording update ever reaches.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'library.js'), 'utf8')
  .replace(/\r\n/g, '\n');
const STORE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'api', 'template-store.js'), 'utf8')
  .replace(/\r\n/g, '\n');

function lift(names, prelude) {
  const parts = names.map((n) => {
    const start = SRC.indexOf('\n  function ' + n + '(');
    assert.ok(start >= 0, n + ' has moved or been renamed');
    const end = SRC.indexOf('\n  }\n', start);
    const m = [SRC.slice(start, end + 5)];
    assert.ok(m, n + ' has moved or been renamed');
    return m[0];
  });
  // eslint-disable-next-line no-new-func
  return new Function((prelude || '') + parts.join('\n') + '\nreturn {' + names.join(',') + '};')();
}

const STOP = SRC.match(/var MODULE_STOP_WORDS = \{[\s\S]*?\};/)[0];
const { sectionsToSchema } = lift(['sectionsToSchema']);
const { suggestModule } = lift(['titleWords', 'suggestModule'], STOP + '\n');

const MODULES = [
  { key: 'summary', title: 'Daily Summary' },
  { key: 'work_done', title: 'Work Completed' },
  { key: 'safety', title: 'Safety' },
  { key: 'decisions', title: 'Decisions' },
  { key: 'actions', title: 'Actions' },
  { key: 'deliveries_plant', title: 'Deliveries & Plant' },
];

test('THE a module section keeps its module and note through the save mapping', () => {
  const out = sectionsToSchema([{ title: 'Safety', kind: 'list', fields: [], prompt_hint: 'Our text',
    columns: [], module: { key: 'safety', hash: 'abc123' }, note: '  If nothing, write NO DATA TODAY.  ',
    _key: 3 }]);
  assert.deepStrictEqual(out.sections[0].module, { key: 'safety', hash: 'abc123' });
  assert.strictEqual(out.sections[0].note, 'If nothing, write NO DATA TODAY.');
  assert.ok(!('_key' in out.sections[0]));
});

test('a custom section carries no module and no empty note', () => {
  const out = sectionsToSchema([{ title: 'Our own', kind: 'narrative', prompt_hint: 'x', note: '   ' }]);
  assert.ok(!('module' in out.sections[0]) && !('note' in out.sections[0]));
});

test('the editor state keeps module and note when a template is opened', () => {
  const init = SRC.slice(SRC.indexOf('function tagKeys(arr)'), SRC.indexOf('return tagKeys(schema.sections'));
  assert.match(init, /module:\s+s\.module \|\| null/);
  assert.match(init, /note:\s+s\.note \|\| ''/);
});

test('a section that looks like a module is offered it', () => {
  assert.strictEqual(suggestModule('Safety Notes', MODULES).key, 'safety');
  assert.strictEqual(suggestModule('Key Decisions', MODULES).key, 'decisions');
  assert.strictEqual(suggestModule('Open Actions', MODULES).key, 'actions');
  assert.strictEqual(suggestModule('Daily Summary', MODULES).key, 'summary');
});

test('generic words and short near-misses offer nothing', () => {
  assert.strictEqual(suggestModule('Daily Notes', MODULES), null);
  assert.strictEqual(suggestModule('Plan', MODULES), null, 'plan is not plant');
  assert.strictEqual(suggestModule('', MODULES), null);
});

test('the offer switches only on a click, and keeps the title and format', () => {
  const use = SRC.slice(SRC.indexOf('function useModule(p, m)'), SRC.indexOf('function setNote(p, val)'));
  assert.match(use, /prompt_hint: m\.purpose, module: \{ key: m\.key, hash: m\.hash \}/);
  assert.ok(!/title:|kind:/.test(use), 'title and format are the customer’s');
  assert.match(SRC, /onClick: function \(\) \{ useModule\(p, m\); \}/);
});

test('a module section shows its wording read-only and offers a note', () => {
  assert.match(SRC, /sec\.module\s*\n?\s*\? React\.createElement\('p', \{ className: 'fs-library__editor-module-text' \}/);
  assert.match(SRC, /'aria-label': 'Note for this section'/);
});

test('+ Add section offers the modules, custom last, and falls back to custom offline', () => {
  assert.match(SRC, /if \(\(modules\.modules \|\| \[\]\)\.length\) setPicking\(!picking\); else addSection\(\);/);
  const picker = SRC.slice(SRC.indexOf("className: 'fs-library__module-picker'"));
  assert.ok(picker.indexOf('addModule(m)') < picker.indexOf("'Custom section'"));
});

test('the store asks org-api for the company’s modules', () => {
  assert.match(STORE, /api\(\)\.orgRequest\('\/templates\/modules'\)/);
  assert.match(STORE, /listModules:\s+listModules,/);
});
