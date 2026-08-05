'use strict';

/*
 * The order Today's open items are read in.
 *
 * Before this there was no order: items came out in transcript order — the
 * order things were SAID — and the reported symptom was not being able to
 * tell what mattered.
 *
 * The rules under test were chosen from the prod data, not from a textbook.
 * The one that matters most for these assertions: deadline is set on 6 of
 * 183 action items and on ZERO of the 175 still open, so every due-date rule
 * (EDD/Jackson, slack, critical ratio) has nothing to sort by. Priority,
 * category and age are what exist, and 61% of open items are past the aged
 * threshold — which is why aged is a TIER, not a tiebreak.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { orderOpenItems, AGED_AFTER_DAYS } =
  require('../scripts/api/today-ordering.js');

function item(over) {
  return Object.assign({
    title: 'task', priority: 'medium', category: 'progress',
    ageDays: 1, isMine: false,
  }, over);
}

const ids = list => list.map(t => t.title);

/* ---- the tiers, in order ------------------------------------------------ */

test('live work outranks the aged pile regardless of priority', () => {
  // 106 of 175 open items are past the threshold. Without this tier they
  // ARE the list, which is the reported problem.
  const out = orderOpenItems([
    item({ title: 'aged high', priority: 'high', ageDays: AGED_AFTER_DAYS + 1 }),
    item({ title: 'live low',  priority: 'low',  ageDays: 2 }),
  ]);
  assert.deepStrictEqual(ids(out), ['live low', 'aged high']);
});

test('an aged safety item does NOT outrank live work', () => {
  // Safety-first was the intuitive order and the real data refuted it: it
  // put nine 148-176-day-old rows at the top, and reading them showed why —
  // the extractor's `safety` category is noisy, so the head of the list was
  // "Vacuum dust off finished carpet". Stale mislabelled housekeeping
  // presented as the most important thing on the page is the exact failure
  // this ordering exists to prevent.
  const out = orderOpenItems([
    item({ title: 'old low safety', priority: 'low', category: 'safety',
           ageDays: AGED_AFTER_DAYS + 40 }),
    item({ title: 'fresh high progress', priority: 'high', ageDays: 0 }),
  ]);
  assert.deepStrictEqual(ids(out), ['fresh high progress', 'old low safety']);
});

test('safety comes first among items that are all still live', () => {
  // Where the label is worth acting on, it still leads.
  const out = orderOpenItems([
    item({ title: 'live high progress', priority: 'high', ageDays: 3 }),
    item({ title: 'live low safety', priority: 'low', category: 'safety', ageDays: 3 }),
  ]);
  assert.deepStrictEqual(ids(out), ['live low safety', 'live high progress']);
});

test('a safety FLAG counts even when the category says otherwise', () => {
  const out = orderOpenItems([
    item({ title: 'plain' , priority: 'high' }),
    item({ title: 'flagged', priority: 'low', hasSafetyFlags: true }),
  ]);
  assert.deepStrictEqual(ids(out), ['flagged', 'plain']);
});

test('the aged boundary is strictly greater than the threshold', () => {
  // Mirrors today.js's isAgedTask, which is `>` and never `>=` — an item
  // exactly at the threshold still carries no chip, so it must not be
  // demoted here either.
  const out = orderOpenItems([
    item({ title: 'just over', priority: 'high', ageDays: AGED_AFTER_DAYS + 1 }),
    item({ title: 'exactly at', priority: 'low', ageDays: AGED_AFTER_DAYS }),
  ]);
  assert.deepStrictEqual(ids(out), ['exactly at', 'just over']);
});

test('priority orders items within a group', () => {
  const out = orderOpenItems([
    item({ title: 'c', priority: 'low' }),
    item({ title: 'a', priority: 'high' }),
    item({ title: 'b', priority: 'medium' }),
  ]);
  assert.deepStrictEqual(ids(out), ['a', 'b', 'c']);
});

test('an unlabelled priority sorts with medium, not last', () => {
  // An item the extractor did not label is not thereby less important, and
  // sinking it would hide exactly the items carrying the least metadata.
  const out = orderOpenItems([
    item({ title: 'low',      priority: 'low' }),
    item({ title: 'none',     priority: null }),
    item({ title: 'high',     priority: 'high' }),
  ]);
  assert.deepStrictEqual(ids(out), ['high', 'none', 'low']);
});

test('among equals the one that has waited longest comes first', () => {
  const out = orderOpenItems([
    item({ title: 'newer', ageDays: 2 }),
    item({ title: 'older', ageDays: 30 }),
  ]);
  assert.deepStrictEqual(ids(out), ['older', 'newer']);
});

