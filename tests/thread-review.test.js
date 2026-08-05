'use strict';

/*
 * The recurring-item review queue's pure helpers.
 *
 * The card exists so someone can answer one question — "is this the same
 * job?" — from two titles and two dates. What is testable without a DOM is
 * the wording that carries the judgement: how the gap is phrased, and which
 * outcomes are allowed to make a card disappear.
 *
 * That second one matters most. A card that vanishes without the link being
 * made is the worst outcome available here: the reviewer believes they
 * answered, and nobody ever asks again.
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};

const { fmtGap, fmtDate, errorMessage } =
  require('../scripts/composites/thread-review.js');

test('the gap is phrased at the scale a reader judges by', () => {
  // Four days is an ordinary follow-up; five weeks is worth a second look.
  // Both have to read at a glance, so short gaps stay in days and long ones
  // collapse to weeks rather than making someone divide.
  assert.strictEqual(fmtGap(1), '1 day later');
  assert.strictEqual(fmtGap(4), '4 days later');
  assert.strictEqual(fmtGap(21), '3 weeks later');
});

test('a missing or nonsensical gap says nothing rather than something wrong', () => {
  assert.strictEqual(fmtGap(0), '');
  assert.strictEqual(fmtGap(null), '');
  assert.strictEqual(fmtGap('abc'), '');
});

test('dates render as people write them on site', () => {
  assert.strictEqual(fmtDate('2026-03-02'), '2 Mar 2026');
  assert.strictEqual(fmtDate(null), '');
  assert.strictEqual(fmtDate('not-a-date'), 'not-a-date');
});

test('the backend error is preferred over the generic one', () => {
  // 409 "already decided" is a race, and saying so is kinder than "could not
  // be saved" — the reviewer did nothing wrong.
  assert.strictEqual(
    errorMessage({ status: 409, body: { error: 'already decided' } }, 'fallback'),
    'already decided');
  // 403/404 resolve rather than reject, and carry { error } directly.
  assert.strictEqual(errorMessage({ error: 'forbidden' }, 'fallback'), 'forbidden');
  assert.strictEqual(errorMessage(null, 'fallback'), 'fallback');
});
