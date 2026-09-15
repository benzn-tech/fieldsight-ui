'use strict';
const test = require('node:test');
const assert = require('node:assert');

/* Same harness as tests/q1-today-adapter-tiers.test.js. */
global.window = {
  FieldSight: {},
  FS: { api: {
    folderName: (n) => String(n || '').replace(/ /g, '_'),
    actions: { lookupAction: () => undefined },
  } },
};
global.React = {};
global.document = { addEventListener() {}, removeEventListener() {} };
require('../scripts/api/mine-team.js');
require('../scripts/api/today-adapter.js');
const adapt = global.window.FS.api.todayAdapter.adapt;

function tasksOf(topic) {
  const out = adapt({
    report_date: '2026-09-03', site: 'UC PK', user_name: 'Jane Doe',
    executive_summary: [], safety_observations: [], topics: [topic],
  }, { currentUserName: 'Jane Doe', nowMinutes: 16 * 60 });
  return out.myTasks.concat(out.teamTasks);
}

test('session id and kind come from the topic', () => {
  const [t] = tasksOf({ topic_id: 0, session_id: 'S1', session_kind: 'extraction',
    action_items: [{ id: 'ai-1', action: 'x', responsible: 'Jane Doe' }] });
  assert.strictEqual(t.sessionId, 'S1');
  assert.strictEqual(t.sessionKind, 'extraction');
});

test('report topic: null id, report kind', () => {
  const [t] = tasksOf({ topic_id: 0, session_id: null, session_kind: 'report',
    action_items: [{ id: 'ai-1', action: 'x', responsible: 'Jane Doe' }] });
  assert.strictEqual(t.sessionId, null);
  assert.strictEqual(t.sessionKind, 'report');
});

test('version copies from the action item and defaults to 1', () => {
  const ts = tasksOf({ topic_id: 0, action_items: [
    { id: 'a', action: 'x', responsible: 'Jane Doe', version: 3 },
    { id: 'b', action: 'y', responsible: 'Jane Doe' },
    { id: 'c', action: 'z', responsible: 'Jane Doe', version: 0 },
    { id: 'd', action: 'w', responsible: 'Jane Doe', version: '2' },
  ] });
  const byId = Object.fromEntries(ts.map((t) => [t.actionItemId, t]));
  assert.strictEqual(byId.a.version, 3);
  assert.strictEqual(byId.b.version, 1, 'missing version (backend §8.1 not deployed) is 1');
  assert.strictEqual(byId.c.version, 1);
  assert.strictEqual(byId.d.version, 1, 'only a number counts');
  assert.strictEqual(ts[0].sessionId, null);
  assert.strictEqual(ts[0].sessionKind, null);
});
