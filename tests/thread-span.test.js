'use strict';

/*
 * What "raised 4×" means, spelled out.
 *
 * The badge's old tooltip was accurate and uninformative: `times_raised` is
 * count(DISTINCT report_date) and the badge only renders on open cards, so
 * "came up on 4 different days and is still open" was true. It just gave the
 * number no scale — four days in one week and four days across three months
 * rendered identically, and the fields that separate them (first_seen,
 * last_raised, open_items) were on the wire and unread.
 */
const test = require('node:test');
const assert = require('node:assert');

const { tooltip, formatDay } = require('../scripts/api/thread-span.js');

/* ---- dates ---------------------------------------------------------------- */

test('an ISO day formats without going through Date()', () => {
  // BUG-19: new Date('2026-06-12') parses as UTC and renders as the 11th in
  // NZ. A tooltip whose whole purpose is precision about dates must not be
  // off by one, so the formatter does string surgery instead.
  assert.strictEqual(formatDay('2026-06-12'), '12 Jun 2026');
  assert.strictEqual(formatDay('2026-01-01'), '1 Jan 2026');
  assert.strictEqual(formatDay('2026-12-31'), '31 Dec 2026');
});

test('a timestamp still yields its day', () => {
  assert.strictEqual(formatDay('2026-06-12T04:00:00Z'), '12 Jun 2026');
});

test('anything that is not a plain ISO day yields null, never "NaN undefined"', () => {
  assert.strictEqual(formatDay(null), null);
  assert.strictEqual(formatDay(''), null);
  assert.strictEqual(formatDay('last Tuesday'), null);
  assert.strictEqual(formatDay('2026-13-01'), null);   // month 13 has no name
  assert.strictEqual(formatDay(20260612), null);
});

/* ---- the sentence --------------------------------------------------------- */

test('the span is the point: it names both ends', () => {
  const t = tooltip({ timesRaised: 4, firstSeen: '2026-06-12',
                      lastRaised: '2026-09-03' });
  assert.strictEqual(t, 'Raised on 4 different days, from 12 Jun 2026 to 3 Sep 2026.');
});

test('missing dates fall back to the old wording, not to nothing', () => {
  // A thread whose facts did not come back should say LESS, not fail. The
  // previous sentence is the floor.
  const t = tooltip({ timesRaised: 3, firstSeen: null, lastRaised: null });
  assert.strictEqual(t,
    'This subject came up on 3 different days and is still open.');
});

test('one end missing is still not enough for a span', () => {
  assert.ok(/came up on 3 different days/.test(
    tooltip({ timesRaised: 3, firstSeen: '2026-06-12', lastRaised: null })));
});

test('the badge does not render below 2, so neither does the tooltip', () => {
  assert.strictEqual(tooltip({ timesRaised: 1, firstSeen: '2026-06-12' }), null);
  assert.strictEqual(tooltip({ timesRaised: 0 }), null);
  assert.strictEqual(tooltip({ timesRaised: null }), null);
  assert.strictEqual(tooltip({}), null);
  assert.strictEqual(tooltip(), null);
});

/* ---- the thread's open count ---------------------------------------------- */

test('more than one open item on the subject is worth saying', () => {
  const t = tooltip({ timesRaised: 4, firstSeen: '2026-06-12',
                      lastRaised: '2026-09-03', threadOpenItems: 3 });
  assert.ok(t.endsWith('3 items on this subject are still open.'), t);
});

test('exactly one is NOT worth saying — that one is the card you are reading', () => {
  // The card is itself an open item, so `1` adds a number the reader cannot
  // act on. Rendering it would look like information and be tautology.
  const t = tooltip({ timesRaised: 4, firstSeen: '2026-06-12',
                      lastRaised: '2026-09-03', threadOpenItems: 1 });
  assert.ok(!/still open\.$/.test(t.replace(/.*days, from[^.]*\./, '')), t);
  assert.strictEqual(t, 'Raised on 4 different days, from 12 Jun 2026 to 3 Sep 2026.');
});

test('zero is treated as nothing to say, not as a contradiction to render', () => {
  // Unreachable by construction (the badge is on an open card) but a 0 that
  // slipped through must not produce "0 items on this subject are still open"
  // directly under a badge saying it is open.
  const t = tooltip({ timesRaised: 2, firstSeen: '2026-06-12',
                      lastRaised: '2026-06-20', threadOpenItems: 0 });
  assert.ok(!/0 items/.test(t), t);
});

test('a non-numeric count is ignored rather than concatenated', () => {
  const t = tooltip({ timesRaised: 2, firstSeen: '2026-06-12',
                      lastRaised: '2026-06-20', threadOpenItems: '3' });
  assert.ok(!/items on this subject/.test(t), t);
});
