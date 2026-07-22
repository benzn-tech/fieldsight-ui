'use strict';

/*
 * Unit tests for the life-conversation-separation optimistic-override helpers
 * in scripts/pages/timeline.js (Q2 follow-up: make 标为个人+移除 / 恢复 move the
 * topic between the visible list and the "已移除 / 个人" area IMMEDIATELY,
 * without waiting for a getTimeline refetch that hits the org-api warm-Lambda
 * read-after-write lag).
 *
 * timeline.js is a browser IIFE that registers on window.FieldSight.PAGES and
 * only touches React inside component bodies (never at load). Stub both globals
 * so requiring it in Node runs the IIFE (registration is a harmless no-op on the
 * stub) and hands us the pure helpers via its (browser-guarded) module.exports.
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
global.React = global.React || {};

const {
  applyTopicOverrides,
  partitionTopics,
  reconcileTopicOverrides,
} = require('../scripts/pages/timeline.js');

/* ---- applyTopicOverrides ------------------------------------------------- */

test('applyTopicOverrides returns topics unchanged when there are no overrides', () => {
  const topics = [{ topic_id: 1, topic_row_id: 'a', redacted: false }];
  assert.deepStrictEqual(applyTopicOverrides(topics, {}), topics);
  assert.deepStrictEqual(applyTopicOverrides(topics, undefined), topics);
});

test('applyTopicOverrides merges a patch onto the topic whose topic_row_id matches, leaving others untouched', () => {
  const topics = [
    { topic_id: 1, topic_row_id: 'a', redacted: false },
    { topic_id: 2, topic_row_id: 'b', redacted: false },
  ];
  const overrides = { b: { redacted: true, redaction_id: 'r-b' } };
  const out = applyTopicOverrides(topics, overrides);

  assert.deepStrictEqual(out[0], { topic_id: 1, topic_row_id: 'a', redacted: false });
  assert.deepStrictEqual(out[1], { topic_id: 2, topic_row_id: 'b', redacted: true, redaction_id: 'r-b' });
});

test('applyTopicOverrides does not mutate the input topic objects', () => {
  const topic = { topic_id: 2, topic_row_id: 'b', redacted: false };
  const topics = [topic];
  applyTopicOverrides(topics, { b: { redacted: true } });
  assert.strictEqual(topic.redacted, false, 'source topic must be left intact');
});

test('applyTopicOverrides ignores topics that carry no topic_row_id (meeting topics)', () => {
  const topics = [{ topic_id: 5, redacted: false }];   // no topic_row_id
  const out = applyTopicOverrides(topics, { undefined: { redacted: true } });
  assert.strictEqual(out[0].redacted, false);
});

test('applyTopicOverrides tolerates a null/undefined topics list', () => {
  assert.deepStrictEqual(applyTopicOverrides(null, { a: { redacted: true } }), []);
});

/* ---- partitionTopics ----------------------------------------------------- */

test('partitionTopics splits on the redacted flag, preserving order', () => {
  const topics = [
    { topic_id: 1, redacted: false },
    { topic_id: 2, redacted: true },
    { topic_id: 3, redacted: false },
    { topic_id: 4, redacted: true },
  ];
  const { visible, removed } = partitionTopics(topics);
  assert.deepStrictEqual(visible.map((t) => t.topic_id), [1, 3]);
  assert.deepStrictEqual(removed.map((t) => t.topic_id), [2, 4]);
});

test('partitionTopics tolerates a null/undefined list', () => {
  assert.deepStrictEqual(partitionTopics(null), { visible: [], removed: [] });
});

/* ---- reconcileTopicOverrides --------------------------------------------- */

test('reconcileTopicOverrides drops a redact override once the server has caught up', () => {
  // Optimistically redacted; the fresh report now agrees -> override retired.
  const overrides = { b: { redacted: true, redaction_id: 'r-b' } };
  const fresh = [{ topic_id: 2, topic_row_id: 'b', redacted: true, redaction_id: 'r-b' }];
  assert.deepStrictEqual(reconcileTopicOverrides(overrides, fresh), {});
});

test('reconcileTopicOverrides keeps a redact override while the server read is still stale', () => {
  // Warm-Lambda stale snapshot: fresh report still shows the topic as visible.
  const overrides = { b: { redacted: true, redaction_id: 'r-b' } };
  const fresh = [{ topic_id: 2, topic_row_id: 'b', redacted: false, redaction_id: null }];
  assert.deepStrictEqual(reconcileTopicOverrides(overrides, fresh), overrides);
});

test('reconcileTopicOverrides retires a revert override (redacted:false, redaction_id:null) once server agrees, treating null == undefined', () => {
  const overrides = { b: { redacted: false, redaction_id: null } };
  // server dropped the redaction_id field entirely (undefined) and reads false
  const fresh = [{ topic_id: 2, topic_row_id: 'b', redacted: false }];
  assert.deepStrictEqual(reconcileTopicOverrides(overrides, fresh), {});
});

test('reconcileTopicOverrides keeps a revert override while the server still reports it redacted', () => {
  const overrides = { b: { redacted: false, redaction_id: null } };
  const fresh = [{ topic_id: 2, topic_row_id: 'b', redacted: true, redaction_id: 'r-b' }];
  assert.deepStrictEqual(reconcileTopicOverrides(overrides, fresh), overrides);
});

