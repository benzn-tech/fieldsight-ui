'use strict';

/*
 * Unit tests for fix/closed-by-display — the "Checked by <name> · <time>"
 * caption silently stopped appearing once check-off moved from the
 * unauthenticated DynamoDB gateway (writes checked_by/checked_at) to the
 * authorised Aurora org PATCH (writes updated_by/updated_by_name/updated_at,
 * no checked_by/checked_at at all).
 *
 * Covers:
 *   - scripts/composites/action-item-row.js's resolveCloser (overlay-first,
 *     Aurora-column fallback) and formatCloserCaption (null-name handling)
 *   - the mount contract for a per-action-item ContentHistoryPanel
 *     (table:'action_items', id: the row's durable id) — see
 *     scripts/pages/tasks.js's TasksRightDetail.
 *
 * action-item-row.js is a browser IIFE that only registers onto
 * window.FieldSight at load, so a minimal window/React stub is enough to
 * require it under Node (same posture as tests/date-parse.test.js loading
 * date-picker.js).
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = {
  FieldSight: {},
  FS: {
    api: {
      resolveDeadline: function (deadline) { return { absolute: null, display: deadline || '—' }; },
      isMineTask:      function () { return false; },
    },
  },
};
require('../scripts/api/mine-team.js');
require('../scripts/api/actions.js');   // real isActionResolved — same posture as q1-tasks-page-buckets.test.js
global.React = {
  useState:      function (v) { return [v, function () {}]; },
  useRef:        function (v) { return { current: v }; },
  useEffect:     function () {},
  useContext:    function () { return null; },
  createContext: function (def) { return { Provider: 'Provider', _def: def }; },
  createElement: function () { return null; },
  Fragment:      'Fragment',
};
global.document = { addEventListener() {}, removeEventListener() {} };

const { resolveCloser, formatCloserCaption, isColumnDone } =
  require('../scripts/composites/action-item-row.js');

/* ---- resolveCloser: overlay first, whole-pair, never mixed ---------------- */

test('resolveCloser prefers the DynamoDB overlay when it has anything at all', () => {
  const closer = resolveCloser(
    { checkedBy: 'David_Barillaro', checkedAt: '2026-03-09T10:00:00Z' },
    { status: 'done', updated_by_name: 'Someone_Else', updated_at: '2026-07-24T13:40:00Z' });
  assert.deepStrictEqual(closer, { by: 'David_Barillaro', at: '2026-03-09T10:00:00Z' });
});

test('resolveCloser falls back to the Aurora column when the overlay is empty and the column says done', () => {
  const closer = resolveCloser(
    { checkedBy: undefined, checkedAt: undefined },
    { status: 'done', updated_by_name: 'Ben_UCPK', updated_at: '2026-07-24T13:40:00.562587+00:00' });
  assert.deepStrictEqual(closer, { by: 'Ben_UCPK', at: '2026-07-24T13:40:00.562587+00:00' });
});

test('resolveCloser falls back to the Aurora column even when updated_by_name is null (unprovisioned/nameless account)', () => {
  const closer = resolveCloser(
    {},
    { status: 'done', updated_by_name: null, updated_at: '2026-07-24T13:40:00.562587+00:00' });
  assert.deepStrictEqual(closer, { by: null, at: '2026-07-24T13:40:00.562587+00:00' });
});

test('resolveCloser never mixes an overlay name with an Aurora timestamp or vice versa', () => {
  /* overlay has a name but no time; Aurora column has a full pair — the
     overlay branch still wins as a WHOLE pair (by:name, at:null), not a
     Frankenstein of overlay-by + aurora-at. */
  const closer = resolveCloser(
    { checkedBy: 'David_Barillaro', checkedAt: undefined },
    { status: 'done', updated_by_name: 'Ben_UCPK', updated_at: '2026-07-24T13:40:00Z' });
  assert.deepStrictEqual(closer, { by: 'David_Barillaro', at: null });
});

test('resolveCloser returns nothing for an item that is not done at all', () => {
  const closer = resolveCloser({}, { status: 'open' });
  assert.deepStrictEqual(closer, { by: null, at: null });
});

test('isColumnDone is false for a missing/undefined action', () => {
  assert.strictEqual(isColumnDone({}), false);
  assert.strictEqual(isColumnDone({ action: null }), false);
});

/* ---- formatCloserCaption: null-name handling, never "null" / a raw uuid --- */

test('formatCloserCaption renders "Checked by X · <time>" when both are known', () => {
  const caption = formatCloserCaption({ by: 'Ben_UCPK', at: '2026-07-24T13:40:00.562587+00:00' });
  assert.match(caption, /^Checked by Ben_UCPK · /);
});

test('formatCloserCaption shows the time alone when the name is null — never invents a name', () => {
  const caption = formatCloserCaption({ by: null, at: '2026-07-24T13:40:00.562587+00:00' });
  assert.ok(caption, 'a real closer (even nameless) must still show something');
  assert.doesNotMatch(caption, /Checked by/, 'no name is known, so no "Checked by" prefix');
  assert.doesNotMatch(caption, /null/i, 'must never render the literal string "null"');
  assert.doesNotMatch(caption, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    'must never fall back to a raw uuid');
});

test('formatCloserCaption shows the name alone when the timestamp is unparseable', () => {
  const caption = formatCloserCaption({ by: 'Ben_UCPK', at: 'not-a-real-timestamp' });
  assert.strictEqual(caption, 'Checked by Ben_UCPK');
});

test('formatCloserCaption returns null when there is nothing to show (no name, no time)', () => {
  assert.strictEqual(formatCloserCaption({ by: null, at: null }), null);
});

/* ---- ContentHistoryPanel mount contract for a per-action-item history ----- */
/* tasks.js's TasksRightDetail mounts window.FieldSight.ContentHistoryPanel
   (exported by timeline.js — window.FieldSight.ContentHistoryPanel, since
   timeline.js?v=44 loads before tasks.js?v=19 in app-shell-preview.html)
   via actionItemHistoryProps(row): pulled out as its own pure function so
   the mount contract is testable without rendering the whole panel. */
delete require.cache[require.resolve('../scripts/pages/tasks.js')];
const { actionItemHistoryProps } = require('../scripts/pages/tasks.js');

test('actionItemHistoryProps mounts table:"action_items" with THIS row\'s durable id', () => {
  const row = { actionItemId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', topic_id: 2, action_index: 1 };
  assert.deepStrictEqual(actionItemHistoryProps(row),
    { table: 'action_items', id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
});

test('actionItemHistoryProps is null for an older, id-less row (nothing durable to fetch)', () => {
  assert.strictEqual(actionItemHistoryProps({ actionItemId: null, topic_id: 2, action_index: 1 }), null);
  assert.strictEqual(actionItemHistoryProps(null), null);
});
