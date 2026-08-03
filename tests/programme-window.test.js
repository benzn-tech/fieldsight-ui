'use strict';

/*
 * The programme time window.
 *
 * Presets are expressed as weeks back and weeks forward from today, because
 * that is how the work is actually discussed on site — "the last fortnight
 * and the next month" — not as absolute dates. Keeping them relative also
 * means the window stays anchored to today without the user re-picking it
 * every morning.
 *
 * isInWindow must agree with the server's rule exactly (overlap, not
 * containment). A client that disagreed would hide tasks the server had just
 * decided to send, which reads as data loss rather than as a filter.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  PRESETS, DEFAULT_PRESET_KEY, presetByKey, resolveWindow, isInWindow,
} = require('../scripts/api/programme-window.js');

/* ---- presets ------------------------------------------------------------- */

test('exactly one preset is marked default, and it is two back four forward', () => {
  const defaults = PRESETS.filter((p) => p.default);
  assert.strictEqual(defaults.length, 1, 'exactly one default');
  assert.strictEqual(defaults[0].backWeeks, 2);
  assert.strictEqual(defaults[0].forwardWeeks, 4);
  assert.strictEqual(defaults[0].key, DEFAULT_PRESET_KEY);
});

test('every preset stays inside the 400-day server cap', () => {
  PRESETS.forEach((p) => {
    const days = (p.backWeeks + p.forwardWeeks) * 7;
    assert.ok(days <= 400, p.label + ' (' + days + 'd) exceeds the server cap');
  });
});

test('preset keys are unique', () => {
  const keys = PRESETS.map((p) => p.key);
  assert.strictEqual(new Set(keys).size, keys.length);
});

test('presetByKey falls back to the default rather than returning undefined', () => {
  /* A stored preference can outlive the preset that produced it. Returning
     undefined here would crash resolveWindow on the next page load, and the
     user could not clear it without dev tools. */
  assert.strictEqual(presetByKey('no-such-preset').key, DEFAULT_PRESET_KEY);
  assert.strictEqual(presetByKey(undefined).key, DEFAULT_PRESET_KEY);
  assert.strictEqual(presetByKey(null).key, DEFAULT_PRESET_KEY);
});

test('presetByKey returns the matching preset when it exists', () => {
  assert.strictEqual(presetByKey('2-8').forwardWeeks, 8);
});

/* ---- resolveWindow ------------------------------------------------------- */

test('resolveWindow turns a preset into absolute dates around today', () => {
  const w = resolveWindow({ backWeeks: 2, forwardWeeks: 4 }, '2026-05-01');
  assert.strictEqual(w.from, '2026-04-17');
  assert.strictEqual(w.to, '2026-05-29');
});

test('resolveWindow crosses a month boundary correctly', () => {
  const w = resolveWindow({ backWeeks: 2, forwardWeeks: 4 }, '2026-01-05');
  assert.strictEqual(w.from, '2025-12-22');
  assert.strictEqual(w.to, '2026-02-02');
});

test('resolveWindow handles a leap day without drifting', () => {
  const w = resolveWindow({ backWeeks: 1, forwardWeeks: 1 }, '2028-03-01');
  assert.strictEqual(w.from, '2028-02-23');
  assert.strictEqual(w.to, '2028-03-08');
});

test('resolveWindow accepts a preset key as well as a preset object', () => {
  const byKey = resolveWindow('2-4', '2026-05-01');
  const byObj = resolveWindow({ backWeeks: 2, forwardWeeks: 4 }, '2026-05-01');
  assert.deepStrictEqual(byKey, byObj);
});

/* ---- isInWindow ---------------------------------------------------------- */

const W = { from: '2026-04-17', to: '2026-05-29' };

test('a task spanning the whole window is in it', () => {
  assert.strictEqual(isInWindow({ start: '2026-01-01', end: '2026-12-31' }, W), true);
});

test('a task wholly inside the window is in it', () => {
  assert.strictEqual(isInWindow({ start: '2026-05-01', end: '2026-05-10' }, W), true);
});

test('a task touching only the first day of the window is in it', () => {
  assert.strictEqual(isInWindow({ start: '2026-03-01', end: '2026-04-17' }, W), true);
});

test('a task touching only the last day of the window is in it', () => {
  assert.strictEqual(isInWindow({ start: '2026-05-29', end: '2026-08-01' }, W), true);
});

test('a task ending the day before the window is out', () => {
  assert.strictEqual(isInWindow({ start: '2026-03-01', end: '2026-04-16' }, W), false);
});

test('a task starting the day after the window is out', () => {
  assert.strictEqual(isInWindow({ start: '2026-05-30', end: '2026-06-10' }, W), false);
});

test('a task with no dates is never in the window', () => {
  assert.strictEqual(isInWindow({ start: null, end: null }, W), false);
  assert.strictEqual(isInWindow({}, W), false);
});

test('isInWindow reads start_date/end_date as well as start/end', () => {
  /* The window endpoint returns Aurora column names; the legacy snapshot
     document uses start/end. One helper serves both rather than making every
     call site remember which shape it is holding. */
  assert.strictEqual(
    isInWindow({ start_date: '2026-05-01', end_date: '2026-05-10' }, W), true);
});
