'use strict';

/*
 * Unit tests for content-propagate (item #3) — intra-topic correction
 * propagation. Backend contract (already live on test):
 *   POST /api/org/topics/{topic_id}/propagate/preview  — read-only preview
 *   POST /api/org/topics/{topic_id}/propagate          — apply, all-or-nothing
 * Both take { before, after }. patch_content forbids batching a fix across
 * rows ("exactly one editable field required"), so correcting a name in
 * topics.summary leaves the same wrong name in e.g. every
 * action_items.responsible cell — this preview-then-confirm pair closes
 * that gap.
 *
 * Two layers, mirroring this repo's existing split (tests/checkoff-org-api
 * for the API layer, tests/mine-team-attribution Group 3 for a hook-driven
 * page function):
 *   A. scripts/api/actions.js — previewTopicCorrection/applyTopicCorrection/
 *      propagateLive: path+body, the aurora gate, and that 403/404/409 are
 *      never swallowed.
 *   B. scripts/pages/timeline.js — findCorrectionPair (pure term-diff) and
 *      TopicCorrectionPropagate (the affordance itself), driven through a
 *      tiny hand-rolled hook host (this codebase has no react-dom/test
 *      renderer dependency — see the harness below) so the ACTUAL shipped
 *      component logic is exercised, not a re-implementation of it.
 */
const test = require('node:test');
const assert = require('node:assert');

/* =========================================================================
   Group A — scripts/api/actions.js
   ========================================================================= */

let calls;
let orgResponse;
let orgRejects;

function resetActionsEnv(overrides) {
  calls = { org: [] };
  orgResponse = null;
  orgRejects = null;
  global.window = {
    FieldSight: { fixtures: { actions: {} } },
    FS: {
      api: Object.assign({
        useMocks:       false,
        writeMocks:     false,
        timelineSource: 'aurora',
        orgBaseUrl:     'https://org.example/prod/api',
        delay:          function () { return Promise.resolve(); },
        orgRequest:     function (path, opts) {
          calls.org.push({ path: path, method: opts.method, body: opts.body });
          if (orgRejects) return Promise.reject(orgRejects);
          return Promise.resolve(orgResponse);
        },
        request: function () { return Promise.resolve({}); },
      }, overrides || {}),
      actionsBus: { emit: function () {} },
      toast:      { show: function () {} },
    },
  };
  delete require.cache[require.resolve('../scripts/api/actions.js')];
  return require('../scripts/api/actions.js');
}

test('propagateLive is true only when aurora + orgBaseUrl + real writes are all on', () => {
  assert.strictEqual(resetActionsEnv().propagateLive(), true);
  assert.strictEqual(resetActionsEnv({ timelineSource: 'report' }).propagateLive(), false,
    'report-source timeline has no durable topic ids to propagate against');
  assert.strictEqual(resetActionsEnv({ orgBaseUrl: '' }).propagateLive(), false);
  assert.strictEqual(resetActionsEnv({ useMocks: true }).propagateLive(), false);
  assert.strictEqual(resetActionsEnv({ writeMocks: true }).propagateLive(), false);
});

test('previewTopicCorrection POSTs /topics/{id}/propagate/preview with {before, after}', async () => {
  const m = resetActionsEnv();
  orgResponse = { topic_id: 't1', field_count: 2, occurrence_count: 2, matches: [] };

  const res = await m.previewTopicCorrection('t1', 'Sean', 'Shaun');

  assert.deepStrictEqual(calls.org, [{
    path:   '/topics/t1/propagate/preview',
    method: 'POST',
    body:   { before: 'Sean', after: 'Shaun' },
  }]);
  assert.strictEqual(res.field_count, 2);
});

test('applyTopicCorrection POSTs /topics/{id}/propagate with {before, after}', async () => {
  const m = resetActionsEnv();
  orgResponse = { topic_id: 't1', changed_count: 6, changed: [], reindex_enqueued: true };

  const res = await m.applyTopicCorrection('t1', 'Sean', 'Shaun');

  assert.deepStrictEqual(calls.org, [{
    path:   '/topics/t1/propagate',
    method: 'POST',
    body:   { before: 'Sean', after: 'Shaun' },
  }]);
  assert.strictEqual(res.changed_count, 6);
});

test('previewTopicCorrection encodes the topic id in the path', async () => {
  const m = resetActionsEnv();
  orgResponse = { field_count: 0 };
  await m.previewTopicCorrection('weird id/with?chars', 'a', 'b');
  assert.strictEqual(calls.org[0].path, '/topics/weird%20id%2Fwith%3Fchars/propagate/preview');
});

