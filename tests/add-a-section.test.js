'use strict';

/*
 * A template you can add a section to, and say what the section is for.
 *
 * The editor could rename, reorder and delete. It could not ADD -- so a
 * template was stuck with whichever of four hardcoded starting sets it was
 * created from -- and it could not edit `prompt_hint`, which is the sentence
 * that actually reaches the model. Between them: you could change a template's
 * headings but not what any heading meant, and you could never add one.
 *
 * THE test is `a new section starts empty and cannot be saved empty`.
 *
 * Both halves matter and they pull against each other. A blank section must
 * not be seeded with placeholder wording -- `purpose` IS the prompt, so
 * "Describe this section" would be handed to the model as an instruction and
 * written up in the report. And a blank section must not reach the server,
 * which rejects it, after a round trip, without saying which of nine it meant.
 *
 * So: empty, and refused here, by name.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'pages', 'library.js'), 'utf8')
  .replace(/\r\n/g, '\n');

function lift(name) {
  const m = SRC.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n    \\}'));
  assert.ok(m, name + ' has moved or been renamed');
  // eslint-disable-next-line no-new-func
  return new Function(m[0] + '\nreturn ' + name + ';')();
}

const firstIncomplete = lift('firstIncomplete');

const GOOD = [
  { title: 'Safety', prompt_hint: 'Hazards raised.', children: [] },
  { title: 'Actions', prompt_hint: 'One line each.', children: [] },
];

function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* ---- THE test -------------------------------------------------------------- */

test('THE test: a new section starts empty and cannot be saved empty', () => {
  /* Empty, deliberately: `purpose` is the prompt, so placeholder wording
     would be an instruction the model follows. */
  const src = code(SRC);
  const m = src.match(/function blankSection\(\)[\s\S]*?\n    \}/);
  assert.ok(m, 'blankSection has moved');
  assert.match(m[0], /title: ''/);
  assert.match(m[0], /prompt_hint: ''/);

  /* ...and refused before it can bounce off the server. */
  const gap = firstIncomplete([{ title: '', prompt_hint: '', children: [] }], '');
  assert.ok(gap, 'an empty section must not be saveable');
});

test('save refuses, rather than letting the server refuse', () => {
  const m = code(SRC).match(/function save\(\)[\s\S]*?\n    \}/);
  assert.ok(m, 'save has moved');
  assert.match(m[0], /firstIncomplete/);
  /* Before setSaving: it must not look like it tried. */
  assert.ok(m[0].indexOf('firstIncomplete') < m[0].indexOf('setSaving(true)'));
});

/* ---- which section, by name ------------------------------------------------ */

test('a missing description names the section it belongs to', () => {
  /* "A section is incomplete" across nine of them is a hunt. */
  const gap = firstIncomplete(
    [GOOD[0], { title: 'Weather', prompt_hint: '', children: [] }], '');
  assert.strictEqual(gap.what, 'a description');
  assert.match(gap.where, /Weather/);
});

test('a missing title is reported by position, because it has no name yet', () => {
  const gap = firstIncomplete([GOOD[0], { title: '  ', prompt_hint: 'x', children: [] }], '');
  assert.strictEqual(gap.what, 'a title');
  assert.strictEqual(gap.nth, 2);
});

test('a sub-section is checked too, and carries its parent in the name', () => {
  const gap = firstIncomplete(
    [{ title: 'Works', prompt_hint: 'p',
       children: [{ title: 'Level 1', prompt_hint: '', children: [] }] }], '');
  assert.strictEqual(gap.what, 'a description');
  assert.match(gap.where, /Works/);
  assert.match(gap.where, /Level 1/);
});

test('whitespace is not a description', () => {
  assert.ok(firstIncomplete([{ title: 'S', prompt_hint: '   ', children: [] }], ''));
});

test('a complete template has no gap', () => {
  assert.strictEqual(firstIncomplete(GOOD, ''), null);
});

test('the first offender is the one reported, in order', () => {
  const gap = firstIncomplete([
    GOOD[0],
    { title: 'Second', prompt_hint: '', children: [] },
    { title: 'Third', prompt_hint: '', children: [] },
  ], '');
  assert.match(gap.where, /Second/);
});

/* ---- the controls exist ---------------------------------------------------- */

test('a section can be added, and a sub-section under it', () => {
  const src = code(SRC);
  assert.match(src, /function addSection\(\)/);
  assert.match(src, /function addChild\(p\)/);
  assert.match(SRC, /\+ Add section/);
});

test('the purpose is editable, not just displayed', () => {
  /* It was display-only: headings could change, their meaning could not. */
  const src = code(SRC);
  assert.match(src, /function setHint\(p, val\)/);
  assert.match(src, /fs-library__editor-hint-input/);
});

test('one path walker, not one per field', () => {
  /* rename, setHint, setKind and addChild all edit a nested section. Four
     copies of the recursion is four places to fix when nesting changes. */
  const src = code(SRC);
  assert.match(src, /function editAt\(p, change\)/);
  for (const fn of ['rename', 'setHint', 'setKind', 'addChild']) {
    const m = src.match(new RegExp('function ' + fn + '\\([^)]*\\)[\\s\\S]*?\\n    \\}'));
    assert.ok(m, fn + ' has moved');
    assert.match(m[0], /editAt\(/, fn + ' walks the tree itself instead of using editAt');
  }
});

/* ---- a claim that stopped being true --------------------------------------- */

test('the help text no longer says to re-upload to change a kind', () => {
  /* Wrong twice: the kind is editable in place now, and re-uploading never
     read the file anyway. */
  assert.ok(!/Re-upload to change/.test(code(SRC)));
});