test('ownership breaks a tie and nothing more', () => {
  const tie = orderOpenItems([
    item({ title: 'theirs', isMine: false }),
    item({ title: 'mine',   isMine: true }),
  ]);
  assert.deepStrictEqual(ids(tie), ['mine', 'theirs']);

  // ...but someone else's higher-priority item still wins.
  const outranked = orderOpenItems([
    item({ title: 'my low',      isMine: true,  priority: 'low' }),
    item({ title: 'their high',  isMine: false, priority: 'high' }),
  ]);
  assert.deepStrictEqual(ids(outranked), ['their high', 'my low']);
});

/* ---- properties --------------------------------------------------------- */

test('the caller\'s list is not mutated', () => {
  // It is held in React state; sorting in place would mutate state behind
  // React's back.
  const input = [item({ title: 'b', priority: 'low' }), item({ title: 'a', priority: 'high' })];
  const before = ids(input);
  orderOpenItems(input);
  assert.deepStrictEqual(ids(input), before);
});

test('identical data always orders identically', () => {
  // No render-to-render reshuffle: the last resort is content-derived.
  const build = () => [item({ title: 'zeta' }), item({ title: 'alpha' }), item({ title: 'mid' })];
  assert.deepStrictEqual(ids(orderOpenItems(build())), ids(orderOpenItems(build())));
});

test('a missing age sorts as new, never as older than everything', () => {
  const out = orderOpenItems([
    item({ title: 'no age', ageDays: undefined }),
    item({ title: 'a week', ageDays: 7 }),
  ]);
  assert.deepStrictEqual(ids(out), ['a week', 'no age']);
});

test('an empty or absent list is not an error', () => {
  assert.deepStrictEqual(orderOpenItems([]), []);
  assert.deepStrictEqual(orderOpenItems(null), []);
});

/* ---- the tier boundary must not drift from the chip that advertises it -- */

test('the aged threshold matches today.js\'s LEFTOVER_THRESHOLD_DAYS', () => {
  // today.js is a browser-only page module with no export, so the constant
  // is duplicated. This is the guard that keeps the pair honest: a demoted
  // item the page does not mark as aged would be inexplicable to the reader.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'pages', 'today.js'), 'utf8');
  const m = src.match(/var\s+LEFTOVER_THRESHOLD_DAYS\s*=\s*(\d+)/);
  assert.ok(m, 'LEFTOVER_THRESHOLD_DAYS not found in today.js');
  assert.strictEqual(Number(m[1]), AGED_AFTER_DAYS);
});

/* ---- how often the site has raised it ------------------------------------ */

test('a subject the site keeps raising outranks a higher-priority one', () => {
  // Priority is the extractor's guess and 44% of open items carry 'high', so
  // it barely separates anything. "Raised on three different days and still
  // open" is not a guess -- it is the site's own behaviour, recorded.
  const out = orderOpenItems([
    item({ title: 'high, mentioned once', priority: 'high' }),
    item({ title: 'low, raised 3 times', priority: 'low', timesRaised: 3 }),
  ]);
  assert.deepStrictEqual(ids(out), ['low, raised 3 times', 'high, mentioned once']);
});

test('more raisings come first', () => {
  const out = orderOpenItems([
    item({ title: 'twice', timesRaised: 2 }),
    item({ title: 'four times', timesRaised: 4 }),
    item({ title: 'never threaded' }),
  ]);
  assert.deepStrictEqual(ids(out), ['four times', 'twice', 'never threaded']);
});

test('it does not rescue an item from the aged pile', () => {
  // Repetition says the site keeps mentioning it; it does not say the
  // six-month-old version is today's work. The age tier still leads.
  const out = orderOpenItems([
    item({ title: 'aged, raised 5 times', ageDays: AGED_AFTER_DAYS + 30, timesRaised: 5 }),
    item({ title: 'live, never raised again', ageDays: 3 }),
  ]);
  assert.deepStrictEqual(ids(out), ['live, never raised again', 'aged, raised 5 times']);
});

test('safety still leads a much-repeated non-safety item', () => {
  const out = orderOpenItems([
    item({ title: 'repeated progress', timesRaised: 6 }),
    item({ title: 'safety', category: 'safety' }),
  ]);
  assert.deepStrictEqual(ids(out), ['safety', 'repeated progress']);
});

test('an unthreaded item is neutral, not last', () => {
  // Most items carry no count. They must fall through to priority rather
  // than being ranked against each other on a fact none of them has.
  const out = orderOpenItems([
    item({ title: 'unthreaded low', priority: 'low' }),
    item({ title: 'unthreaded high', priority: 'high' }),
  ]);
  assert.deepStrictEqual(ids(out), ['unthreaded high', 'unthreaded low']);
});

test('a corrupt count cannot invert the tier', () => {
  const out = orderOpenItems([
    item({ title: 'negative', priority: 'low', timesRaised: -5 }),
    item({ title: 'plain high', priority: 'high' }),
  ]);
  assert.deepStrictEqual(ids(out), ['plain high', 'negative']);
});
