'use strict';

/*
 * The orders Today's open items can be read in.
 *
 * The previous version of this file pinned seven lexicographic tiers —
 * aged-demotion, safety, times-raised, priority, age, mine-first, title. Those
 * tiers are gone, so those assertions are gone with them; keeping them green
 * would have meant keeping the behaviour. What survives here is the constant
 * guard (the 90-day threshold still drives the chip and its filter) and the
 * properties that hold whatever the tiers are.
 *
 * The rules under test are measured against what the FRONTEND has, which is
 * not what the table has. An earlier draft of this design sorted on
 * `created_at`; that field does not exist in this codebase. The finest
 * creation key an item carries is `date`, day-granular, and `deadline` is raw
 * free text rather than a date.
 *
 * The numbers behind the two decisions that could have gone either way:
 * 169 of 349 open prod items are `High` (48 %), which is why priority is a
 * tiebreak and not a tier; and roughly three quarters resolve to no due date
 * at all, which is why the due-date order has to say so on screen.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  orderOpenItems, orderOpenItemsBy, partitionByDue, AGED_AFTER_DAYS,
} = require('../scripts/api/today-ordering.js');

/* `resolveDeadline` lives on FS.api in the browser. The module reads it
   through that global, so the test supplies one — deliberately the real
   contract ({absolute, display}) rather than a bare string, because a stub
   with the wrong shape would let a wrong implementation pass. */
global.window = global.window || {};
window.FS = window.FS || {};
window.FS.api = window.FS.api || {};
window.FS.api.resolveDeadline = function (text, reportDate) {
  if (!text) return { absolute: null, display: '—' };
  var m = String(text).match(/(\d{4}-\d{2}-\d{2})(\s+\d{2}:\d{2})?/);
  if (!m) return { absolute: null, display: text };
  /* The real resolver's shape: `absolute` is DAY-ONLY and `display` carries
     the time when the text had one. Reproduced exactly, because the two
     differing is the whole reason cmpDue reads display first — a stub that
     returned the same string for both would let a day-only sort pass. */
  return { absolute: m[1], display: m[1] + (m[2] || '') };
};

let seq = 0;
function item(over) {
  seq += 1;
  return Object.assign({
    id: 'i' + seq, title: 'task', priority: 'Medium',
    date: '2026-09-01', deadline: null,
  }, over);
}

/* ---- the default order: when it was said --------------------------------- */

test('the newest day comes first', () => {
  const old = item({ date: '2026-08-01', title: 'older' });
  const recent = item({ date: '2026-09-01', title: 'newer' });
  const out = orderOpenItems([old, recent]);
  assert.deepStrictEqual(out.map(t => t.title), ['newer', 'older']);
});

test('the aged pile sinks without a tier of its own', () => {
  // What replaced the aged demotion. A six-month-old item is simply the
  // oldest day, so it lands at the bottom on the ordinary rule — and nothing
  // has to know about the 90-day boundary to put it there.
  const ancient = item({ date: '2026-02-09', title: 'february' });
  const today = item({ date: '2026-09-07', title: 'today' });
  assert.deepStrictEqual(
    orderOpenItems([ancient, today]).map(t => t.title), ['today', 'february']);
});

test('priority breaks a tie inside one day', () => {
  const lo = item({ priority: 'Low', title: 'low' });
  const hi = item({ priority: 'High', title: 'high' });
  assert.deepStrictEqual(
    orderOpenItems([lo, hi]).map(t => t.title), ['high', 'low']);
});

test('priority is compared case-insensitively', () => {
  // today-adapter.js capitalises it — priorityLabel returns 'High', never
  // 'high'. A test written with lowercase would pass against an
  // implementation that only handles lowercase, which is the shape the
  // adapter never produces.
  const hi = item({ priority: 'High', title: 'capitalised' });
  const lo = item({ priority: 'low', title: 'lowercase-low' });
  assert.deepStrictEqual(
    orderOpenItemsBy([lo, hi], 'said').map(t => t.title),
    ['capitalised', 'lowercase-low']);
});

