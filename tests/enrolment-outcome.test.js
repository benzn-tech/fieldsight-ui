'use strict';

/*
 * After a rename the panel used to say "Voice enrolment requested" and never speak
 * again, so a refusal (two voices, wind, too little speech) looked like a success.
 * The embedder records every attempt on the profile; `enrolmentOutcome` reads it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const sn = require('../scripts/api/speaker-naming.js');

const SAVED = Date.parse('2026-09-27T09:59:00Z');

function vp(over) {
  return Object.assign({ displayName: 'Sam Yu', lastAttemptAt: '2026-09-27 09:59:30.282214',
                         lastAttemptOutcome: 'stored', lastAttemptDetail: null }, over);
}

test('no answer yet while the only attempt predates the save', () => {
  assert.equal(sn.enrolmentOutcome([vp({ lastAttemptAt: '2026-09-23 03:51:57' })],
                                   'Sam Yu', SAVED), null);
});

test('a stored voice says so, in words for a site manager', () => {
  const out = sn.enrolmentOutcome([vp()], 'Sam Yu', SAVED);
  assert.equal(out.state, 'stored');
  assert.match(out.message, /Sam Yu’s voice is saved/);
});

test('a refusal says why and what to do, without the backend sentence', () => {
  const out = sn.enrolmentOutcome(
    [vp({ lastAttemptOutcome: 'refused', lastAttemptDetail: 'this window does not hold one voice' })],
    'Sam Yu', SAVED);
  assert.equal(out.state, 'refused');
  assert.match(out.message, /not saved: this passage has more than one voice/);
  assert.doesNotMatch(out.message, /window/);
});

test('two profiles with one name: the newest attempt answers', () => {
  const out = sn.enrolmentOutcome([
    vp({ lastAttemptOutcome: 'refused', lastAttemptDetail: 'x', lastAttemptAt: '2026-09-27 09:59:10' }),
    vp({ lastAttemptAt: '2026-09-27 09:59:40' }),
  ], 'sam yu ', SAVED);
  assert.equal(out.state, 'stored');
});

test('another person’s attempt is not this answer', () => {
  assert.equal(sn.enrolmentOutcome([vp({ displayName: 'Ben Lin' })], 'Sam Yu', SAVED), null);
});

test('the server time is read as UTC, not local', () => {
  /* In NZ a zone-less timestamp parsed as local would land 12-13 hours off and every
     answer would look stale -- or every stale one current. */
  const out = sn.enrolmentOutcome([vp({ lastAttemptAt: '2026-09-27 09:58:45' })],
                                  'Sam Yu', SAVED);
  assert.ok(out, 'an attempt 15 s before the save (inside the skew allowance) was missed');
});

test('reads the shape org-api actually sends (json default=str on a timestamptz)', () => {
  const out = sn.enrolmentOutcome([vp({ lastAttemptAt: '2026-09-27 09:59:30.282214+00:00' })],
                                  'Sam Yu', SAVED);
  assert.equal(out && out.state, 'stored');
});
