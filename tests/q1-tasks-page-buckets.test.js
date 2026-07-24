'use strict';

/*
 * Unit tests for Q1 — tier-aware Today/Tasks: tasks.js's computeBuckets()
 * helper, which drives both the filter-chip counts and the Open/Overdue
 * filter views (scripts/pages/tasks.js). A non_work row stays in
 * all/mine/done but is excluded from open/overdue; redacted rows never
 * reach this helper at all — tasks-aggregator.js omits them before
 * tasks.js ever sees them (see q1-tasks-aggregator-tiers.test.js).
 *
 * tasks.js is a browser IIFE (window.FieldSight.PAGES registration);
 * requiring it under Node needs the same minimal stubs as the today.js
 * page test (React.createContext is called at module top-level).
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = {
  FieldSight: {},
  FS: {
    api: {
      resolveDeadline: function (deadline, date) {
        // Only exercised via isOverdue; a bare ISO string in `deadline`
        // resolves to itself, anything else -> no absolute date.
        var m = String(deadline || '').match(/^\d{4}-\d{2}-\d{2}$/);
        return { absolute: m ? deadline : null, display: deadline || '—' };
      },
    },
  },
};
global.React = {
  useState: function (v) { return [v, function () {}]; },
  useContext: function () { return null; },
  useEffect: function () {},
  createContext: function (def) { return { Provider: 'Provider', _def: def }; },
  Fragment: 'Fragment',
};
global.document = { addEventListener() {}, removeEventListener() {} };

const { computeBuckets } = require('../scripts/pages/tasks.js');

function row(overrides) {
  return Object.assign({
    id: 'r', responsible: 'Jane Doe', date: '2026-07-10', deadline: null,
    audit: { checked: false },
  }, overrides);
}

test('computeBuckets: a non_work row is excluded from open and overdue, but kept in all/mine/done', () => {
  var rows = [
    row({ id: 'personal', work_class: 'non_work', deadline: '2026-07-01' /* overdue vs today 07-10 */ }),
    row({ id: 'work',     work_class: 'work',      deadline: '2026-07-02' /* also overdue */ }),
  ];
  var b = computeBuckets(rows, 'Jane Doe', '2026-07-10');

  assert.deepStrictEqual(b.all.map((r) => r.id), ['personal', 'work'], 'all keeps both');
  assert.deepStrictEqual(b.mine.map((r) => r.id), ['personal', 'work'], 'mine keeps both (same responsible)');
  assert.deepStrictEqual(b.open.map((r) => r.id), ['work'], 'open excludes the personal row');
  assert.deepStrictEqual(b.overdue.map((r) => r.id), ['work'], 'overdue excludes the personal row even though it IS overdue');
});

test('computeBuckets: missing/other work_class counts as work in open/overdue (never a !== "work" check)', () => {
  var rows = [
    row({ id: 'no-field' }),                       // no work_class key at all
    row({ id: 'explicit-work', work_class: 'work' }),
  ];
  var b = computeBuckets(rows, 'Jane Doe', '2026-07-10');
  assert.deepStrictEqual(b.open.map((r) => r.id).sort(), ['explicit-work', 'no-field']);
});

test('computeBuckets: done rows are unaffected by work_class (non_work still counts as done once checked)', () => {
  var rows = [
    row({ id: 'personal-done', work_class: 'non_work', audit: { checked: true } }),
  ];
  var b = computeBuckets(rows, 'Jane Doe', '2026-07-10');
  assert.deepStrictEqual(b.done.map((r) => r.id), ['personal-done']);
  assert.deepStrictEqual(b.open, [], 'checked rows never count as open regardless of work_class');
});

test('computeBuckets: an all-work list is unaffected (regression guard — no accidental over-exclusion)', () => {
  var rows = [row({ id: 'a', work_class: 'work' }), row({ id: 'b' })];
  var b = computeBuckets(rows, 'Jane Doe', '2026-07-10');
  assert.strictEqual(b.open.length, 2);
  assert.strictEqual(b.overdue.length, 0);
});
