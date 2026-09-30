'use strict';

/*
 * A checklist section carries the customer's own questions (pipeline
 * checklist.py; owner, 2026-09-30). The server answers only what the
 * recording addressed and rebuilds the table in the customer's order.
 *
 * THE test is `a checklist keeps its items through the save mapping`. This
 * editor has dropped fields it could set before -- the page kept showing them,
 * only the report disagreed. A checklist saved without `items` is refused by
 * the server, so the person would be told off for a list they can see.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'library.js'), 'utf8')
  .replace(/\r\n/g, '\n');

function lift(name) {
  const start = SRC.indexOf('\n  function ' + name + '(');
  assert.ok(start >= 0, name + ' has moved or been renamed');
  const end = SRC.indexOf('\n  }\n', start);
  // eslint-disable-next-line no-new-func
  return new Function(SRC.slice(start, end + 5) + '\nreturn ' + name + ';')();
}

const sectionsToSchema = lift('sectionsToSchema');

test('THE: a checklist keeps its items through the save mapping, tidied', () => {
  const out = sectionsToSchema([{ title: 'Site Amenities', kind: 'checklist', prompt_hint: 'p',
    items: ['  Is rubbish cleared? ', '', 'Is the lunchroom tidy?', '   '] }]);
  assert.deepStrictEqual(out.sections[0].items, ['Is rubbish cleared?', 'Is the lunchroom tidy?']);
});

test('a sub-section checklist keeps its items too', () => {
  const out = sectionsToSchema([{ title: 'Inspection', kind: 'narrative', prompt_hint: 'p',
    children: [{ title: 'Fire', kind: 'checklist', prompt_hint: 'p', items: ['Extinguishers?'] }] }]);
  assert.deepStrictEqual(out.sections[0].children[0].items, ['Extinguishers?']);
});

test('a section that is not a checklist sends no items', () => {
  const out = sectionsToSchema([{ title: 'Summary', kind: 'narrative', prompt_hint: 'p', items: ['left over'] }]);
  assert.strictEqual('items' in out.sections[0], false);
});

test('the editor loads items back and offers the kind', () => {
  assert.match(SRC, /items:\s+s\.items \|\| \[\],/);
  assert.match(SRC, /checklist: 'Checklist'/);
});

test('typing keeps blank lines so Enter can start the next item', () => {
  assert.match(SRC, /items: \(val \|\| ''\)\.split\('\\n'\)/);
});
