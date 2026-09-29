'use strict';

/*
 * Customers never see scores or the database's own words. The Voices page printed
 * "tentative", "stored", "refused", a backend sentence as a tooltip ("this window does not
 * hold one voice") and two bare counts headed "Samples" / "Vouched for".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sn = require('../scripts/api/speaker-naming.js');

const ENGINEERING = /tentative|refused|stored|homogeneous|window|spread|sample/i;

test('a learning profile reads as learning, with passages counted in words', () => {
  const w = sn.voiceRowWords({ status: 'tentative', samples: 3, humanSamples: 2,
                               lastAttemptOutcome: 'stored', lastAttemptAt: '2026-09-28 01:49:51' });
  assert.equal(w.status, 'Still learning — names are shown with ?');
  assert.equal(w.learned, '3 passages (2 named by someone)');
  assert.equal(w.latest, 'Voice saved · 2026-09-28');
  for (const v of Object.values(w)) assert.doesNotMatch(v, ENGINEERING);
});

test('a refusal says why in words a site manager can act on', () => {
  const w = sn.voiceRowWords({ status: 'tentative', samples: 0, humanSamples: 0,
                               lastAttemptOutcome: 'refused',
                               lastAttemptDetail: 'this window does not hold one voice',
                               lastAttemptAt: '2026-09-28 00:20:25' });
  assert.equal(w.status, 'No voice saved yet');
  assert.equal(w.latest, 'Not saved · 2026-09-28');
  assert.match(w.latestTitle, /more than one voice, or too much noise/);
  for (const v of Object.values(w)) assert.doesNotMatch(v, /window|homogeneous|spread/i);
});

test('deleted and recognised profiles', () => {
  assert.equal(sn.voiceRowWords({ status: 'withdrawn', samples: 0 }).status, 'Deleted');
  assert.equal(sn.voiceRowWords({ status: 'confirmed', samples: 5 }).status, 'Recognised');
});

test('the rename notice and the Voices page explain a refusal the same way', () => {
  const d = 'this window resembles another profile more than this one';
  const out = sn.enrolmentOutcome([{ displayName: 'Sam', lastAttemptOutcome: 'refused',
    lastAttemptDetail: d, lastAttemptAt: '2026-09-28 00:00:10' }], 'Sam',
    Date.parse('2026-09-28T00:00:00Z'));
  assert.ok(out.message.endsWith(sn.refusalReason(d)));
});

test('the Voices table no longer prints raw status, outcome or backend detail', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'composites', 'voice-library.js'), 'utf8');
  assert.doesNotMatch(src, /'Vouched for'|'Samples'|'Last attempt'/);
  assert.doesNotMatch(src, /title: r\.lastAttemptDetail/);
  assert.doesNotMatch(src, /r\.lastAttemptOutcome \+/);
});
