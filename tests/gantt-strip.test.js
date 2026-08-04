'use strict';

/*
 * The Gantt date strip's range maths.
 *
 * This had no coverage at all until it took prod down: the file attached to
 * `window` unconditionally, so it could not be required. The defect it hid:
 *
 *   dateRangeISO(null, null) walked into addDaysISO(null, 1) and threw
 *   `Cannot read properties of null (reading 'split')`, which — with no error
 *   boundary anywhere in the app — unmounted the whole React tree. White
 *   screen, no nav, no way back.
 *
 * The coercion that made it reachable is the opposite of the intuition, and
 * is the first thing asserted below: ONE null makes `c <= to` false and the
 * loop never runs, so the half-broken input was safe. BOTH null compares
 * 0 <= 0, which is TRUE, enters the loop, and throws. That is why a
 * truthiness check would not have been enough and the range is validated for
 * what it must be.
 */
const test = require('node:test');
const assert = require('node:assert');

/* The module reads addDaysISO off the global at call time. Provide the real
   implementation from api/index.js's contract — UTC arithmetic, no
   `new Date('YYYY-MM-DD')`, per BUG-19. */
global.window = {
  FS: { api: { addDaysISO: function (iso, days) {
    const p = iso.split('-').map(Number);
    const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
    return d.toISOString().slice(0, 10);
  } } },
};

const { dateRangeISO, isUsableRange } = require('../scripts/composites/gantt-strip.js');

/* ---- the crash that shipped ---------------------------------------------- */

test('a null range returns empty instead of throwing', () => {
  /* The prod stack, exactly: from = null, to = null. */
  assert.deepStrictEqual(dateRangeISO(null, null), []);
});

test('the asymmetry that hid it: one null was always safe, two were not', () => {
  /* Both of these were already harmless before the fix — which is why the
     bug survived every site whose programme had a start but no end. */
  assert.deepStrictEqual(dateRangeISO(null, '2026-01-05'), []);
  assert.deepStrictEqual(dateRangeISO('2026-01-01', null), []);
  /* And this is the one that crashed. */
  assert.deepStrictEqual(dateRangeISO(null, null), []);
});

test('undefined and empty string are refused too', () => {
  assert.deepStrictEqual(dateRangeISO(undefined, undefined), []);
  assert.deepStrictEqual(dateRangeISO('', ''), []);
});

/* ---- what a range must be ------------------------------------------------- */

test('a valid range walks every calendar day, inclusive of both ends', () => {
  assert.deepStrictEqual(dateRangeISO('2026-01-30', '2026-02-02'),
    ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
});

test('a single-day range is one day, not zero', () => {
  assert.deepStrictEqual(dateRangeISO('2026-03-09', '2026-03-09'), ['2026-03-09']);
});

test('an end before its start is refused rather than looping forever', () => {
  assert.deepStrictEqual(dateRangeISO('2026-05-10', '2026-05-01'), []);
});

test('a Date object or a timestamp is not an ISO range', () => {
  assert.strictEqual(isUsableRange(new Date('2026-01-01'), new Date('2026-01-05')), false);
  assert.strictEqual(isUsableRange(1767225600000, 1767571200000), false);
  assert.strictEqual(isUsableRange('2026-1-1', '2026-1-5'), false);   /* unpadded */
  assert.strictEqual(isUsableRange('2026-01-01T00:00:00Z', '2026-01-05T00:00:00Z'), false);
});

test('isUsableRange accepts exactly what dateRangeISO can walk', () => {
  assert.strictEqual(isUsableRange('2026-01-01', '2026-01-05'), true);
  assert.strictEqual(isUsableRange('2026-01-01', '2026-01-01'), true);
});

/* ---- it must not depend on a global that may not be there ----------------- */

test('a missing addDaysISO returns empty rather than throwing', () => {
  const saved = global.window.FS.api.addDaysISO;
  delete global.window.FS.api.addDaysISO;
  try {
    assert.deepStrictEqual(dateRangeISO('2026-01-01', '2026-01-05'), []);
  } finally {
    global.window.FS.api.addDaysISO = saved;
  }
});