test('a 403 from preview or apply RESOLVES the envelope untouched, never swallowed', async () => {
  const m = resetActionsEnv();
  orgResponse = { _accessDenied: true, status: 403, error: 'site_manager+ only for this site' };

  const preview = await m.previewTopicCorrection('t1', 'Sean', 'Shaun');
  assert.strictEqual(preview._accessDenied, true);
  assert.match(preview.error, /site_manager\+ only/);

  const apply = await m.applyTopicCorrection('t1', 'Sean', 'Shaun');
  assert.strictEqual(apply._accessDenied, true);
});

test('a 404 from preview or apply RESOLVES {_notFound}, never swallowed', async () => {
  const m = resetActionsEnv();
  orgResponse = { _notFound: true, status: 404 };

  assert.strictEqual((await m.previewTopicCorrection('t1', 'a', 'b'))._notFound, true);
  assert.strictEqual((await m.applyTopicCorrection('t1', 'a', 'b'))._notFound, true);
});

test('a 409 on apply REJECTS (nothing was written) rather than resolving ok', async () => {
  const m = resetActionsEnv();
  orgRejects = Object.assign(new Error('HTTP 409'), { status: 409 });

  await assert.rejects(() => m.applyTopicCorrection('t1', 'Sean', 'Shaun'), /409/);
});

test('a 400 (unstable after, e.g. "Mackon" -> "Mackon Ltd") REJECTS', async () => {
  const m = resetActionsEnv();
  orgRejects = Object.assign(new Error('HTTP 400'), { status: 400 });

  await assert.rejects(() => m.previewTopicCorrection('t1', 'Mackon', 'Mackon Ltd'), /400/);
});

test('when the aurora gate is off, neither call touches orgRequest — both resolve an inert mock', async () => {
  const m = resetActionsEnv({ timelineSource: 'report' });

  const preview = await m.previewTopicCorrection('t1', 'Sean', 'Shaun');
  const apply   = await m.applyTopicCorrection('t1', 'Sean', 'Shaun');

  assert.strictEqual(calls.org.length, 0);
  assert.strictEqual(preview.field_count, 0);
  assert.strictEqual(apply.changed_count, 0);
});

/* =========================================================================
   Group B — scripts/pages/timeline.js
   ========================================================================= */

/* A plain object stub is enough to require timeline.js — its component
   functions are only DEFINED at require time, never called (mirrors
   tests/content-edit-format.test.js's require of the same file). */
global.window = global.window || {};
global.React  = global.React  || {};
const {
  findCorrectionPair,
  TopicCorrectionPropagate,
} = require('../scripts/pages/timeline.js');

/* ---- findCorrectionPair: pure term-diff --------------------------------- */

test('findCorrectionPair: the real "Sean"->"Shaun" scenario (verified live on test)', () => {
  const pair = findCorrectionPair(
    'The crew watched Sean pour the slab.',
    'The crew watched Shaun pour the slab.',
    ['Shaun']);
  assert.deepStrictEqual(pair, { before: 'Sean', after: 'Shaun' });
});

test('findCorrectionPair: null when the flagged term was a pure insertion, not a substitution', () => {
  const pair = findCorrectionPair('The slab is done.', 'The slab is done, Shaun.', ['Shaun']);
  assert.strictEqual(pair, null);
});

test('findCorrectionPair: null when nothing in the diff matches the candidate list', () => {
  const pair = findCorrectionPair('Sean poured the slab.', 'Shaun poured the slab.', ['SomeoneElse']);
  assert.strictEqual(pair, null);
});

test('findCorrectionPair: null for unchanged text', () => {
  assert.strictEqual(findCorrectionPair('same text', 'same text', ['same']), null);
});

/* ---- TopicCorrectionPropagate: hand-rolled hook host --------------------
   This codebase has no react-dom/test-renderer dependency (var/IIFE/
   React.createElement, no build step) — rather than re-implementing the
   component's decision logic as a second, parallel "pure" function (which
   risks testing something OTHER than what ships), this drives the actual
   exported component through a minimal hook host: index-based useState
   slots that persist across explicit render() calls, and a dep-aware
   useEffect (shallow-compares the dep array so a re-render from a button
   click does NOT re-trigger the preview fetch, matching real React). */
function makeHookHost() {
  var slots = [];
  var idx;
  return {
    reset: function () { idx = 0; },
    useState: function (init) {
      var i = idx++;
      if (slots.length <= i) slots[i] = (typeof init === 'function') ? init() : init;
      var setter = function (v) {
        slots[i] = (typeof v === 'function') ? v(slots[i]) : v;
      };
      return [slots[i], setter];
    },
    useEffect: function (fn, deps) {
      var i = idx++;
      var prev = slots[i];
      var changed = !prev || !deps
        || deps.length !== prev.deps.length
        || deps.some(function (d, k) { return d !== prev.deps[k]; });
      slots[i] = { deps: deps || [] };
      if (changed) fn();
    },
  };
}

function makeElement(type, props) {
  var children = Array.prototype.slice.call(arguments, 2);
  return { type: type, props: props || {}, children: children };
}

