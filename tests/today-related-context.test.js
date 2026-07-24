'use strict';

/*
 * Unit tests for feat/related-popup-context — making Today's right-detail
 * "Related" popup (scripts/pages/today.js) worth opening:
 *
 *   getRelated()          "Related" used to mean "any other open task
 *                          with the byte-identical assignee string" — no
 *                          topic/site/time relation at all. Now prefers
 *                          topic-mates (other tasks flattened from the
 *                          SAME parent topic — the same conversation),
 *                          falling back to the old same-assignee rule
 *                          only when the item has no topic-mates.
 *   buildDetailRows()     The popup's row set for a task now includes
 *                          the parent topic's time window, the site, and
 *                          the report date it came from — context that
 *                          used to live only on the main detail panel.
 *   findItemById()         Now also searches programmeTasks (still inert
 *                          today — see today.js's own doc on this pool —
 *                          but a correct, complete lookup regardless).
 *   buildRelatedPreview()  Pure view-model for the popup: resolves via
 *                          findItemById against the CURRENT data
 *                          snapshot, or — when the previewed item has
 *                          since dropped out of every pool (checked off
 *                          elsewhere while the popup was open) — reports
 *                          "not found" WITHOUT the old bare literal
 *                          'Details unavailable.' string.
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

const {
  findItemById, isTopicMate, getRelated, buildDetailRows, buildRelatedPreview,
} = require('../scripts/pages/today.js');

/* ---------------------------------------------------------------------- */
/* getRelated — topic-mate-first, same-assignee fallback                  */
/* ---------------------------------------------------------------------- */

test('getRelated: prefers other tasks from the SAME topic (same date+folder+topic_id) over same-assignee', () => {
  const item = { id: 'x1', kind: 'task', topic_id: 3, date: '2026-07-20', folder: 'Jane_Doe', assignee: 'Jane Doe' };
  const data = {
    myTasks: [
      item,
      { id: 'x2', title: 'topic-mate', status: 'Open', dueTime: 'None set',
        topic_id: 3, date: '2026-07-20', folder: 'Jane_Doe', assignee: 'Someone Else' },
    ],
    teamTasks: [
      { id: 'x3', title: 'same assignee, different topic', status: 'Open', dueTime: 'None set',
        topic_id: 9, date: '2026-07-20', folder: 'Jane_Doe', assignee: 'Jane Doe' },
    ],
  };
  const related = getRelated(data, item);
  assert.deepStrictEqual(related.map((r) => r.id), ['x2']);
});

test('getRelated: falls back to same-assignee when the item has no topic-mates', () => {
  const item = { id: 'x1', kind: 'task', topic_id: 3, date: '2026-07-20', folder: 'Jane_Doe', assignee: 'Jane Doe' };
  const data = {
    myTasks: [item],
    teamTasks: [
      { id: 'x3', title: 'same assignee', status: 'Open', dueTime: 'None set',
        topic_id: 9, date: '2026-07-21', folder: 'Jane_Doe', assignee: 'Jane Doe' },
    ],
  };
  const related = getRelated(data, item);
  assert.deepStrictEqual(related.map((r) => r.id), ['x3']);
});

test('getRelated: topic_id collision across DIFFERENT reports (same topic_id, different date) is not a topic-mate match', () => {
  const item = { id: 'x1', kind: 'task', topic_id: 0, date: '2026-07-20', folder: 'Jane_Doe', assignee: 'Jane Doe' };
  const data = {
    myTasks: [
      item,
      /* Same topic_id (0), different date -> a DIFFERENT report's topic 0,
         not this item's topic. Also a different assignee, so the fallback
         must not pick it up either. */
      { id: 'x2', title: 'unrelated', status: 'Open', dueTime: 'None set',
        topic_id: 0, date: '2026-07-05', folder: 'Jane_Doe', assignee: 'Bob' },
    ],
  };
  assert.deepStrictEqual(getRelated(data, item), []);
});

test('getRelated: topic_id collision across DIFFERENT owners (same topic_id+date, different folder) is not a topic-mate match', () => {
  const item = { id: 'x1', kind: 'task', topic_id: 0, date: '2026-07-20', folder: 'Jane_Doe', assignee: 'Jane Doe' };
  const data = {
    myTasks: [item],
    teamTasks: [
      { id: 'x2', title: 'different owner report', status: 'Open', dueTime: 'None set',
        topic_id: 0, date: '2026-07-20', folder: 'Bob_Smith', assignee: 'Bob' },
    ],
  };
  assert.deepStrictEqual(getRelated(data, item), []);
});

test('getRelated: never includes the item itself', () => {
  const item = { id: 'x1', kind: 'task', topic_id: 3, date: '2026-07-20', folder: 'Jane_Doe', assignee: 'Jane Doe' };
  const data = { myTasks: [item], teamTasks: [] };
  assert.deepStrictEqual(getRelated(data, item), []);
});

test('getRelated: caps at 3 topic-mates', () => {
  const item = { id: 'x1', kind: 'task', topic_id: 3, date: '2026-07-20', folder: 'Jane_Doe', assignee: 'Jane Doe' };
  const mates = [1, 2, 3, 4].map((n) => ({
    id: 'm' + n, title: 't' + n, status: 'Open', dueTime: 'None set',
    topic_id: 3, date: '2026-07-20', folder: 'Jane_Doe', assignee: 'Someone',
  }));
  const data = { myTasks: [item].concat(mates), teamTasks: [] };
  assert.strictEqual(getRelated(data, item).length, 3);
});

