'use strict';
const test = require('node:test');
const assert = require('node:assert');

global.window = { FieldSight: {}, FS: { api: { useMocks: true, writeMocks: true, delay: () => Promise.resolve() } } };
require('../scripts/mock/daily-report.fixture.js');
const actions = (() => { require('../scripts/api/actions.js'); return window.FS.api.actions; })();

const reports = window.FieldSight.fixtures.reports;
const allTopics = Object.values(reports).flatMap((byUser) => Object.values(byUser)).flatMap((r) => r.topics || []);

test('every fixture topic carries a session_kind', () => {
  for (const t of allTopics) assert.ok(['extraction', 'report'].includes(t.session_kind), JSON.stringify(t.topic_title));
});

test('exactly the report-kind topics have a null session_id, and there is at least one', () => {
  const report = allTopics.filter((t) => t.session_kind === 'report');
  assert.ok(report.length >= 1);
  for (const t of report) assert.strictEqual(t.session_id, null);
  for (const t of allTopics.filter((x) => x.session_kind === 'extraction')) assert.ok(t.session_id);
});

test('action items carry version: default 1, one 2, one 3', () => {
  const items = allTopics.flatMap((t) => t.action_items || []);
  for (const a of items) assert.strictEqual(typeof a.version, 'number');
  assert.strictEqual(items.filter((a) => a.version === 2).length, 1);
  assert.strictEqual(items.filter((a) => a.version === 3).length, 1);
});

test('mock history for a fixture action item returns version-1 edits, newest first', async () => {
  const res = await actions.getContentHistory('action_items', '55c48cd4-b3e5-43d8-8a5e-7991fbc1998f');
  assert.strictEqual(res.edits.length, 2);
  assert.ok(res.edits[0].created_at > res.edits[1].created_at);
  assert.deepStrictEqual((await actions.getContentHistory('action_items', 'not-in-fixture')).edits, []);
  assert.deepStrictEqual((await actions.getContentHistory('topics', '7d0c0000-0429-4a29-9b00-000000000000')).edits, []);
});
