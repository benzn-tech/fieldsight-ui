'use strict';

/*
 * The dates a day's report says somebody mentioned.
 *
 * Measured across the whole prod corpus: 239 entries on 62 of the 99 reports
 * that carry topics, median 3 per report. 184 of them (77 %) resolve through
 * FS.api.resolveDeadline against the report's own date — NOT the 26 % the
 * spec's first draft claimed, which counted ISO literals in the lake rather
 * than what this frontend can do.
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
require('../scripts/api/index.js');
require('../scripts/api/today-adapter.js');   /* provides resolveDeadline */
const {
  orderEntries, dateLabel, showsUrgency, showsAuthor,
} = require('../scripts/api/mentioned-dates.js');

const DAY = '2026-02-09';               /* a Monday */
function e(over) {
  return Object.assign({
    date_mentioned: 'Wednesday', context: 'something',
    who_mentioned: 'Jarley Trainor', urgency: 'medium', type: 'deadline',
  }, over);
}

/* ---- ordering ------------------------------------------------------------ */

test('resolved dates come first, ascending', () => {
  const out = orderEntries([
    e({ date_mentioned: 'Next week', context: 'later' }),
    e({ date_mentioned: 'Tomorrow', context: 'sooner' }),
  ], DAY);
  assert.deepStrictEqual(out.map(x => x.context), ['sooner', 'later']);
});

test('a weekday name IS resolved — it is not an unorderable phrase', () => {
  // The first draft's central error. "Wednesday" against a Monday report
  // resolves to that week's Wednesday; treating it as unorderable would put
  // 121 of the corpus's 184 orderable entries into the unordered tail.
  const out = orderEntries([
    e({ date_mentioned: 'This afternoon', context: 'vague' }),
    e({ date_mentioned: 'Wednesday', context: 'dated' }),
  ], DAY);
  assert.deepStrictEqual(out.map(x => x.context), ['dated', 'vague']);
});

test('unresolved entries keep the order the extractor gave them', () => {
  const out = orderEntries([
    e({ date_mentioned: 'End of week', context: 'a' }),
    e({ date_mentioned: '3 months', context: 'b' }),
    e({ date_mentioned: 'This afternoon', context: 'c' }),
  ], DAY);
  assert.deepStrictEqual(out.map(x => x.context), ['a', 'b', 'c']);
});

test('nothing is dropped and the caller list is not mutated', () => {
  const input = [e({ date_mentioned: 'Tomorrow' }), e({ date_mentioned: 'ASAP' })];
  const out = orderEntries(input, DAY);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(input[0].date_mentioned, 'Tomorrow');
});

test('the order is total, so it does not reshuffle between renders', () => {
  const items = [];
  for (let i = 0; i < 12; i += 1) items.push(e({ date_mentioned: 'Wednesday', context: 'c' + i }));
  const once = orderEntries(items, DAY).map(x => x.context);
  assert.deepStrictEqual(orderEntries(items, DAY).map(x => x.context), once);
});

test('an empty or absent list is not an error', () => {
  assert.deepStrictEqual(orderEntries([], DAY), []);
  assert.deepStrictEqual(orderEntries(undefined, DAY), []);
});

/* ---- labels: the real corpus, with expected values -------------------- */

test('the label is the RESOLVED day, not the words said', () => {
  // 169 of 239 entries have a display that differs from date_mentioned.
  // "Tomorrow" printed under a day header three weeks later is a trap.
  assert.strictEqual(dateLabel(e({ date_mentioned: 'Tomorrow morning' }), DAY), '2026-02-10');
  assert.strictEqual(dateLabel(e({ date_mentioned: 'Wednesday' }), DAY), '2026-02-11');
  assert.strictEqual(dateLabel(e({ date_mentioned: 'Next week' }), DAY), '2026-02-16');
});

test('an embedded ISO date wins, as the resolver already decides', () => {
  assert.strictEqual(
    dateLabel(e({ date_mentioned: 'Wednesday (2026-02-11)' }), DAY), '2026-02-11');
});

test('"Week of X or Y" takes the first date, and that is accepted not fixed', () => {
  // The resolver's existing behaviour, one entry in the corpus. The full
  // phrase stays visible in `context`; special-casing it here would be a
  // second resolver by another name.
  assert.strictEqual(
    dateLabel(e({ date_mentioned: 'Week of 2026-07-23 or 2026-07-27' }), DAY),
    '2026-07-23');
});

test('an unresolvable phrase shows verbatim — it is all the reader has', () => {
  ['This afternoon', 'End of week', '3 months', '21st', 'ASAP'].forEach(function (p) {
    assert.strictEqual(dateLabel(e({ date_mentioned: p }), DAY), p);
  });
});

test('a missing date_mentioned yields an empty label, never "undefined"', () => {
  assert.strictEqual(dateLabel(e({ date_mentioned: null }), DAY), '');
  assert.strictEqual(dateLabel({}, DAY), '');
  assert.strictEqual(dateLabel(null, DAY), '');
});

/* ---- chips --------------------------------------------------------------- */

test('only high urgency earns a chip', () => {
  // 115 of 239 are high, 93 medium, 31 low. A chip on medium marks two rows
  // in five, which marks nothing.
  assert.strictEqual(showsUrgency(e({ urgency: 'high' })), true);
  assert.strictEqual(showsUrgency(e({ urgency: 'medium' })), false);
  assert.strictEqual(showsUrgency(e({ urgency: 'low' })), false);
  assert.strictEqual(showsUrgency(e({ urgency: null })), false);
});

test('urgency is read case-insensitively', () => {
  assert.strictEqual(showsUrgency(e({ urgency: 'HIGH' })), true);
});

test('the author shows only when it is not the report author', () => {
  // On a single-author day it is the same name on every row, which is noise.
  assert.strictEqual(showsAuthor(e({ who_mentioned: 'Ben Lin' }), 'Jarley Trainor'), true);
  assert.strictEqual(showsAuthor(e({ who_mentioned: 'Jarley Trainor' }), 'Jarley Trainor'), false);
  assert.strictEqual(showsAuthor(e({ who_mentioned: null }), 'Jarley Trainor'), false);
});
