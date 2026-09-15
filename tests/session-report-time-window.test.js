'use strict';
/* Choose what a meeting report covers: a time window over the meeting's topics.

   The owner asked for "pick 9:00-11:30, report on what happened in it". Every
   topic already carries `time_range` ("13:40 – 13:41"), and the timeline renders
   that string verbatim -- so the clock the reviewer picks in IS the clock the
   device stamped. No timezone is involved, which is why this lives on the client
   and why it must parse the same shapes the backend already tolerates: en dash,
   hyphen, em dash, one- or two-digit hours, an optional seconds field.

   Two decisions are pinned here.

   OVERLAP, not "starts inside". A topic that runs 11:20-11:50 is partly in a
   9:00-11:30 window. Leaving it out would silently drop the end of a
   discussion the reviewer can see was still going on when their window closed.

   UNPLACEABLE MEANS NOT PICKED BY A WINDOW. A topic with no usable time_range
   cannot be said to fall inside 9:00-11:30, so a window does not select it. It
   stays tickable by hand -- the reviewer can see it and decide -- but a range
   must never put something in a report that we cannot place in that range. */
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
if (!global.window.FieldSight) global.window.FieldSight = {};

const { parseTimeRange, overlapsWindow, parseClock } =
  require('../scripts/composites/session-report-modal.js');

test('parseTimeRange reads the production shape, en dash included', () => {
  assert.deepStrictEqual(parseTimeRange('13:40 \u2013 13:41'), { start: 820, end: 821 });
});

test('parseTimeRange tolerates hyphen, em dash, single-digit hours and seconds', () => {
  assert.deepStrictEqual(parseTimeRange('9:05-9:30'), { start: 545, end: 570 });
  assert.deepStrictEqual(parseTimeRange('09:05 \u2014 09:30'), { start: 545, end: 570 });
  assert.deepStrictEqual(parseTimeRange('09:05:12 \u2013 09:30:59'), { start: 545, end: 570 });
});

test('parseTimeRange: a single time is a zero-length topic, not garbage', () => {
  assert.deepStrictEqual(parseTimeRange('10:15'), { start: 615, end: 615 });
});

test('parseTimeRange: nothing usable is null, never a guess', () => {
  for (const bad of [null, undefined, '', '—', 'morning', '25:00 – 26:00', '10:61']) {
    assert.strictEqual(parseTimeRange(bad), null, String(bad));
  }
});

test('parseTimeRange: an end before its start is unplaceable, not reordered', () => {
  // A range that reads backwards is a model error or a midnight wrap; either
  // way we cannot say which minutes it covers.
  assert.strictEqual(parseTimeRange('11:00 \u2013 09:00'), null);
});

test('parseClock reads what a time input produces', () => {
  assert.strictEqual(parseClock('09:00'), 540);
  assert.strictEqual(parseClock('23:59'), 1439);
  assert.strictEqual(parseClock(''), null);
  assert.strictEqual(parseClock('9am'), null);
});

test('overlapsWindow: a topic straddling the window end is IN', () => {
  assert.strictEqual(overlapsWindow('11:20 \u2013 11:50', '09:00', '11:30'), true);
});

test('overlapsWindow: a topic straddling the window start is IN', () => {
  assert.strictEqual(overlapsWindow('08:50 \u2013 09:10', '09:00', '11:30'), true);
});

test('overlapsWindow: touching the boundary counts; one minute clear does not', () => {
  assert.strictEqual(overlapsWindow('11:30 \u2013 11:45', '09:00', '11:30'), true);
  assert.strictEqual(overlapsWindow('11:31 \u2013 11:45', '09:00', '11:30'), false);
  assert.strictEqual(overlapsWindow('08:00 \u2013 08:59', '09:00', '11:30'), false);
});

test('overlapsWindow: an unplaceable topic is never picked by a window', () => {
  assert.strictEqual(overlapsWindow(null, '09:00', '11:30'), false);
  assert.strictEqual(overlapsWindow('—', '00:00', '23:59'), false);
});

test('overlapsWindow: an invalid or inverted window selects nothing', () => {
  // Fails closed. A window that cannot be read must not quietly become "all".
  assert.strictEqual(overlapsWindow('10:00 \u2013 10:10', '', '11:30'), false);
  assert.strictEqual(overlapsWindow('10:00 \u2013 10:10', '11:30', '09:00'), false);
});