function textOf(node) {
  return (node && node.children || []).filter(function (c) { return typeof c === 'string'; }).join('');
}

/* Recursively find every node (in creation order) whose own text contains
   `needle` — used to grab a Button's onClick by its visible label. */
function findByText(tree, needle) {
  var found = [];
  (function walk(node) {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (textOf(node).indexOf(needle) !== -1) found.push(node);
    (node.children || []).forEach(walk);
  })(tree);
  return found;
}

function flush() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

function setupComponentEnv() {
  var calls = { preview: [], apply: [], dispatch: [], toast: [] };
  var previewResult, previewRejects, applyResult, applyRejects;

  global.window = {
    FieldSight: {
      Button: function () {},   // never invoked (createElement is stubbed) — just needs to be truthy
      Badge:  function () {},
    },
    FS: {
      api: {
        actions: {
          previewTopicCorrection: function (topicId, before, after) {
            calls.preview.push({ topicId: topicId, before: before, after: after });
            if (previewRejects) return Promise.reject(previewRejects);
            return Promise.resolve(previewResult);
          },
          applyTopicCorrection: function (topicId, before, after) {
            calls.apply.push({ topicId: topicId, before: before, after: after });
            if (applyRejects) return Promise.reject(applyRejects);
            return Promise.resolve(applyResult);
          },
        },
      },
      toast: { show: function (t) { calls.toast.push(t); } },
    },
    dispatchEvent: function (e) { calls.dispatch.push(e); },
  };
  global.CustomEvent = function (type, opts) {
    this.type = type;
    this.detail = opts && opts.detail;
  };

  var host = makeHookHost();
  global.React = {
    useState:     host.useState,
    useEffect:    host.useEffect,
    createElement: makeElement,
    Fragment:     'Fragment',
  };

  return {
    calls: calls,
    render: function (props) { host.reset(); return TopicCorrectionPropagate(props); },
    setPreview: function (v) { previewResult = v; previewRejects = null; },
    setPreviewRejects: function (e) { previewRejects = e; },
    setApply: function (v) { applyResult = v; applyRejects = null; },
    setApplyRejects: function (e) { applyRejects = e; },
  };
}

const BASE_PROPS = { topicId: 'topic-abc', before: 'Sean', after: 'Shaun' };

test('TopicCorrectionPropagate: calls preview with (topicId, before, after) on mount', async () => {
  const env = setupComponentEnv();
  env.setPreview({ field_count: 0, occurrence_count: 0, matches: [] });

  env.render(BASE_PROPS);   // triggers the mount effect
  await flush();

  assert.deepStrictEqual(env.calls.preview, [
    { topicId: 'topic-abc', before: 'Sean', after: 'Shaun' },
  ]);
});

test('TopicCorrectionPropagate: field_count === 0 renders nothing (silence is correct)', async () => {
  const env = setupComponentEnv();
  env.setPreview({ field_count: 0, occurrence_count: 0, matches: [] });

  env.render(BASE_PROPS);
  await flush();
  const tree = env.render(BASE_PROPS);

  assert.strictEqual(tree, null);
});

test('TopicCorrectionPropagate: renders the offer + match list when field_count > 0', async () => {
  const env = setupComponentEnv();
  env.setPreview({
    field_count: 6, occurrence_count: 6,
    matches: [
      { table: 'action_items', row_id: 'r1', field: 'responsible', occurrences: 1,
        before_snippet: '…watched Sean pour the slab…', after_snippet: '…watched Shaun pour the slab…' },
    ],
  });

  env.render(BASE_PROPS);
  await flush();
  const tree = env.render(BASE_PROPS);

  assert.notStrictEqual(tree, null);
  assert.ok(findByText(tree, 'Also fix 6 other place').length > 0);
  assert.ok(findByText(tree, '…watched Sean pour the slab… → …watched Shaun pour the slab…').length > 0);
});

test('TopicCorrectionPropagate: apply is NOT called without explicit confirmation', async () => {
  const env = setupComponentEnv();
  env.setPreview({
    field_count: 3, occurrence_count: 3,
    matches: [{ table: 'action_items', row_id: 'r1', field: 'responsible', occurrences: 1,
                before_snippet: 'a', after_snippet: 'b' }],
  });

  env.render(BASE_PROPS);
  await flush();
  var tree = env.render(BASE_PROPS);

  // First render after preview: only the "Fix these too" offer, no apply yet.
  var offerBtn = findByText(tree, 'Fix these too')[0];
  assert.ok(offerBtn, 'expected an unarmed "Fix these too" control');
  assert.strictEqual(env.calls.apply.length, 0);

  // Clicking it only ARMS confirmation — must not call apply.
  offerBtn.props.onClick();
  tree = env.render(BASE_PROPS);
  assert.strictEqual(env.calls.apply.length, 0, 'arming must not itself apply');
  assert.strictEqual(findByText(tree, 'Fix these too').length, 0, 'the offer swaps to the armed confirm state');
  var confirmBtn = findByText(tree, 'Confirm').filter(function (n) { return n.props.onClick; })[0];
  assert.ok(confirmBtn, 'expected an armed confirm control');

  // Only the explicit second click calls apply.
  env.setApply({ topic_id: 'topic-abc', changed_count: 3, changed: [], reindex_enqueued: true });
  confirmBtn.props.onClick();
  await flush();

  assert.strictEqual(env.calls.apply.length, 1);
  assert.deepStrictEqual(env.calls.apply[0], { topicId: 'topic-abc', before: 'Sean', after: 'Shaun' });
});