test('an unlabelled priority sorts with medium, not last', () => {
  const none = item({ priority: null, title: 'unlabelled' });
  const low = item({ priority: 'Low', title: 'low' });
  assert.deepStrictEqual(
    orderOpenItems([low, none]).map(t => t.title), ['unlabelled', 'low']);
});

test('the order is total even when day AND title collide', () => {
  // The case `id` exists for. Re-extraction of one meeting produces duplicate
  // action text on a single day — that is the entire reason todo_collapse
  // exists on the backend. Without an id tiebreak the comparator is not
  // total, and a non-total comparator reshuffles between renders.
  const a = item({ id: 'aaa', title: 'same words', date: '2026-09-01' });
  const b = item({ id: 'bbb', title: 'same words', date: '2026-09-01' });
  const forward = orderOpenItems([a, b]).map(t => t.id);
  const reversed = orderOpenItems([b, a]).map(t => t.id);
  assert.deepStrictEqual(forward, ['aaa', 'bbb']);
  assert.deepStrictEqual(reversed, ['aaa', 'bbb']);
});

test('a shuffled input produces an identical output', () => {
  const items = [];
  for (let i = 0; i < 30; i += 1) {
    items.push(item({ id: 'x' + i, title: 'same', date: '2026-09-01',
                      priority: 'High' }));
  }
  const once = orderOpenItems(items).map(t => t.id);
  const shuffled = items.slice().reverse();
  assert.deepStrictEqual(orderOpenItems(shuffled).map(t => t.id), once);
});

test('a missing date sorts last, never as the newest thing on the page', () => {
  const dated = item({ date: '2026-08-01', title: 'dated' });
  const undated = item({ date: null, title: 'no date' });
  assert.deepStrictEqual(
    orderOpenItems([undated, dated]).map(t => t.title), ['dated', 'no date']);
});

test('the caller\'s list is not mutated', () => {
  const a = item({ date: '2026-08-01', title: 'a' });
  const b = item({ date: '2026-09-01', title: 'b' });
  const input = [a, b];
  orderOpenItems(input);
  assert.deepStrictEqual(input.map(t => t.title), ['a', 'b']);
});

test('an empty or absent list is not an error', () => {
  assert.deepStrictEqual(orderOpenItems([]), []);
  assert.deepStrictEqual(orderOpenItems(undefined), []);
  assert.deepStrictEqual(partitionByDue(undefined), { dated: [], undated: [] });
});

/* ---- the due-date order -------------------------------------------------- */

test('a resolvable deadline sorts soonest first', () => {
  const late = item({ deadline: 'by 2026-09-30', title: 'late' });
  const soon = item({ deadline: 'by 2026-09-11', title: 'soon' });
  assert.deepStrictEqual(
    orderOpenItemsBy([late, soon], 'due').map(t => t.title), ['soon', 'late']);
});

test('everything undated falls below everything dated', () => {
  const undated = item({ deadline: null, title: 'no deadline', date: '2026-09-07' });
  const dated = item({ deadline: 'by 2026-09-30', title: 'dated', date: '2026-01-01' });
  // The dated one is SIX MONTHS older, so the default order would put it last.
  assert.deepStrictEqual(
    orderOpenItemsBy([undated, dated], 'due').map(t => t.title),
    ['dated', 'no deadline']);
});

test('free text with no date in it counts as undated', () => {
  // "Week after next Tuesday" resolves to nothing, and a sort that guessed
  // would place an invention among facts.
  const vague = item({ deadline: 'week after next Tuesday', title: 'vague' });
  const real = item({ deadline: 'by 2026-09-30', title: 'real' });
  const { dated, undated } = partitionByDue(orderOpenItemsBy([vague, real], 'due'));
  assert.deepStrictEqual(dated.map(t => t.title), ['real']);
  assert.deepStrictEqual(undated.map(t => t.title), ['vague']);
});

