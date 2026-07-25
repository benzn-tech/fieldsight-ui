'use strict';

/*
 * Unit tests for feat/leftover-inline-filter (#7).
 *
 * The redesign: aged (90+ day) open items no longer disappear into a
 * default-collapsed, Mine+Team-merged "Leftover" drawer (the old
 * feat/today-leftover-grouping behaviour, where a viewer's own older task
 * silently left "Open items" and read as MISSING). Instead every aged item
 * renders INLINE in its correct Mine ("Open items") / Team section by
 * default, carrying a subtle "90+ days" chip (task-card.js `aged` prop),
 * and an optional per-viewer filter (default OFF — shown) hides them.
 *
 * These tests exercise the pure helpers the render path itself uses, so
 * the render and the tests cannot independently drift:
 *   - isAgedTask(t)            the "90+ days" marker predicate
 *   - visibleTasks(list, hide) a section's render list under the filter
 *   - countAged(list)          the hidden/aged count
 *   - sectionCardCount(list)   the heading number = cards rendered (reused)
 *   - readHideAgedPref/writeHideAgedPref  the persisted, default-OFF pref
 *
 * today.js is a browser IIFE (window.FieldSight.PAGES registration);
 * requiring it under Node needs the same minimal stubs as the other page
 * tests (today-heading-counts.test.js before it).
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

const {
  isAgedTask, visibleTasks, countAged, sectionCardCount,
  readHideAgedPref, writeHideAgedPref,
} = require('../scripts/pages/today.js');

/* Mirrors today.js's own LEFTOVER_THRESHOLD_DAYS (not exported — a
   "do not change" tunable per the spec). Kept here only so these tests
   can build scenarios with the same threshold today.js itself uses. */
const LEFTOVER_THRESHOLD_DAYS = 90;

/* ---------- The aged-marker predicate --------------------------------- */

test('isAgedTask: strictly > threshold is aged; exactly AT the threshold is not (mirrors the `>` the old split used, never `>=`)', () => {
  assert.strictEqual(isAgedTask({ ageDays: LEFTOVER_THRESHOLD_DAYS + 1 }), true);
  assert.strictEqual(isAgedTask({ ageDays: LEFTOVER_THRESHOLD_DAYS }), false, 'boundary: exactly 90d is NOT aged');
  assert.strictEqual(isAgedTask({ ageDays: LEFTOVER_THRESHOLD_DAYS - 1 }), false);
  assert.strictEqual(isAgedTask({ ageDays: 500 }), true);
});

test('isAgedTask: missing/null ageDays and null/undefined items are not aged, and never throw', () => {
  assert.strictEqual(isAgedTask({}), false);
  assert.strictEqual(isAgedTask({ ageDays: null }), false);
  assert.strictEqual(isAgedTask(null), false);
  assert.strictEqual(isAgedTask(undefined), false);
});

/* ---------- Default is SHOW (filter OFF) — aged items render inline ---- */

test('default (hideAged=false): an aged Mine item is present in the Mine render list, NOT dropped into a separate drawer', () => {
  const myTasks = [
    { id: 'm1', ageDays: 120 }, // aged — must still render in Mine
    { id: 'm2', ageDays: 5 },
  ];
  const myVisible = visibleTasks(myTasks, false);
  assert.deepStrictEqual(myVisible.map(function (t) { return t.id; }), ['m1', 'm2'],
    'both the aged and recent Mine items render inline in Mine by default');
});

test('default (hideAged=false): an aged Team item is present in the Team render list', () => {
  const teamTasks = [
    { id: 't1', ageDays: 300 }, // aged — must still render in Team
    { id: 't2', ageDays: 2 },
  ];
  const teamVisible = visibleTasks(teamTasks, false);
  assert.deepStrictEqual(teamVisible.map(function (t) { return t.id; }), ['t1', 't2']);
});

test('visibleTasks with hideAged=false returns the whole list unchanged (aged shown)', () => {
  const list = [{ id: 'a', ageDays: 200 }, { id: 'b', ageDays: 10 }, { id: 'c', ageDays: 91 }];
  assert.strictEqual(visibleTasks(list, false).length, list.length);
});

/* ---------- The hide filter removes EXACTLY the aged items ------------- */

test('hideAged=true removes exactly the aged items and nothing else', () => {
  const myTasks = [
    { id: 'm1', ageDays: 120 }, // aged -> removed
    { id: 'm2', ageDays: 5 },   // kept
    { id: 'm3', ageDays: 90 },  // boundary: NOT aged -> kept
    { id: 'm4', ageDays: 91 },  // aged -> removed
  ];
  const myVisible = visibleTasks(myTasks, true);
  assert.deepStrictEqual(myVisible.map(function (t) { return t.id; }), ['m2', 'm3'],
    'only the two non-aged items survive; m3 at exactly 90d stays');
});

/* ---------- Hidden count (filter ON) equals the aged count ------------- */

