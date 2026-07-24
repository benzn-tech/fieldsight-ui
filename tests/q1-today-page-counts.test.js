'use strict';

/*
 * Unit tests for Q1 — tier-aware Today/Tasks: today.js's openCount()
 * helper, which drives the "Open items · N" / "Team · N" section counts
 * (scripts/pages/today.js). A non_work item stays in the rendered
 * myRecent/teamRecent list but must not inflate this count; redacted
 * items never reach this helper at all (today-adapter.js omits them
 * before today.js ever sees them — see q1-today-adapter-tiers.test.js).
 *
 * today.js is a browser IIFE (window.FieldSight.PAGES registration);
 * requiring it under Node needs the same minimal stubs as the other
 * page tests (date-parse.test.js, timeline-redaction-overrides.test.js).
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

const { openCount } = require('../scripts/pages/today.js');

test('openCount: a non_work item is excluded from the count', () => {
  const list = [
    { id: 'a', work_class: 'non_work' },
    { id: 'b', work_class: 'work' },
  ];
  assert.strictEqual(openCount(list), 1);
});

test('openCount: undefined/missing work_class counts as work (never a !== "work" check)', () => {
  const list = [
    { id: 'a' },                 // no work_class at all
    { id: 'b', work_class: undefined },
    { id: 'c', work_class: 'work' },
  ];
  assert.strictEqual(openCount(list), 3);
});

test('openCount: only the literal "non_work" is excluded, an empty list counts as 0', () => {
  assert.strictEqual(openCount([]), 0);
  const list = [{ id: 'a', work_class: 'non_work' }, { id: 'b', work_class: 'non_work' }];
  assert.strictEqual(openCount(list), 0);
});

test('openCount: a full mix — redacted items are never in this list to begin with, non_work uncounted, work counted', () => {
  // Mirrors what myRecent actually looks like once today-adapter.js has
  // already omitted redacted topics: only 'work'/undefined/'non_work' show up.
  const myRecent = [
    { id: 't1', work_class: 'non_work' },
    { id: 't2', work_class: 'work' },
    { id: 't3' },
  ];
  assert.strictEqual(openCount(myRecent), 2, 'personal item present in the list but not counted');
  assert.strictEqual(myRecent.length, 3, 'sanity: the item is still in the rendered list itself');
});