test('nothing is dropped, and the divider count is the rest', () => {
  // The assertion that would have caught the collapse defect: a feature that
  // reorders must still return every row it was given, and the count shown
  // beside the divider must equal what is under it.
  const items = [];
  for (let i = 0; i < 20; i += 1) {
    items.push(item({ id: 'd' + i, deadline: i < 5 ? ('by 2026-09-1' + i) : null }));
  }
  const ordered = orderOpenItemsBy(items, 'due');
  assert.strictEqual(ordered.length, items.length, 'a row went missing');
  const { dated, undated } = partitionByDue(ordered);
  assert.strictEqual(dated.length + undated.length, items.length);
  assert.strictEqual(undated.length, 15);
});

test('two items due the same day fall back to the default order', () => {
  const older = item({ deadline: 'by 2026-09-11', date: '2026-08-01', title: 'older' });
  const newer = item({ deadline: 'by 2026-09-11', date: '2026-09-01', title: 'newer' });
  assert.deepStrictEqual(
    orderOpenItemsBy([older, newer], 'due').map(t => t.title), ['newer', 'older']);
});

test('an unknown mode falls back to the default rather than to no order', () => {
  const old = item({ date: '2026-08-01', title: 'older' });
  const recent = item({ date: '2026-09-01', title: 'newer' });
  assert.deepStrictEqual(
    orderOpenItemsBy([old, recent], 'nonsense').map(t => t.title),
    ['newer', 'older']);
});

test('a time of day inside the deadline decides the order', () => {
  // The defect this pins, seen in the browser: six items all due 2026-04-29
  // rendered "09:00" below two "14:00"s, because `absolute` is day-only and
  // everything after it fell through to the default order. The CARD SHOWS THE
  // TIME, so an order that ignores it reads as broken regardless of what the
  // sort key technically promised.
  const late = item({ deadline: 'by 2026-04-29 14:00', title: 'afternoon' });
  const early = item({ deadline: 'by 2026-04-29 09:00', title: 'morning' });
  assert.deepStrictEqual(
    orderOpenItemsBy([late, early], 'due').map(t => t.title),
    ['morning', 'afternoon']);
});

test('a timed deadline and an untimed one on the same day still order', () => {
  // 'YYYY-MM-DD' sorts before 'YYYY-MM-DD HH:MM' lexicographically, so the
  // untimed one leads. That is the right way round: an item due "sometime
  // Wednesday" is not evidence it comes after 09:00, and putting it first
  // keeps it visible rather than buried under the timed ones.
  const timed = item({ deadline: 'by 2026-04-29 09:00', title: 'timed' });
  const untimed = item({ deadline: 'by 2026-04-29', title: 'untimed' });
  assert.deepStrictEqual(
    orderOpenItemsBy([timed, untimed], 'due').map(t => t.title),
    ['untimed', 'timed']);
});

test('an unresolvable deadline is undated even though display holds its text', () => {
  // resolveDeadline returns {absolute: null, display: <the raw text>} for text
  // it cannot place. Reading display without checking absolute would sort
  // "week after next Tuesday" as if it were a date, placing an invention
  // among facts.
  const vague = item({ deadline: 'week after next Tuesday', title: 'vague' });
  const real = item({ deadline: 'by 2026-04-29 09:00', title: 'real' });
  const { dated, undated } = partitionByDue(orderOpenItemsBy([vague, real], 'due'));
  assert.deepStrictEqual(dated.map(t => t.title), ['real']);
  assert.deepStrictEqual(undated.map(t => t.title), ['vague']);
});

/* ---- the constant that outlived the tier --------------------------------- */

test('the aged threshold matches today.js\'s LEFTOVER_THRESHOLD_DAYS', () => {
  // The 90-day boundary no longer decides the ORDER — newest-first sinks the
  // aged pile on its own — but it still drives the chip and the "Hide older"
  // filter, so the duplicated constant still needs its cross-file guard. It is
  // carried over deliberately rather than deleted along with the tiers.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'pages', 'today.js'), 'utf8');
  const m = src.match(/var\s+LEFTOVER_THRESHOLD_DAYS\s*=\s*(\d+)/);
  assert.ok(m, 'LEFTOVER_THRESHOLD_DAYS not found in today.js');
  assert.strictEqual(Number(m[1]), AGED_AFTER_DAYS);
});