test('isTopicMate: false when either side lacks topic_id/date (never throws on a bare comparison)', () => {
  assert.strictEqual(isTopicMate({ topic_id: null, date: 'd' }, { topic_id: null, date: 'd' }), false);
  assert.strictEqual(isTopicMate({ topic_id: 1, date: null }, { topic_id: 1, date: null }), false);
});

/* ---------------------------------------------------------------------- */
/* buildDetailRows — popup context fields for a task                     */
/* ---------------------------------------------------------------------- */

test('buildDetailRows: a task row includes Time/Site/Report date when the item carries them', () => {
  const item = {
    kind: 'task', assignee: 'Jane Doe', dueTime: 'Mon 21 Jul', status: 'Open', priority: 'High',
    timeRange: '14:09 – 14:20', site_name: 'SB1108 Ellesmere College', date: '2026-07-20',
  };
  const rows = buildDetailRows(item);
  const labels = rows.map((r) => r[0]);
  assert.ok(labels.includes('Time'));
  assert.ok(labels.includes('Site'));
  assert.ok(labels.includes('Report date'));
  const byLabel = {};
  rows.forEach((r) => { byLabel[r[0]] = r[1]; });
  assert.strictEqual(byLabel.Time, '14:09 – 14:20');
  assert.strictEqual(byLabel.Site, 'SB1108 Ellesmere College');
  assert.strictEqual(byLabel['Report date'], '2026-07-20');
});

test('buildDetailRows: a task row omits Time/Site/Report date when the item lacks them (never a blank row)', () => {
  const item = { kind: 'task', assignee: 'Jane Doe', dueTime: 'None set', status: 'Open', priority: 'Medium' };
  const rows = buildDetailRows(item);
  const labels = rows.map((r) => r[0]);
  assert.ok(!labels.includes('Time'));
  assert.ok(!labels.includes('Site'));
  assert.ok(!labels.includes('Report date'));
});

test('buildDetailRows: still includes the pre-existing Assignee/Due/Status/Priority rows', () => {
  const item = { kind: 'task', assignee: 'Jane Doe', dueTime: 'None set', status: 'Open', priority: 'Medium' };
  const labels = buildDetailRows(item).map((r) => r[0]);
  assert.deepStrictEqual(labels, ['Assignee', 'Due', 'Status', 'Priority']);
});

/* ---------------------------------------------------------------------- */
/* findItemById — now also searches programmeTasks                        */
/* ---------------------------------------------------------------------- */

test('findItemById: still resolves myTasks/teamTasks/urgent/activity as before', () => {
  const data = {
    urgent: [{ id: 'u1' }], myTasks: [{ id: 'm1' }], teamTasks: [{ id: 't1' }], activity: [{ id: 'a1' }],
  };
  assert.strictEqual(findItemById(data, 'm1').id, 'm1');
  assert.strictEqual(findItemById(data, 't1').id, 't1');
});

test('findItemById: also searches programmeTasks now (not silently skipped)', () => {
  const data = { programmeTasks: [{ id: 'p1', task_id: 'T-1' }] };
  assert.strictEqual(findItemById(data, 'p1').id, 'p1');
});

test('findItemById: unresolvable id returns null, never throws', () => {
  const data = { myTasks: [{ id: 'm1' }] };
  assert.strictEqual(findItemById(data, 'does-not-exist'), null);
  assert.strictEqual(findItemById(data, null), null);
  assert.strictEqual(findItemById(null, 'm1'), null);
});

/* ---------------------------------------------------------------------- */
/* buildRelatedPreview — fixes the "Details unavailable." degradation    */
/* ---------------------------------------------------------------------- */

test('buildRelatedPreview: null when no popup is open', () => {
  assert.strictEqual(buildRelatedPreview({ myTasks: [] }, null, []), null);
});

test('buildRelatedPreview: a resolvable task -> full row set + date/folder/topicId for the Timeline jump', () => {
  const item = {
    id: 'm1', kind: 'task', assignee: 'Jane', dueTime: 'None set', status: 'Open', priority: 'Medium',
    title: 'Fix the thing', date: '2026-07-20', folder: 'Jane_Doe', topic_id: 3,
  };
  const data = { myTasks: [item], teamTasks: [] };
  const state = buildRelatedPreview(data, 'm1', [{ id: 'm1', title: 'Fix the thing', subtitle: 'x' }]);
  assert.strictEqual(state.resolved, true);
  assert.strictEqual(state.title, 'Fix the thing');
  assert.ok(state.rows.length > 0);
  assert.strictEqual(state.date, '2026-07-20');
  assert.strictEqual(state.folder, 'Jane_Doe');
  assert.strictEqual(state.topicId, 3);
});

test('buildRelatedPreview: an id that no longer resolves in `data` (and no longer appears in `related` either) reports unresolved WITHOUT the literal old "Details unavailable." string', () => {
  const data = { myTasks: [], teamTasks: [] };   // item was checked off / dropped
  const state = buildRelatedPreview(data, 'gone-1', []);   // `related` also recomputed empty
  assert.strictEqual(state.resolved, false);
  assert.deepStrictEqual(state.rows, []);
  assert.ok(state.message);
  assert.notStrictEqual(state.message, 'Details unavailable.');
  assert.strictEqual(state.date, null);
});

test('buildRelatedPreview: unresolved-in-data but still named in `related` uses the related card\'s title, not a bare placeholder', () => {
  const data = { myTasks: [], teamTasks: [] };
  const state = buildRelatedPreview(data, 'gone-2', [{ id: 'gone-2', title: 'Old title', subtitle: 'x' }]);
  assert.strictEqual(state.resolved, false);
  assert.strictEqual(state.title, 'Old title');
});
