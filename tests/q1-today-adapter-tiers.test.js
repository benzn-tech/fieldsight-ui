'use strict';

/*
 * Unit tests for Q1 — tier-aware Today/Tasks (today-adapter.js side).
 *
 * A topic carries `work_class` and `redacted` (the org-api /timeline
 * "aurora" shape). today-adapter.js flattens topics -> action items for
 * Today's myTasks/teamTasks lists. Q1 rules:
 *   - redacted topic       -> its action items are OMITTED entirely.
 *   - work_class:'non_work'-> its action items are still flattened, and
 *                             carry work_class:'non_work' through (Today
 *                             itself excludes them from the open-items
 *                             COUNT and flags them "Possibly personal" —
 *                             see tests/q1-today-page-counts.test.js).
 *   - missing/other value  -> treated as work; work_class is threaded
 *                             through verbatim (undefined stays undefined
 *                             — never normalised to 'work' here).
 *
 * today-adapter.js is a browser IIFE that assigns onto
 * window.FS.api.todayAdapter (see tests/date-parse.test.js for the same
 * require-under-Node pattern). Stub the small surface adapt() actually
 * touches: window.FS.api.folderName + window.FS.api.actions.lookupAction.
 * fix/mine-team-attribution — adapt() now also calls window.FS.api
 * .isMineTask; load the REAL mine-team.js module (not a fake stub) so
 * these tests exercise the actual shared predicate, same as production.
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = {
  FieldSight: {},
  FS: {
    api: {
      folderName: function (name) { return String(name || '').replace(/ /g, '_'); },
      actions: {
        lookupAction: function () { return undefined; }, // no audit overlay in these tests
      },
    },
  },
};
global.React = {};
global.document = { addEventListener() {}, removeEventListener() {} };

require('../scripts/api/mine-team.js');
require('../scripts/api/today-adapter.js');
const adapt = global.window.FS.api.todayAdapter.adapt;

function baseReport(topics) {
  return {
    report_date: '2026-07-20',
    site: 'Test Site',
    user_name: 'Jane Doe',
    executive_summary: [],
    topics: topics,
    safety_observations: [],
  };
}

const CTX = { currentUserName: 'Jane Doe', nowMinutes: 16 * 60 };

/* ---- redacted topic -> action items omitted entirely --------------------- */

test('adapt: a redacted topic\'s action items never appear in myTasks or teamTasks', () => {
  const report = baseReport([
    {
      topic_id: 1,
      topic_title: 'Personal call',
      redacted: true,
      action_items: [{ action: 'do the thing', responsible: 'Jane Doe', priority: 'medium' }],
    },
  ]);
  const out = adapt(report, CTX);
  assert.deepStrictEqual(out.myTasks, []);
  assert.deepStrictEqual(out.teamTasks, []);
});

test('adapt: a redacted topic is omitted even when its action items would have gone to teamTasks', () => {
  const report = baseReport([
    {
      topic_id: 1,
      redacted: true,
      action_items: [{ action: 'do the thing', responsible: 'Someone Else', priority: 'medium' }],
    },
  ]);
  const out = adapt(report, CTX);
  assert.deepStrictEqual(out.myTasks, []);
  assert.deepStrictEqual(out.teamTasks, []);
});

/* ---- non_work topic -> present, tagged, still flattened ------------------ */

test('adapt: a non_work topic\'s action items are still flattened and carry work_class through', () => {
  const report = baseReport([
    {
      topic_id: 2,
      topic_title: 'Personal errand',
      work_class: 'non_work',
      redacted: false,
      action_items: [{ action: 'pick up dry cleaning', responsible: 'Jane Doe', priority: 'low' }],
    },
  ]);
  const out = adapt(report, CTX);
  assert.strictEqual(out.myTasks.length, 1);
  assert.strictEqual(out.myTasks[0].work_class, 'non_work');
  assert.strictEqual(out.myTasks[0].title, 'pick up dry cleaning');
});

/* ---- work / undefined -> treated as work, threaded through verbatim ------ */

test('adapt: an explicit work_class:"work" topic threads work_class through unchanged', () => {
  const report = baseReport([
    {
      topic_id: 3,
      work_class: 'work',
      action_items: [{ action: 'pour concrete', responsible: 'Jane Doe', priority: 'high' }],
    },
  ]);
  const out = adapt(report, CTX);
  assert.strictEqual(out.myTasks.length, 1);
  assert.strictEqual(out.myTasks[0].work_class, 'work');
});

test('adapt: a topic with no work_class field at all is still included, work_class undefined (never normalised)', () => {
  const report = baseReport([
    {
      topic_id: 4,
      // no work_class key present — matches most historical topics.
      action_items: [{ action: 'inspect the scaffold', responsible: 'Jane Doe', priority: 'medium' }],
    },
  ]);
  const out = adapt(report, CTX);
  assert.strictEqual(out.myTasks.length, 1);
  assert.strictEqual(out.myTasks[0].work_class, undefined);
});

/* ---- mixed report: redacted omitted, non_work present, work present ------ */

test('adapt: a report mixing all three tiers surfaces only the non-redacted ones, each correctly tagged', () => {
  const report = baseReport([
    { topic_id: 1, redacted: true, action_items: [{ action: 'redacted item', responsible: 'Jane Doe' }] },
    { topic_id: 2, work_class: 'non_work', action_items: [{ action: 'personal item', responsible: 'Jane Doe' }] },
    { topic_id: 3, action_items: [{ action: 'work item', responsible: 'Jane Doe' }] },
  ]);
  const out = adapt(report, CTX);
  const titles = out.myTasks.map((t) => t.title).sort();
  assert.deepStrictEqual(titles, ['personal item', 'work item']);
  const byTitle = {};
  out.myTasks.forEach((t) => { byTitle[t.title] = t.work_class; });
  assert.strictEqual(byTitle['personal item'], 'non_work');
  assert.strictEqual(byTitle['work item'], undefined);
});
