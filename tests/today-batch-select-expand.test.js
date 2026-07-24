'use strict';

/*
 * Unit tests for fix/today-batch-select-expand — the pure helpers that
 * drive Today's page-level Batch Select control (scripts/pages/today.js):
 *
 *   isBatchEligibleTask(t)  Same condition each section already used
 *                           inline for TaskCard's `checkable` prop
 *                           (topic_id/actionIndex/date all present).
 *                           Only an eligible task can grow the round
 *                           check button that doubles as a multi-select
 *                           toggle, so this also gates what enters the
 *                           merged batchEligibleItems list Today builds
 *                           for useMultiSelect().
 *
 *   groupByProject(items)   Pre-existing helper (unchanged by this fix)
 *                           reused here to prove the merged batch list's
 *                           per-section ordering matches on-screen
 *                           render order — Shift-range selection walks
 *                           this exact order.
 *
 * today.js is a browser IIFE (window.FieldSight.PAGES registration);
 * requiring it under Node needs the same minimal stubs as the other
 * page tests (q1-today-page-counts.test.js).
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = { FieldSight: {}, FS: { api: {} } };
global.React = {
  useState: function (v) { return [v, function () {}]; },
  useContext: function () { return null; },
  createContext: function (def) { return { Provider: 'Provider', _def: def }; },
  Fragment: 'Fragment',
};
global.document = { addEventListener() {}, removeEventListener() {} };

const { isBatchEligibleTask, groupByProject } = require('../scripts/pages/today.js');

test('isBatchEligibleTask: true when topic_id, actionIndex and date are all present', () => {
  assert.strictEqual(isBatchEligibleTask({
    id: 'a', topic_id: 't1', actionIndex: 0, date: '2026-07-20',
  }), true);
});

test('isBatchEligibleTask: actionIndex 0 is a valid index, not falsy-missing', () => {
  // `!= null` (not a truthiness check) is required here — actionIndex 0
  // is the first action item in a topic and must count as present.
  assert.strictEqual(isBatchEligibleTask({
    id: 'a', topic_id: 't1', actionIndex: 0, date: '2026-07-20',
  }), true);
});

test('isBatchEligibleTask: false when topic_id is missing', () => {
  assert.strictEqual(isBatchEligibleTask({
    id: 'a', actionIndex: 0, date: '2026-07-20',
  }), false);
});

test('isBatchEligibleTask: false when actionIndex is missing', () => {
  assert.strictEqual(isBatchEligibleTask({
    id: 'a', topic_id: 't1', date: '2026-07-20',
  }), false);
});

test('isBatchEligibleTask: false when date is missing/empty', () => {
  assert.strictEqual(isBatchEligibleTask({
    id: 'a', topic_id: 't1', actionIndex: 0, date: '',
  }), false);
  assert.strictEqual(isBatchEligibleTask({
    id: 'a', topic_id: 't1', actionIndex: 0,
  }), false);
});

test('isBatchEligibleTask: false/no-throw for null/undefined input', () => {
  assert.strictEqual(isBatchEligibleTask(null), false);
  assert.strictEqual(isBatchEligibleTask(undefined), false);
});

test('isBatchEligibleTask: a programme-task-shaped object (no topic_id/actionIndex at all) is never eligible', () => {
  // ProgrammeTaskCard rows never carry topic_id/actionIndex/date in the
  // shape TaskCard/isBatchEligibleTask expects — this is the guarantee
  // that programme rows can never enter batchEligibleItems even if a
  // future refactor accidentally concatenated the wrong list.
  assert.strictEqual(isBatchEligibleTask({
    id: 'row1', task_id: 'PT-1', site_slug: 'sb1108',
  }), false);
});

test('batchEligibleItems merge order: myRecent groups, then teamRecent groups, then leftover groups', () => {
  // Mirrors the exact composition today.js builds: groupByProject(list)
  // flattened per section, concatenated Mine -> Team -> Leftover, then
  // filtered to eligible rows. Shift-range selection depends on this
  // matching the visual top-to-bottom section order.
  function flatten(list) {
    return groupByProject(list).reduce(function (acc, g) { return acc.concat(g.rows); }, []);
  }
  const myRecent = [
    { id: 'm1', site_slug: 'siteB', topic_id: 't', actionIndex: 0, date: 'd' },
    { id: 'm2', site_slug: 'siteA', topic_id: 't', actionIndex: 1, date: 'd' },
  ];
  const teamRecent = [
    { id: 'tm1', site_slug: 'siteA', topic_id: 't', actionIndex: 0, date: 'd' },
  ];
  const leftover = [
    { id: 'l1', site_slug: 'siteC', topic_id: 't', actionIndex: 0, date: 'd' },
  ];

  const merged = flatten(myRecent).concat(flatten(teamRecent)).concat(flatten(leftover))
    .filter(isBatchEligibleTask);

  assert.deepStrictEqual(merged.map((t) => t.id), ['m1', 'm2', 'tm1', 'l1']);
});

test('batchEligibleItems merge: a non-eligible row (no date) is dropped from the merged list but stays renderable', () => {
  function flatten(list) {
    return groupByProject(list).reduce(function (acc, g) { return acc.concat(g.rows); }, []);
  }
  const myRecent = [
    { id: 'm1', site_slug: 'siteA', topic_id: 't', actionIndex: 0, date: 'd' },
    { id: 'm2', site_slug: 'siteA' },   // no topic_id/actionIndex/date — not batch-eligible
  ];
  const merged = flatten(myRecent).filter(isBatchEligibleTask);
  assert.deepStrictEqual(merged.map((t) => t.id), ['m1']);
  // m2 is still part of the raw list (still rendered as a card, just
  // without a round check button at all) — this test only asserts it's
  // excluded from the SELECTABLE set, not that it vanishes from the page.
  assert.strictEqual(myRecent.length, 2);
});
