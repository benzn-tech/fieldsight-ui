'use strict';

/*
 * Unit tests for feat/today-title-edit — the pure gate that decides
 * whether Today's right-detail panel offers a title editor for a task
 * (scripts/pages/today.js's `titleEditable`).
 *
 * Title edits go through PATCH /api/org/content/{table}/{id}
 * (FS.api.actions.updateContent), a DIFFERENT authority model than the
 * priority/status/due/assignee editors (PATCH /api/org/action-items/{id},
 * gated by `fieldsEditable` — task:edit/task:assign or being the task's
 * own assignee). The title's caller-side gate is content:edit-or-own-
 * report ("canEditContentRow" — computed in TodayRightDetail the same
 * way timeline.js computes its `canEditContent`, not unit tested here
 * since it's a thin OR of two window.FS.can()/folderName() reads with no
 * branching logic of its own, same as timeline.js's original). What IS
 * independently testable, and load-bearing, is the two-part gate this
 * file adds on top of that boolean:
 *   - the row must be a task (not urgent/activity — those have no title
 *     to correct via this path)
 *   - the caller must actually have content-edit standing on this row
 *   - the row must carry a durable action_items.id (actionItemId) to
 *     PATCH against at all — a legacy/pre-migration item has nothing to
 *     edit regardless of permission
 *
 * today.js is a browser IIFE (window.FieldSight.PAGES registration);
 * requiring it under Node needs the same minimal stubs as the other page
 * tests (today-batch-select-expand.test.js).
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

const { titleEditable } = require('../scripts/pages/today.js');

test('titleEditable: true for a task row with a durable id and content-edit standing', () => {
  const item = { kind: 'task', actionItemId: 'ai-1' };
  assert.strictEqual(titleEditable(item, true), true);
});

test('titleEditable: no durable id -> no editor, even with content-edit standing', () => {
  const item = { kind: 'task', actionItemId: null };
  assert.strictEqual(titleEditable(item, true), false);
});

test('titleEditable: missing actionItemId key entirely -> no editor', () => {
  const item = { kind: 'task' };
  assert.strictEqual(titleEditable(item, true), false);
});

test('titleEditable: no content-edit standing -> no editor, even with a durable id', () => {
  const item = { kind: 'task', actionItemId: 'ai-1' };
  assert.strictEqual(titleEditable(item, false), false);
});

test('titleEditable: neither id nor permission -> no editor', () => {
  const item = { kind: 'task', actionItemId: null };
  assert.strictEqual(titleEditable(item, false), false);
});

test('titleEditable: an "urgent" row is never title-editable through this path, even with id + permission', () => {
  const item = { kind: 'urgent', actionItemId: 'ai-1' };
  assert.strictEqual(titleEditable(item, true), false);
});

test('titleEditable: an "activity" row is never title-editable through this path', () => {
  const item = { kind: 'activity', actionItemId: 'ai-1' };
  assert.strictEqual(titleEditable(item, true), false);
});

test('titleEditable: null/undefined item never throws, always false', () => {
  assert.strictEqual(titleEditable(null, true), false);
  assert.strictEqual(titleEditable(undefined, true), false);
});