test('TopicCorrectionPropagate: a successful apply refreshes (detail-less dispatch) and calls onApplied', async () => {
  const env = setupComponentEnv();
  env.setPreview({
    field_count: 1, occurrence_count: 1,
    matches: [{ table: 'findings', row_id: 'r2', field: 'observation', occurrences: 1,
                before_snippet: 'a', after_snippet: 'b' }],
  });
  var applied = false;
  var props = Object.assign({}, BASE_PROPS, { onApplied: function () { applied = true; } });

  env.render(props);
  await flush();
  var tree = env.render(props);
  findByText(tree, 'Fix these too')[0].props.onClick();
  tree = env.render(props);

  env.setApply({ topic_id: 'topic-abc', changed_count: 1, changed: [], reindex_enqueued: true });
  findByText(tree, 'Confirm').filter(function (n) { return n.props.onClick; })[0].props.onClick();
  await flush();

  assert.strictEqual(applied, true);
  assert.strictEqual(env.calls.dispatch.length, 1);
  assert.strictEqual(env.calls.dispatch[0].type, 'fs:timeline-refresh');
  assert.strictEqual(env.calls.dispatch[0].detail, undefined,
    'detail-less dispatch is what makes the listener do a full refetch (see the onRefresh precedent)');
});

test('TopicCorrectionPropagate: a 403 on apply surfaces the server reason, not a generic string', async () => {
  const env = setupComponentEnv();
  env.setPreview({
    field_count: 2, occurrence_count: 2,
    matches: [{ table: 'action_items', row_id: 'r1', field: 'responsible', occurrences: 1,
                before_snippet: 'a', after_snippet: 'b' }],
  });

  env.render(BASE_PROPS);
  await flush();
  var tree = env.render(BASE_PROPS);
  findByText(tree, 'Fix these too')[0].props.onClick();
  tree = env.render(BASE_PROPS);

  env.setApply({ _accessDenied: true, status: 403, error: 'author/pm/site_manager/admin only' });
  findByText(tree, 'Confirm').filter(function (n) { return n.props.onClick; })[0].props.onClick();
  await flush();
  tree = env.render(BASE_PROPS);

  assert.ok(findByText(tree, 'author/pm/site_manager/admin only').length > 0,
    'the server wording must survive, not a generic "could not apply"');
});

test('TopicCorrectionPropagate: a 409 on apply says nothing was written and re-previews', async () => {
  const env = setupComponentEnv();
  env.setPreview({
    field_count: 4, occurrence_count: 4,
    matches: [{ table: 'action_items', row_id: 'r1', field: 'responsible', occurrences: 1,
                before_snippet: 'a', after_snippet: 'b' }],
  });

  env.render(BASE_PROPS);
  await flush();
  var tree = env.render(BASE_PROPS);
  findByText(tree, 'Fix these too')[0].props.onClick();
  tree = env.render(BASE_PROPS);

  assert.strictEqual(env.calls.preview.length, 1);
  env.setApplyRejects(Object.assign(new Error('HTTP 409'), { status: 409 }));
  findByText(tree, 'Confirm').filter(function (n) { return n.props.onClick; })[0].props.onClick();
  await flush();

  // Re-preview fired automatically — nothing was written, so the offered
  // matches must be re-checked rather than assumed still valid.
  assert.strictEqual(env.calls.preview.length, 2, 'a 409 must trigger a fresh preview, not a silent stop');
  assert.ok(env.calls.toast.some(function (t) {
    return /nothing was written/i.test(t.message || '');
  }), 'must say nothing was written, never implying a partial write');
});

test('TopicCorrectionPropagate: an access-denied preview renders nothing exploitable but does not swallow the reason silently', async () => {
  const env = setupComponentEnv();
  env.setPreview({ _accessDenied: true, status: 403, error: 'wrong tier' });

  env.render(BASE_PROPS);
  await flush();
  const tree = env.render(BASE_PROPS);

  assert.ok(findByText(tree, 'wrong tier').length > 0, 'the preview refusal reason must surface, not be swallowed');
});
