'use strict';

/*
 * The report dialog renders classes that some stylesheet actually defines.
 *
 * It shipped without one. The session-report modal was added as "review modal
 * shell + logic core", and of the 36 classes it rendered, 27 had never had a
 * rule anywhere in this repo. The owner saw one step of it and reported that
 * "the styles did not load"; every step was unstyled, and had been since it
 * shipped. Nothing noticed, because nothing can: a class with no rule is not
 * an error to a browser, a linter, or a test that checks behaviour.
 *
 * Two of the gaps were not missing CSS at all but the wrong names:
 *
 *   `fs-input` on every input -- a class that does not exist. The design
 *   system's control is `.fs-field__control`, which already handles focus,
 *   disabled and dark mode.
 *
 *   `fs-btn` with no size, and for every non-primary button no variant. The
 *   design system's own Button always composes BOTH (components/button.js),
 *   and `.fs-btn` alone carries neither a height nor a background -- so every
 *   Back, Cancel and Close rendered as a bare label.
 *
 * THE test is `every class the dialog renders has a rule`. It reads the classes
 * out of the source and the rules out of every stylesheet, which is crude, and
 * it is the only kind of check that would have failed: the elements existed,
 * held their values and fired their handlers. Nothing was broken except that
 * nobody could see it -- the same shape as the Library's title input, which
 * sat in the DOM at zero pixels wide.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(ROOT, 'scripts', 'composites', 'session-report-modal.js'), 'utf8');

const CSS = fs.readdirSync(path.join(ROOT, 'styles'))
  .filter(function (f) { return f.endsWith('.css'); })
  .map(function (f) { return fs.readFileSync(path.join(ROOT, 'styles', f), 'utf8'); })
  .join('\n');

/* Hooks that deliberately carry no rule of their own: the element is fully
   styled by the design-system classes beside them, and the name is there for
   a test or a future selector to find. Each one is an explicit decision --
   adding a name here means saying so. */
const HOOK_ONLY = new Set([
  'fs-srm__template', // on a .fs-field--md .fs-field--full-width, styled there
  // Step identifiers. Each sits on a container that also carries
  // .fs-srm__step, which is what lays it out; the name says WHICH step, for a
  // selector that needs one. Giving them an empty rule would satisfy this test
  // and mean nothing.
  'fs-srm__preview',
  'fs-srm__review',
  'fs-srm__done',
]);

/* A note on how this was found. The shell count done while fixing this said
   one class was left, using grep's \b as the word boundary -- and \b matches
   between a letter and a hyphen, so `.fs-srm__preview-photos` counted as a rule
   for `.fs-srm__preview`. This file's check refuses a following hyphen, and
   found three more. The weaker tool had given the answer that looked finished. */

function renderedClasses(src) {
  const out = new Set();
  const re = /className:\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(src))) {
    m[1].split(/\s+/).filter(Boolean).forEach(function (c) { out.add(c); });
  }
  // The helper composes these at runtime; the forms it can produce are listed.
  ['fs-btn--sm', 'fs-btn--md', 'fs-btn--primary', 'fs-btn--secondary']
    .forEach(function (c) { out.add(c); });
  return out;
}

function hasRule(cls) {
  const escaped = cls.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp('\\.' + escaped + '(?![\\w-])').test(CSS);
}

/* ---- THE test -------------------------------------------------------------- */

test('THE test: every class the dialog renders has a rule', () => {
  const missing = [];
  renderedClasses(SRC).forEach(function (c) {
    if (!HOOK_ONLY.has(c) && !hasRule(c)) missing.push(c);
  });
  assert.deepStrictEqual(missing, [],
    'classes the report dialog renders that no stylesheet defines');
});

/* ---- the two that were the wrong name, not missing CSS ------------------- */

test('no input uses a class that does not exist', () => {
  assert.ok(!/['\s]fs-input['\s]/.test(SRC),
    '`fs-input` has never been defined; the design system uses .fs-field__control');
  assert.ok(!hasRule('fs-input'), 'if it now exists, this test is stale');
});

test('every button carries a variant AND a size', () => {
  const m = SRC.match(/function btn\([\s\S]*?\n    \}/);
  assert.ok(m, 'btn() has moved');
  assert.match(m[0], /fs-btn--' \+ \(size \|\| 'md'\)/);
  assert.match(m[0], /fs-btn--' \+ \(variant \|\| 'secondary'\)/);
});

test('the inline Generate button is sized like the rest of the footer', () => {
  assert.match(SRC, /className: 'fs-btn fs-btn--md fs-btn--primary'/);
});

test('the design-system classes it now leans on do exist', () => {
  for (const c of ['fs-field__control', 'fs-field--md', 'fs-field--full-width',
    'fs-field__control--textarea', 'fs-btn--md', 'fs-btn--sm',
    'fs-btn--primary', 'fs-btn--secondary']) {
    assert.ok(hasRule(c), c + ' is what the dialog now relies on');
  }
});

test('a hook-only class is not quietly hiding a missing rule', () => {
  /* Each entry is a decision. If one of them grows a rule, it no longer needs
     to be here -- and leaving it would let a real gap hide behind it later. */
  HOOK_ONLY.forEach(function (c) {
    assert.ok(!hasRule(c), c + ' has a rule now; take it off HOOK_ONLY');
    assert.ok(renderedClasses(SRC).has(c), c + ' is no longer rendered');
  });
});
