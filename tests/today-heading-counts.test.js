'use strict';

/*
 * Unit tests for fix/today-heading-counts — the Today page's section/
 * sub-group headings ("Open items · N", "Team · N", "Leftover · N", and
 * each project sub-group's own count) previously used THREE different
 * counting rules on the same page:
 *   - "Open items"/"Team" used openCount(list): excluded a
 *     `work_class === 'non_work'` item from the number while STILL
 *     rendering its card (TaskCard's "Possibly personal" badge) — a
 *     heading could read "Open items · 3" over 5 rendered cards.
 *   - "Leftover" used the raw list.length — a second rule.
 *   - Project sub-group headers (renderMaybeGrouped) used raw
 *     g.rows.length — happened to already match rule #2.
 *
 * The fix: ONE rule everywhere — a heading's N is always the number of
 * cards rendered beneath it (sectionCardCount(list), scripts/pages/
 * today.js). Q1's "still render a possibly-personal item, just flag it"
 * behaviour (task-card.js's badge) is UNCHANGED — only the count
 * changed, from "exclude non_work" to "count what's on screen".
 *
 * today.js is a browser IIFE (window.FieldSight.PAGES registration);
 * requiring it under Node needs the same minimal stubs as the other page
 * tests (date-parse.test.js, timeline-redaction-overrides.test.js,
 * q1-today-page-counts.test.js before it).
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

const { sectionCardCount, groupByProject } = require('../scripts/pages/today.js');

/* ---------- sectionCardCount: the heading number IS the render count ---- */

test('sectionCardCount: equals the length of the list it is given (all-work list)', () => {
  const list = [{ id: 'a', work_class: 'work' }, { id: 'b' }];
  assert.strictEqual(sectionCardCount(list), 2);
});

test('sectionCardCount: a non_work item is COUNTED, not excluded (the fix) — heading matches rendered cards', () => {
  const list = [
    { id: 'a', work_class: 'non_work' }, // still rendered, badge-flagged — must still count
    { id: 'b', work_class: 'work' },
    { id: 'c' },
  ];
  assert.strictEqual(sectionCardCount(list), 3, 'heading must equal the 3 cards actually rendered');
  assert.strictEqual(sectionCardCount(list), list.length, 'no filtering — always the raw render count');
});

test('sectionCardCount: empty list is 0, null/undefined list is 0 (never throws)', () => {
  assert.strictEqual(sectionCardCount([]), 0);
  assert.strictEqual(sectionCardCount(null), 0);
  assert.strictEqual(sectionCardCount(undefined), 0);
});

/* ---------- "Open items" and "Team" share the SAME rule ----------------- */

test('sectionCardCount: "Open items" and "Team" agree on the same mixed list — one rule, not two', () => {
  const mixedList = [
    { id: 'a', work_class: 'non_work' },
    { id: 'b', work_class: 'work' },
    { id: 'c', work_class: 'non_work' },
    { id: 'd' },
  ];
  // Whichever heading this list is rendered under (myVisible for "Open
  // items", teamVisible for "Team" — feat/leftover-inline-filter retired
  // the separate "Leftover" heading), the SAME helper computes its number:
  // there is no second, stricter rule for one heading the other doesn't
  // share.
  const openItemsHeadingCount = sectionCardCount(mixedList);
  const teamHeadingCount      = sectionCardCount(mixedList);
  assert.strictEqual(openItemsHeadingCount, 4);
  assert.strictEqual(teamHeadingCount, 4);
});

/* ---------- Project sub-group counts sum to the section count ------------ */

test('groupByProject: each sub-group count (rows.length) sums back to the section heading count', () => {
  const items = [
    { id: 't1', site_slug: 'sb1108', site_name: 'SB1108 Ellesmere', work_class: 'work' },
    { id: 't2', site_slug: 'sb1108', site_name: 'SB1108 Ellesmere', work_class: 'non_work' },
    { id: 't3', site_slug: 'ucpk',   site_name: 'UC PK' },
  ];
  const sectionCount = sectionCardCount(items);
  const groups = groupByProject(items);

  const summedSubGroupCounts = groups.reduce(function (sum, g) { return sum + g.rows.length; }, 0);

  assert.strictEqual(sectionCount, 3, 'the section heading itself');
  assert.strictEqual(summedSubGroupCounts, sectionCount,
    'sub-group headers (g.rows.length) must sum to the same number the parent section heading shows');
  assert.strictEqual(groups.length, 2, 'sanity: two distinct projects grouped');
});

test('groupByProject: a single-project list still sums to the section count (non_work item included)', () => {
  const items = [
    { id: 't1', site_slug: 'ucpk', site_name: 'UC PK', work_class: 'non_work' },
    { id: 't2', site_slug: 'ucpk', site_name: 'UC PK', work_class: 'work' },
  ];
  const groups = groupByProject(items);
  const summed = groups.reduce(function (sum, g) { return sum + g.rows.length; }, 0);
  assert.strictEqual(summed, sectionCardCount(items));
  assert.strictEqual(summed, 2);
});
