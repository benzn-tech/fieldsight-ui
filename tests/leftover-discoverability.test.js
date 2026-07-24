'use strict';

/*
 * Unit tests for fix/leftover-discoverability.
 *
 * Problem (the user's own words): "I notice that even when the assignee
 * is the same person, items get put in different sections." Root cause
 * (scripts/pages/today.js): myTasks/teamTasks (Mine/Team, by
 * isMineTask) get torn apart AGAIN purely by age (ageDays >
 * LEFTOVER_THRESHOLD_DAYS) into Recent vs. Leftover, and Leftover is
 * collapsed by default — so a viewer's own older item silently leaves
 * "Open items" for a closed drawer and reads as MISSING, not filed.
 *
 * The fix adds ONE pure helper, countOwnStranded(myTasks) — "how many
 * of THIS viewer's own (pre-split) tasks did the age split just strand
 * into Leftover?" — and a quiet, click-to-expand hint line near "Open
 * items" that renders only when that count is > 0. It does NOT change
 * LEFTOVER_THRESHOLD_DAYS, the age split itself, which section anything
 * lands in, the Leftover section's default-collapsed state, or any
 * existing heading count (sectionCardCount, unchanged, still counts the
 * merged Mine+Team Leftover total for the Leftover heading itself).
 *
 * today.js is a browser IIFE (window.FieldSight.PAGES registration);
 * requiring it under Node needs the same minimal stubs as the other
 * page tests (today-heading-counts.test.js, date-parse.test.js).
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

const { countOwnStranded } = require('../scripts/pages/today.js');

/* Mirrors today.js's own LEFTOVER_THRESHOLD_DAYS (not exported — a
   deliberately private, "do not change" tunable per the task spec).
   Kept here only so these tests can build scenarios with the same
   threshold today.js itself uses. */
const LEFTOVER_THRESHOLD_DAYS = 90;

/* ---------- Some stranded: own-only, a Team item never inflates it --- */

test('countOwnStranded: counts only the viewer\'s own stranded items — a Team item aged into Leftover does not inflate it', () => {
  const myTasks   = [{ id: 'm1', ageDays: 120 }, { id: 'm2', ageDays: 5 }];
  const teamTasks = [{ id: 't1', ageDays: 500 }]; // also stranded, but not this viewer's

  assert.strictEqual(countOwnStranded(myTasks), 1, 'only m1 (120d) is this viewer\'s own stranded item');

  // Demonstrates the bug this guards against: naively counting across
  // BOTH lists (the mistake the Leftover heading's merged Mine+Team
  // total invites, if reused for this purpose) would over-count.
  const naiveCombinedCount = countOwnStranded(myTasks.concat(teamTasks));
  assert.strictEqual(naiveCombinedCount, 2, 'sanity: the combined list DOES include the Team item — proves myTasks-only is what keeps it out');
});

test('countOwnStranded: multiple own stranded items are all counted', () => {
  const myTasks = [
    { id: 'm1', ageDays: 100 },
    { id: 'm2', ageDays: 91 },
    { id: 'm3', ageDays: 200 },
    { id: 'm4', ageDays: 10 }, // Recent, not stranded
  ];
  assert.strictEqual(countOwnStranded(myTasks), 3);
});

/* ---------- None stranded: 0, which is exactly the render's zero-gate - */

test('countOwnStranded: no own stranded items -> 0 (the render\'s `ownStrandedCount > 0` gate then renders nothing)', () => {
  const myTasks = [{ id: 'm1', ageDays: 5 }, { id: 'm2', ageDays: 89 }];
  assert.strictEqual(countOwnStranded(myTasks), 0);
});

/* ---------- Empty / null / undefined: 0, never throws ------------------ */

test('countOwnStranded: empty/null/undefined myTasks -> 0, never throws', () => {
  assert.strictEqual(countOwnStranded([]), 0);
  assert.strictEqual(countOwnStranded(null), 0);
  assert.strictEqual(countOwnStranded(undefined), 0);
});

test('countOwnStranded: items with missing/null ageDays are not counted, and do not throw', () => {
  assert.strictEqual(countOwnStranded([{ id: 'm1' }, { id: 'm2', ageDays: null }, null]), 0);
});

/* ---------- Boundary: matches the split's strict `>` predicate -------- */

test('countOwnStranded: ageDays exactly at the threshold is Recent, not stranded (matches the `>` the Recent/Leftover split uses, not `>=`)', () => {
  assert.strictEqual(countOwnStranded([{ id: 'm1', ageDays: LEFTOVER_THRESHOLD_DAYS }]), 0);
  assert.strictEqual(countOwnStranded([{ id: 'm1', ageDays: LEFTOVER_THRESHOLD_DAYS + 1 }]), 1);
});

/* ---------- Agrees with what the Leftover section actually contains --- */

test('countOwnStranded: agrees with what the Leftover section actually renders as "mine" for this viewer', () => {
  const myTasks = [
    { id: 'm1', ageDays: 120 },
    { id: 'm2', ageDays: 30 },
    { id: 'm3', ageDays: 91 },
  ];
  const teamTasks = [
    { id: 't1', ageDays: 200 },
    { id: 't2', ageDays: 10 },
  ];

  // Replicates today.js's OWN Recent/Leftover split (verbatim predicate
  // and shape — myLeftover/teamLeftover/leftoverItems, ~today.js:1573-
  // 1582) so this test can check countOwnStranded against what the
  // Leftover section actually contains, not just re-derive the same
  // number a different way.
  const myLeftover   = myTasks.filter(function (t) { return t.ageDays > LEFTOVER_THRESHOLD_DAYS; });
  const teamLeftover = teamTasks.filter(function (t) { return t.ageDays > LEFTOVER_THRESHOLD_DAYS; });
  const leftoverItems = myLeftover.concat(teamLeftover);

  // Replicates today.js's OWN `myIds` map + the `isMine: !!myIds[task.id]`
  // flag every Leftover TaskCard is actually given (today.js ~:1749-1750,
  // ~:2153) — this IS the mechanism the rendered Leftover section uses to
  // mark a row as the viewer's own.
  const myIds = {};
  myTasks.forEach(function (t) { myIds[t.id] = true; });
  const leftoverMineCount = leftoverItems.filter(function (t) { return myIds[t.id]; }).length;

  assert.strictEqual(leftoverMineCount, 2, 'sanity: m1 and m3 are the two "mine" rows Leftover would render');
  assert.strictEqual(countOwnStranded(myTasks), leftoverMineCount,
    'countOwnStranded must agree with the count of isMine:true rows the Leftover section itself would render');
});