test('reconcileTopicOverrides drops only the caught-up fields and keeps the rest', () => {
  // server caught up on redacted, but not yet on redaction_id
  const overrides = { b: { redacted: true, redaction_id: 'r-b' } };
  const fresh = [{ topic_id: 2, topic_row_id: 'b', redacted: true, redaction_id: null }];
  assert.deepStrictEqual(reconcileTopicOverrides(overrides, fresh), { b: { redaction_id: 'r-b' } });
});

test('reconcileTopicOverrides keeps an override whose topic is absent from the fresh report', () => {
  const overrides = { b: { redacted: true } };
  const fresh = [{ topic_id: 9, topic_row_id: 'z', redacted: false }];
  assert.deepStrictEqual(reconcileTopicOverrides(overrides, fresh), overrides);
});

test('reconcileTopicOverrides returns {} for empty overrides', () => {
  assert.deepStrictEqual(reconcileTopicOverrides({}, [{ topic_row_id: 'a', redacted: true }]), {});
  assert.deepStrictEqual(reconcileTopicOverrides(undefined, []), {});
});

/* ---- integration: the full reviewer sequence ----------------------------- */
/* Mirrors exactly how TimelineMiddleColumn wires the helpers: on a review click
   it MERGES a patch into overrides (onRefresh); on every render it partitions
   applyTopicOverrides(report.topics, overrides); on each refetch it reconciles.
   This is the state machine the user actually drives — remove, then restore —
   across the org-api read-after-write lag. */
test('integration: remove moves the topic to 已移除 instantly and survives a stale refetch; restore moves it back', () => {
  // Server truth, before any action: two visible topics.
  var serverTopics = [
    { topic_id: 1, topic_row_id: 'x', redacted: false },
    { topic_id: 2, topic_row_id: 'y', redacted: false },
  ];
  var overrides = {};
  function render(topics) { return partitionTopics(applyTopicOverrides(topics, overrides)); }

  // 0) Baseline render — both visible.
  assert.deepStrictEqual(render(serverTopics).visible.map((t) => t.topic_id), [1, 2]);
  assert.deepStrictEqual(render(serverTopics).removed.map((t) => t.topic_id), []);

  // 1) Click 标为个人+移除 on X — createRedaction returns { redaction: { id:'r1' } }.
  //    onRefresh merges the patch (no refetch on the optimistic path).
  overrides = Object.assign({}, overrides, { x: Object.assign({}, overrides.x, { redacted: true, redaction_id: 'r1' }) });
  var afterRemove = render(serverTopics);
  assert.deepStrictEqual(afterRemove.visible.map((t) => t.topic_id), [2], 'X leaves the visible list at once');
  assert.deepStrictEqual(afterRemove.removed.map((t) => t.topic_id), [1], 'X lands in 已移除 / 个人 immediately');
  assert.strictEqual(afterRemove.removed[0].redaction_id, 'r1', 'the removed row carries its id so 恢复 is enabled');

  // 2) A later detail-less refetch reads the STALE warm-Lambda snapshot (X still
  //    visible). Reconcile keeps the patch; the topic must NOT flicker back.
  overrides = reconcileTopicOverrides(overrides, serverTopics /* stale: x.redacted still false */);
  assert.deepStrictEqual(render(serverTopics).removed.map((t) => t.topic_id), [1], 'stale refetch does not un-remove X');

  // 3) The next refetch reads FRESH truth (X redacted). Reconcile retires the
  //    patch; the removal is now server-authoritative.
  serverTopics = [
    { topic_id: 1, topic_row_id: 'x', redacted: true, redaction_id: 'r1' },
    { topic_id: 2, topic_row_id: 'y', redacted: false },
  ];
  overrides = reconcileTopicOverrides(overrides, serverTopics);
  assert.deepStrictEqual(overrides, {}, 'patch retired once server caught up');
  assert.deepStrictEqual(render(serverTopics).removed.map((t) => t.topic_id), [1]);

  // 4) Click 恢复 on X from the removed area — revertRedaction, then patch
  //    { redacted:false, redaction_id:null }. X returns to visible at once,
  //    even though server still reads it redacted (lag again).
  overrides = Object.assign({}, overrides, { x: { redacted: false, redaction_id: null } });
  var afterRestore = render(serverTopics /* still stale: x.redacted true */);
  assert.deepStrictEqual(afterRestore.visible.map((t) => t.topic_id), [1, 2], 'X restored to the visible list immediately');
  assert.deepStrictEqual(afterRestore.removed.map((t) => t.topic_id), []);

  // 5) Fresh refetch (X no longer redacted) reconciles the restore away.
  serverTopics = [
    { topic_id: 1, topic_row_id: 'x', redacted: false },
    { topic_id: 2, topic_row_id: 'y', redacted: false },
  ];
  overrides = reconcileTopicOverrides(overrides, serverTopics);
  assert.deepStrictEqual(overrides, {}, 'restore patch retired once server agrees');
  assert.deepStrictEqual(render(serverTopics).visible.map((t) => t.topic_id), [1, 2]);
});
