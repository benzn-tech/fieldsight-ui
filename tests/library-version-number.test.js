'use strict';

/*
 * The version number the Library shows is the template's version number.
 *
 * A template on its fourth edit read "Version 1 · updated 23 Sep", with four
 * versions in its history and the "Current" badge on the oldest of them.
 *
 * Three symptoms, one shape, and the same shape as everything else that broke
 * today: the localStorage store kept versions in an array it APPENDED to --
 * oldest first -- and the server returns them ORDER BY version DESC. The array
 * looked identical. Only the order changed, and three separate lines were
 * reading position as if it meant something:
 *
 *   'Version ' + sel.versions.length   -- counts what the response carried,
 *                                         and `get` carries only the current
 *                                         one, so it said 1 forever
 *   vers[vers.length - 1]              -- "newest" when appended, oldest now
 *   .slice().reverse()                 -- under a comment saying "display
 *                                         newest-first", which is what it had
 *                                         stopped doing
 *   idx === 0                          -- after that reverse, the oldest row
 *
 * Every version carries its own number. Reading it makes all four lines say
 * what they mean and stop having an opinion about the order they arrive in.
 *
 * THE test is `a template on its fourth version does not say Version 1`.
 *
 * WHAT WAS NOT BROKEN, checked before changing anything: the version SENT when
 * generating comes from list()'s `current_version`, not from this array, so
 * reports were never written to the wrong version. Display only.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'pages', 'library.js'), 'utf8')
  .replace(/\r\n/g, '\n');

function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function lift(name) {
  const m = SRC.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n  \\}'));
  assert.ok(m, name + ' has moved or been renamed');
  // eslint-disable-next-line no-new-func
  return new Function(m[0] + '\nreturn ' + name + ';')();
}

const newestVersion = lift('newestVersion');
const activeSchema = (function () {
  const a = SRC.match(/function newestVersion\([\s\S]*?\n  \}/)[0];
  const b = SRC.match(/function activeSchema\([\s\S]*?\n  \}/)[0];
  // eslint-disable-next-line no-new-func
  return new Function(a + '\n' + b + '\nreturn activeSchema;')();
})();

/* As the server sends them: newest first. */
const NEWEST_FIRST = [
  { id: 'v-4', version: 4, created_at: '2026-09-23', schema: { sections: [{ title: 'Newest' }] } },
  { id: 'v-3', version: 3, created_at: '2026-09-23', schema: { sections: [{ title: 'Third' }] } },
  { id: 'v-2', version: 2, created_at: '2026-09-23', schema: { sections: [{ title: 'Second' }] } },
  { id: 'v-1', version: 1, created_at: '2026-09-22', schema: { sections: [{ title: 'Oldest' }] } },
];

/* ---- THE test -------------------------------------------------------------- */

test('THE test: a template on its fourth version does not say Version 1', () => {
  /* `get` sends the current version and nothing else -- one element -- so the
     line that counted the array said 1 however many edits had happened. */
  const fromGet = { current_version: 4, versions: [NEWEST_FIRST[0]] };
  const shown = code(SRC).match(/'Version ' \+ \(([^)]*)\)/);
  assert.ok(shown, 'the version line has moved');
  assert.ok(!/versions\.length/.test(shown[1]),
    'the version number must not be the length of the array');

  // eslint-disable-next-line no-new-func
  const render = new Function('sel', 'ver', 'return ' + shown[1] + ';');
  assert.strictEqual(render(fromGet, NEWEST_FIRST[0]), 4);
});

/* ---- position means nothing now -------------------------------------------- */

test('the newest version is found by number, whichever order they arrive in', () => {
  const asc = NEWEST_FIRST.slice().reverse();
  assert.strictEqual(newestVersion({ versions: NEWEST_FIRST }).version, 4);
  assert.strictEqual(newestVersion({ versions: asc }).version, 4);
  assert.strictEqual(newestVersion({ versions: [NEWEST_FIRST[2]] }).version, 2);
});

test('the schema shown is the newest one, not the first in the array', () => {
  /* The bug that would have been worst: editing, and generating from, the
     oldest body while everything looked right. */
  assert.strictEqual(
    activeSchema({ versions: NEWEST_FIRST }).sections[0].title, 'Newest');
  assert.strictEqual(
    activeSchema({ versions: NEWEST_FIRST.slice().reverse() }).sections[0].title, 'Newest');
});

test('no versions is no schema, not a crash', () => {
  assert.strictEqual(activeSchema({ versions: [] }), null);
  assert.strictEqual(activeSchema({}), null);
  assert.strictEqual(newestVersion(null), null);
});

/* ---- the history panel ------------------------------------------------------ */

test('the history sorts by number instead of reversing', () => {
  /* Reversing was right when the list arrived oldest-first and became wrong
     the day the server started sending it newest-first -- silently, because
     an array of versions still looked like an array of versions. */
  const src = code(SRC);
  assert.ok(!/\.slice\(\)\.reverse\(\)/.test(src), 'the reverse is back');
  assert.match(src, /\(b\.version \|\| 0\) - \(a\.version \|\| 0\)/);
});

test('"Current" is the highest number, not the first row', () => {
  const src = code(SRC);
  const m = src.match(/var isLatest\s*=\s*[\s\S]*?;/);
  assert.ok(m, 'isLatest has moved');
  assert.ok(!/idx === 0/.test(m[0]), 'position is back');
  assert.match(m[0], /Math\.max/);
});

/* ---- what was never broken -------------------------------------------------- */

test('generating still takes its version from the server’s own number', () => {
  /* Checked before changing anything, and worth keeping: reports were never
     written to the wrong version, because the chooser reads current_version
     off the list row rather than counting this array. Had that not been true,
     this would have been a data fault rather than a display one. */
  const store = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'api', 'template-store.js'), 'utf8');
  assert.match(store, /version: t\.current_version/);
});