test('with the filter ON, the hidden count equals countAged across BOTH buckets (Mine + Team)', () => {
  const myTasks   = [{ id: 'm1', ageDays: 120 }, { id: 'm2', ageDays: 5 }, { id: 'm3', ageDays: 200 }];
  const teamTasks = [{ id: 't1', ageDays: 500 }, { id: 't2', ageDays: 10 }];

  const hideAged = true;
  const hiddenCount = hideAged ? (countAged(myTasks) + countAged(teamTasks)) : 0;

  // What was removed from each render list, counted directly.
  const removedFromMine   = myTasks.length   - visibleTasks(myTasks, true).length;
  const removedFromTeam   = teamTasks.length - visibleTasks(teamTasks, true).length;

  assert.strictEqual(hiddenCount, 3, 'm1, m3, t1 are the three aged items across both buckets');
  assert.strictEqual(hiddenCount, removedFromMine + removedFromTeam,
    'the "N older items hidden" count must equal exactly what the filter removed from the two sections');
});

test('countAged: counts aged items in whatever list it is given; empty/null -> 0, never throws', () => {
  assert.strictEqual(countAged([{ ageDays: 91 }, { ageDays: 5 }, { ageDays: 300 }]), 2);
  assert.strictEqual(countAged([]), 0);
  assert.strictEqual(countAged(null), 0);
  assert.strictEqual(countAged(undefined), 0);
});

/* ---------- Heading counts stay honest in BOTH filter states ---------- */

test('heading count equals the cards rendered beneath it — filter OFF (aged shown -> counted)', () => {
  const myTasks = [{ id: 'm1', ageDays: 120 }, { id: 'm2', ageDays: 5 }, { id: 'm3', ageDays: 91 }];

  const myVisible = visibleTasks(myTasks, false);
  const heading   = sectionCardCount(myVisible);

  assert.strictEqual(heading, 3, 'filter OFF: all three render, so "Open items · 3"');
  assert.strictEqual(heading, myVisible.length, 'heading number IS the count of cards rendered');
});

test('heading count equals the cards rendered beneath it — filter ON (aged hidden -> not counted)', () => {
  const myTasks = [{ id: 'm1', ageDays: 120 }, { id: 'm2', ageDays: 5 }, { id: 'm3', ageDays: 91 }];

  const myVisible = visibleTasks(myTasks, true);
  const heading   = sectionCardCount(myVisible);

  assert.strictEqual(heading, 1, 'filter ON: only m2 renders, so "Open items · 1"');
  assert.strictEqual(heading, myVisible.length,
    'heading still equals rendered cards — neither the number nor the cards include the hidden aged items');
});

/* ---------- Mine and Team are NEVER merged ---------------------------- */

test('Mine/Team are filtered independently and never merged — no Team item ever leaks into the Mine render list (the old Leftover-drawer bug)', () => {
  const myTasks   = [{ id: 'm1', ageDays: 120 }, { id: 'm2', ageDays: 5 }];
  const teamTasks = [{ id: 't1', ageDays: 300 }, { id: 't2', ageDays: 8 }];

  [false, true].forEach(function (hideAged) {
    const myVisible   = visibleTasks(myTasks, hideAged);
    const teamVisible = visibleTasks(teamTasks, hideAged);
    const teamIds = teamTasks.map(function (t) { return t.id; });

    myVisible.forEach(function (t) {
      assert.ok(teamIds.indexOf(t.id) === -1,
        'a Team id must never appear in the Mine render list (hideAged=' + hideAged + ')');
    });
    // And symmetrically: every myVisible item came from myTasks.
    myVisible.forEach(function (t) {
      assert.ok(myTasks.some(function (m) { return m.id === t.id; }));
    });
    teamVisible.forEach(function (t) {
      assert.ok(teamTasks.some(function (m) { return m.id === t.id; }));
    });
  });
});

/* ---------- The filter preference: default OFF, persisted -------------- */

test('readHideAgedPref: default OFF (show) when nothing is stored, and never throws when localStorage is unavailable', () => {
  // No window.localStorage on the test stub -> the try/catch returns the
  // default. This IS the "default is show (filter off)" guarantee.
  assert.strictEqual(readHideAgedPref(), false);
});

test('writeHideAgedPref -> readHideAgedPref round-trips through a localStorage stub (persistence, fs.settings.* namespace)', () => {
  const store = {};
  const prev = global.window.localStorage;
  global.window.localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
  };
  try {
    assert.strictEqual(readHideAgedPref(), false, 'default OFF before anything is written');
    writeHideAgedPref(true);
    assert.strictEqual(readHideAgedPref(), true, 'persists ON');
    assert.ok(Object.keys(store).some(function (k) { return k.indexOf('fs.settings.') === 0; }),
      'stored under the fs.settings.* namespace, like tasks.js\'s tasksView pref');
    writeHideAgedPref(false);
    assert.strictEqual(readHideAgedPref(), false, 'persists OFF again');
  } finally {
    global.window.localStorage = prev;
  }
});
