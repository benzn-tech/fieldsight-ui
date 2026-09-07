'use strict';

/*
 * The day's photo strip (timeline.js) — the contract it renders against.
 *
 * A photo used to reach a screen ONLY as `topic.related_photos`, i.e. only if
 * it was taken while somebody happened to be talking about something that
 * became a topic. Measured against prod on 2026-09-07: of the photos stored on
 * days that HAVE a report, 71 of 90 were unreachable from any screen. One day
 * (2026-09-02) is a single topic and 53 photos, of which 10 came back.
 *
 * The backend now returns `photo_filenames` for the whole day. This pins the
 * two properties the strip depends on, both of them on the FIXTURE, because a
 * mock that does not carry the real shape teaches the wrong contract — and the
 * fixture is what every offline render of this page is built from.
 *
 * The render itself was verified in a browser against the mock server (the
 * repo's own instruction: a green `node --test` says nothing about whether a
 * module is reachable at runtime). 2026-04-29 shows "PHOTOS FROM THIS DAY (3)";
 * 2026-04-28, whose fixture has no such field, shows no section at all.
 */
const test = require('node:test');
const assert = require('node:assert');

/* ---- harness: the fixture is a browser IIFE that registers on window ----- */
global.window = global.window || {};
window.FieldSight = window.FieldSight || {};
require('../scripts/mock/daily-report.fixture.js');

function fixtureFor(date) {
  /* fixtures.reports is keyed by date, then by folder name. */
  const byDate = ((window.FieldSight || {}).fixtures || {}).reports || {};
  const byFolder = byDate[date];
  if (!byFolder) return null;
  const folders = Object.keys(byFolder);
  return folders.length ? byFolder[folders[0]] : null;
}


test('the marquee fixture carries the whole day, not only the bound photos', () => {
  const day = fixtureFor('2026-04-29');
  assert.ok(day, 'fixture for 2026-04-29 not found on window.FieldSight');
  assert.ok(Array.isArray(day.photo_filenames),
    'photo_filenames missing — the strip has nothing to render and every offline '
    + 'check of this page silently exercises the OLD behaviour');

  const bound = new Set();
  (day.topics || []).forEach((t) => (t.related_photos || []).forEach((f) => bound.add(f)));

  /* Superset, not equality: that is the whole point of the field. */
  bound.forEach((f) => {
    assert.ok(day.photo_filenames.indexOf(f) >= 0,
      'a topic-bound photo (' + f + ') is missing from the day list — the strip '
      + 'would show fewer photos than the topics above it');
  });

  const unbound = day.photo_filenames.filter((f) => !bound.has(f));
  assert.ok(unbound.length > 0,
    'every photo in the fixture is bound to a topic, so the fixture cannot '
    + 'exercise the case this feature exists for: a photo taken while nobody '
    + 'was talking. Add one that no topic references.');
});

test('the count the caption shows is the length of the list it ships with', () => {
  const day = fixtureFor('2026-04-29');
  assert.ok(day.uploads && typeof day.uploads.photos === 'number',
    'uploads.photos missing');
  assert.strictEqual(day.uploads.photos, day.photo_filenames.length,
    'two numbers for one fact is how a grid of 41 ends up captioned "53"');
});

test('a day without the field is still a valid day', () => {
  /* The verbatim-history path does not carry photo_filenames, and neither does
     an older backend. The strip must render nothing rather than throw — the
     2026-04-28 fixture is that case, and the browser check confirmed the
     section is absent there. */
  const day = fixtureFor('2026-04-28');
  assert.ok(day, 'fixture for 2026-04-28 not found');
  assert.strictEqual(day.photo_filenames, undefined,
    'this fixture is the no-field control; giving it the field removes the only '
    + 'offline coverage of the absent case');
});
