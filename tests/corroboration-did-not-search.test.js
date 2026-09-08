'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

/* "We did not check the web" is a third thing, and it had nowhere to go.
 *
 * The response body has carried `truncated` and `timed_out` as separate flags
 * from the start, deliberately: a reader who sees three cards deserves to know
 * which happened. The backend now adds a third case that is neither -- the
 * request finished, quickly, and the vendor never ran the search.
 *
 * Measured on OpenRouter 2026-09-08, three runs: a model returned HTTP 200,
 * 1200 tokens, ZERO web results, and prose reading "I'll search the web to
 * verify... Initial results support the claim." Routed through `timed_out`
 * that prints "The check ran out of time" about a four-second request; routed
 * through `not_found` it asserts a search that never ran.
 *
 * The dangerous half is quieter. A body saying "we did not search" carries no
 * items, no dropped entities, no truncation and no timeout -- so the early
 * return that decides whether this block renders at all would have swallowed
 * it into `null`. This component's own rule forbids exactly that: with the
 * flag on and the upstream broken, rendering nothing is indistinguishable from
 * working-and-empty. That early return has already been wrong once for the
 * same reason, which is why the decision is now a named function.
 *
 * ask-chat.js cannot be rendered under Node (no React, no build step), so the
 * predicate is exported and driven directly. The copy itself is read from
 * source, which is what copy deserves.
 */

const askChat = fs.readFileSync(
  require.resolve('../scripts/composites/ask-chat.js'), 'utf8');

function loadPredicate() {
  global.window = { FieldSight: {}, FS: { api: {} } };
  global.React = { createElement: function () { return null; } };
  delete require.cache[require.resolve('../scripts/composites/ask-chat.js')];
  require('../scripts/composites/ask-chat.js');
  return global.window.FieldSight._corroborationHasNothingToShow;
}

/* ---- the block must appear -------------------------------------------- */

test('a body saying the web was not consulted still renders something', () => {
  const hasNothingToShow = loadPredicate();
  assert.strictEqual(
    hasNothingToShow({
      corroborations: [], dropped: [], truncated: false,
      timed_out: false, searched: false,
    }),
    false,
    'rendering nothing here is indistinguishable from working-and-empty'
  );
});

test('a genuinely empty result is still allowed to render nothing', () => {
  /* The guard must not turn every quiet answer into a note. `searched: true`
     with no cards means the gate found nothing worth checking, which is the
     common case and correctly says nothing at all. */
  const hasNothingToShow = loadPredicate();
  assert.strictEqual(
    hasNothingToShow({
      corroborations: [], dropped: [], truncated: false,
      timed_out: false, searched: true,
    }),
    true
  );
});

test('an old backend that never sets the flag behaves as it did before', () => {
  /* Deploy order is not enforced between the two repos. A response without
     `searched` at all must not start rendering a note about a search nobody
     said anything about. */
  const hasNothingToShow = loadPredicate();
  assert.strictEqual(
    hasNothingToShow({ corroborations: [], dropped: [], truncated: false,
                       timed_out: false }),
    true
  );
});

test('the fields that already forced the block to render still do', () => {
  const hasNothingToShow = loadPredicate();
  const base = { corroborations: [], dropped: [], truncated: false,
                 timed_out: false, searched: true };
  assert.strictEqual(hasNothingToShow(Object.assign({}, base, { timed_out: true })), false);
  assert.strictEqual(hasNothingToShow(Object.assign({}, base, { truncated: true })), false);
  assert.strictEqual(hasNothingToShow(Object.assign({}, base, { dropped: [{ entity: 'x' }] })), false);
  assert.strictEqual(hasNothingToShow(Object.assign({}, base, { corroborations: [{}] })), false);
});

test('a missing body is nothing to show, not a crash', () => {
  const hasNothingToShow = loadPredicate();
  assert.strictEqual(hasNothingToShow(undefined), true);
  assert.strictEqual(hasNothingToShow(null), true);
});

/* ---- and it must say the right thing ----------------------------------- */

test('the words separate "did not search" from "ran out of time"', () => {
  assert.match(askChat, /res\.searched === false/);
  assert.match(askChat, /Couldn.t check the web for this answer/);
});

test('it never claims the web was searched and found nothing', () => {
  /* `not_found` is a finding about the WORLD. Reusing it here would assert a
     search that did not happen -- the same conflation the backend refuses. */
  const branch = askChat.slice(askChat.indexOf('res.searched === false'));
  const line = branch.slice(0, 400);
  assert.ok(!/not found/i.test(line), 'the not-searched line must not say "not found"');
  assert.ok(!/ran out of time/i.test(line), 'nor borrow the timeout wording');
});
