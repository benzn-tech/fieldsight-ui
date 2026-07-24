'use strict';

/*
 * Unit tests for Q1 — tier-aware Today/Tasks (tasks-aggregator.js side).
 *
 * Same rules as today-adapter.js (see tests/q1-today-adapter-tiers.test.js):
 *   - redacted topic        -> its action items are OMITTED from the rows.
 *   - work_class:'non_work' -> rows still surface, tagged work_class:'non_work'.
 *   - missing/other value   -> treated as work, threaded through verbatim.
 *
 * getActionsResolvedRange() is async and fans out over several
 * window.FS.api.* endpoints. We stub the minimal surface needed to drive
 * it down the single-explicit-user path (no admin fan-out) for one date
 * with one report carrying all three topic tiers.
 */
const test = require('node:test');
const assert = require('node:assert');

const REPORT = {
  user_name: 'Jane Doe',
  site: 'Test Site',
  topics: [
    { topic_id: 1, category: 'progress', redacted: true,
      action_items: [{ action: 'redacted item', responsible: 'Jane Doe' }] },
    { topic_id: 2, category: 'progress', work_class: 'non_work',
      action_items: [{ action: 'personal item', responsible: 'Jane Doe' }] },
    { topic_id: 3, category: 'progress',
      action_items: [{ action: 'work item', responsible: 'Jane Doe' }] },
  ],
};

global.window = {
  AuthMock: { currentUser: { name: 'Jane Doe', role: 'admin' } },
  FS: {
    api: {
      folderName: function (name) { return String(name || '').replace(/ /g, '_'); },
      actions: {
        lookupAction: function () { return undefined; },
        getActionsRange: function () { return Promise.resolve({ byDate: {} }); },
      },
      org: {
        getOrgSites: function () { return Promise.resolve({ sites: [] }); },
      },
      window: {
        getSpan: function () {
          return Promise.resolve({ dates: { '2026-07-20': { hasReport: true } } });
        },
      },
      timeline: {
        getTimeline: function () { return Promise.resolve(REPORT); },
      },
      pooledAll: function () { throw new Error('must not take the admin fan-out path in this test'); },
    },
  },
};
global.React = {};
global.document = { addEventListener() {}, removeEventListener() {} };

require('../scripts/api/tasks-aggregator.js');
const getActionsResolvedRange = global.window.FS.api.tasks.getActionsResolvedRange;

test('getActionsResolvedRange: redacted topic omitted, non_work present-and-tagged, work present', async () => {
  /* Explicit `user` avoids the admin folders fan-out (resolveUser returns
     opts.user verbatim for a non-worker caller), keeping this a single-
     report, single-date pass through the flatten loop under test. */
  const result = await getActionsResolvedRange({ from: '2026-07-20', to: '2026-07-20', user: 'Jane_Doe' });

  assert.strictEqual(result.rows.length, 2, 'the redacted topic\'s row must not appear at all');

  const byAction = {};
  result.rows.forEach((r) => { byAction[r.action] = r; });

  assert.strictEqual(byAction['redacted item'], undefined, 'redacted topic omitted entirely');
  assert.ok(byAction['personal item'], 'non_work topic action item still surfaces');
  assert.strictEqual(byAction['personal item'].work_class, 'non_work');
  assert.ok(byAction['work item'], 'plain work topic action item surfaces');
  assert.strictEqual(byAction['work item'].work_class, undefined, 'missing work_class threaded through verbatim, never normalised');
});
