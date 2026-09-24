'use strict';

/*
 * A section added by hand could never be saved, and the reason was CSS.
 *
 * The owner added a section, got "Section 6 needs a title before this can be
 * saved", and reported that there was no title field -- only a description box.
 * The field was in the DOM the whole time. It was zero pixels wide.
 *
 * `.fs-library__editor-section` is `display:flex` with no `flex-wrap`, so every
 * child competes for one line. The description row below it asks for
 * `width:100%`, and wins. The title input (`flex:1; min-width:0`) collapses to
 * nothing between the kind icon and the + button -- exactly what the screenshot
 * showed.
 *
 * The comment above `.fs-library__editor-section-hint` has said "the purpose
 * sits on its own line under the heading" since the day it was written. It was
 * describing an intention, not the page.
 *
 * THE test is `the section row wraps`. It is a CSS assertion, which is normally
 * a weak kind of test -- but the failure here was invisible to every behavioural
 * test that could be written, because the element existed, held its value, and
 * fired its onChange. Nothing was broken except that nobody could see it or
 * reach it with a mouse.
 *
 * Also pinned here: the error message a failed save shows. "Section 6" was not
 * enough to act on twice over -- a counting exercise on a long template, and
 * simply wrong for a sub-section, where the index counted within its own
 * parent and so pointed at a different row than it named.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'styles', 'composites.css'), 'utf8').replace(/\r\n/g, '\n');
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'pages', 'library.js'), 'utf8').replace(/\r\n/g, '\n');

function rule(selector) {
  const i = CSS.indexOf(selector + ' {');
  assert.ok(i >= 0, selector + ' has moved or been renamed');
  return CSS.slice(i, CSS.indexOf('}', i));
}

/* ---- THE test -------------------------------------------------------------- */

test('THE test: the section row wraps, so the title field has width', () => {
  const row = rule('.fs-library__editor-section');
  assert.match(row, /flex-wrap:\s*wrap/,
    'without this the description’s width:100% squeezes the title input to zero');
  assert.match(row, /display:\s*flex/);
});

test('the rows that want their own line ask for the whole width', () => {
  for (const sel of ['.fs-library__editor-section-hint',
    '.fs-library__editor-always',
    '.fs-library__editor-columns']) {
    assert.match(rule(sel), /width:\s*100%/, sel + ' must claim its own line');
  }
});

test('the title input is still there and still says what it is for', () => {
  assert.match(SRC, /'aria-label': 'Section title'/);
  assert.match(SRC, /placeholder: 'Section heading'/);
});

/* ---- pointing at the section that blocked the save ------------------------- */

test('a failed save names a sub-section by its parent, not by a bare number', () => {
  assert.match(SRC, /section under/,
    'a number alone counts within the parent and names the wrong row');
  assert.match(SRC, /function ordinal\(/);
});

test('the row carries its path so the page can scroll to it and flag it', () => {
  assert.match(SRC, /'data-section-path': p/);
  assert.match(SRC, /fs-library__editor-section--flagged/);
  assert.match(SRC, /scrollIntoView/);
  assert.ok(rule('.fs-library__editor-section--flagged').includes('border-color'));
});

test('typing in the flagged row clears the flag', () => {
  /* Otherwise the highlight outlives the problem and starts lying. */
  assert.match(SRC, /if \(flagged === p\) setFlagged\(null\);/);
});

/* ---- the columns control --------------------------------------------------- */

test('columns are offered only for a table', () => {
  assert.match(SRC, /\(sec\.kind === 'table'\) && React\.createElement\('label'/);
});

test('the placeholder shows the fallback rather than an invented example', () => {
  /* Item | Assigned | Due is what the stop-recording email and the Actions
     table already print. An example nobody uses would teach the wrong shape. */
  assert.match(SRC, /placeholder: 'Item \| Assigned \| Due'/);
});

test('columns survive the round trip through sectionsToSchema', () => {
  const m = SRC.match(/function sectionsToSchema\([\s\S]*?\n  \}/);
  assert.ok(m, 'sectionsToSchema has moved');
  // eslint-disable-next-line no-new-func
  const sectionsToSchema = new Function(m[0] + '\nreturn sectionsToSchema;')();
  const out = sectionsToSchema([{
    title: 'Open Actions', kind: 'table', fields: [], prompt_hint: 'Outstanding tasks',
    always_present: false, columns: ['Task', 'Trade'], children: [],
  }]);
  assert.deepStrictEqual(out.sections[0].columns, ['Task', 'Trade']);
});

test('a section with no columns sends an empty list, not undefined', () => {
  const m = SRC.match(/function sectionsToSchema\([\s\S]*?\n  \}/);
  // eslint-disable-next-line no-new-func
  const sectionsToSchema = new Function(m[0] + '\nreturn sectionsToSchema;')();
  const out = sectionsToSchema([{ title: 'A', kind: 'list', prompt_hint: 'b' }]);
  assert.deepStrictEqual(out.sections[0].columns, []);
});
