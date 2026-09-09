'use strict';

/*
 * `Cannot read properties of null (reading 'lat')` — /today, in production,
 * minutes after the weather change shipped.
 *
 * The weather effect opens with `if (!coord || !selectedDate) return;`, and
 * that guard is correct. It is also unreachable, because the effect's
 * DEPENDENCY ARRAY is evaluated during render:
 *
 *     }, [coord.lat, coord.lng, selectedDate, isHistorical]);
 *
 * React never got as far as the body. `coord === null` is the state the same
 * change introduced — a selected project with no coordinate, which is five of
 * the eight projects in production — so the crash was reachable on the first
 * page load for most customers.
 *
 * The lesson generalises past this one line: a guard inside an effect says
 * nothing about the expressions React evaluates to decide whether to run it.
 * These tests evaluate the real dependency expressions, extracted from the
 * real file, against the null they now have to survive.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs
  .readFileSync(path.join(__dirname, '..', 'scripts', 'app-shell.js'), 'utf8')
  .replace(/\r\n/g, '\n');

/* Pull every dependency array in the file that mentions `coord`, and evaluate
   it for real with coord = null. Extracting rather than restating is the
   point: a test that hard-codes the expression passes while the file drifts. */
function coordDependencyArrays() {
  const out = [];
  const re = /\},\s*(\[[^\]]*coord[^\]]*\])\s*\)\s*;/g;
  let m;
  while ((m = re.exec(SOURCE)) !== null) out.push(m[1]);
  return out;
}

test('the file still has the dependency arrays this test exists to protect', () => {
  const arrays = coordDependencyArrays();
  assert.ok(arrays.length > 0,
    'found no coord-bearing dependency array — a scan that finds nothing '
    + 'also reports no failures, so this assertion is what keeps the rest '
    + 'of this file meaningful');
});

test('every coord dependency array survives a null coord', () => {
  const arrays = coordDependencyArrays();
  arrays.forEach(function (expr) {
    // eslint-disable-next-line no-new-func
    const evaluate = new Function('coord', 'selectedDate', 'isHistorical',
      'return ' + expr + ';');
    assert.doesNotThrow(function () { evaluate(null, '2026-09-09', false); },
      'this dependency array throws when the project cannot be placed, and it '
      + 'is evaluated during render — before the guard inside the effect can '
      + 'run:\n    ' + expr);
  });
});

test('a placed project still produces the values the effect keys on', () => {
  const arrays = coordDependencyArrays();
  const placed = { lat: -36.8521, lng: 174.7632, source: 'location', place: 'Auckland' };
  arrays.forEach(function (expr) {
    // eslint-disable-next-line no-new-func
    const evaluate = new Function('coord', 'selectedDate', 'isHistorical',
      'return ' + expr + ';');
    const deps = evaluate(placed, '2026-09-09', false);
    assert.ok(deps.indexOf(-36.8521) !== -1 && deps.indexOf(174.7632) !== -1,
      'the null-safety must not cost the effect its actual dependencies — '
      + 'a coordinate change has to still re-run the fetch:\n    ' + expr);
  });
});

test('an unplaceable project and a placed one produce different dependencies', () => {
  const arrays = coordDependencyArrays();
  arrays.forEach(function (expr) {
    // eslint-disable-next-line no-new-func
    const evaluate = new Function('coord', 'selectedDate', 'isHistorical',
      'return ' + expr + ';');
    const a = JSON.stringify(evaluate(null, '2026-09-09', false));
    const b = JSON.stringify(evaluate({ lat: 1, lng: 2 }, '2026-09-09', false));
    assert.notStrictEqual(a, b,
      'switching from a project with no location to one with a location must '
      + 'still re-run the effect:\n    ' + expr);
  });
});

/* The reads inside the effect body are a different question: they sit after
   the guard and are allowed to assume a coord. This pins that they stay
   there, because moving one above the guard would reintroduce the crash in a
   place the tests above cannot see. */
test('the guard is still the first statement in the weather effect', () => {
  const body = SOURCE.match(
    /React\.useEffect\(function\(\) \{\n(\s*)if \(!coord \|\| !selectedDate\)/);
  assert.ok(body,
    'the weather effect must still open with its coord guard — every '
    + 'coord.lat / coord.lng read in the body depends on it');
});
