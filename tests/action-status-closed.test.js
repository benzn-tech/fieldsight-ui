'use strict';

/*
 * The `closed` action status (owner, 2026-10-27): no longer needs doing —
 * cancelled, superseded, duplicate. Off the list like `done`, but NOT a
 * completion: never shown ticked, never counted as done.
 *
 * Same Node stubs as q1-tasks-page-buckets.test.js (tasks.js is a browser IIFE).
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = {
  FieldSight: {},
  FS: {
    api: {
      resolveDeadline: function (deadline) {
        var m = String(deadline || '').match(/^\d{4}-\d{2}-\d{2}$/);
        return { absolute: m ? deadline : null, display: deadline || '—' };
      },
    },
  },
};
require('../scripts/api/mine-team.js');
require('../scripts/api/actions.js');
global.React = {
  useState: function (v) { return [v, function () {}]; },
  useContext: function () { return null; },
  useEffect: function () {},
  createContext: function (def) { return { Provider: 'Provider', _def: def }; },
  Fragment: 'Fragment',
};
global.document = { addEventListener() {}, removeEventListener() {} };

const { computeBuckets, isOverdue, isRowClosed } = require('../scripts/pages/tasks.js');
const actions = window.FS.api.actions;

function row(o) {
  return Object.assign({ id: 'r', responsible: 'Jane Doe', date: '2026-07-10',
                         deadline: '2026-07-01' }, o);
}

test('closed is finished but not resolved (done)', () => {
  assert.strictEqual(actions.isActionFinished('closed'), true);
  assert.strictEqual(actions.isActionFinished('done'), true);
  assert.strictEqual(actions.isActionFinished('in_progress'), false);
  assert.strictEqual(actions.isActionResolved('closed'), false);
});

test('a closed task leaves open and overdue and sits with the finished ones', () => {
  const rows = [row({ id: 'a', status: 'open' }), row({ id: 'c', status: 'closed' }),
                row({ id: 'd', status: 'done' }), row({ id: 'p', status: 'in_progress' })];
  const b = computeBuckets(rows, { name: 'Jane Doe' }, '2026-07-20');
  assert.deepStrictEqual(b.open.map(r => r.id), ['a', 'p']);
  assert.deepStrictEqual(b.overdue.map(r => r.id), ['a', 'p']);
  assert.deepStrictEqual(b.done.map(r => r.id), ['c', 'd']);
  assert.strictEqual(isOverdue(row({ status: 'closed' }), '2026-07-20'), false);
  assert.strictEqual(isRowClosed(row({ status: 'closed' })), true);
  assert.strictEqual(isRowClosed(row({ status: 'done' })), false);
});

test('a closed item is never shown ticked', () => {
  const s = actions.itemState({ status: 'closed', updated_by_name: 'Sarah' }, undefined);
  assert.strictEqual(s.checked, false);
  assert.strictEqual(s.checked_by, null);
});
