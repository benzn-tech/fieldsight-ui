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


/* ---- grouped by where he said he was ------------------------------------ */

test('the grouped shape covers every photo in the flat list', () => {
  const day = fixtureFor('2026-04-29');
  assert.ok(Array.isArray(day.photo_groups),
    'photo_groups missing — the grouped branch is unreachable offline, and a '
    + 'branch no fixture exercises is one nobody sees until a customer does');

  const grouped = [];
  day.photo_groups.forEach((g) => (g.filenames || []).forEach((f) => grouped.push(f)));

  /* The invariant that makes grouping safe to render INSTEAD of the flat grid:
     nothing may be lost on the way into a group. If this ever fails, the day
     view silently shows fewer photos than the caption above it claims. */
  assert.deepStrictEqual(grouped.slice().sort(), day.photo_filenames.slice().sort(),
    'grouped photos and the flat list must be the same set');
  assert.strictEqual(new Set(grouped).size, grouped.length,
    'a photo must not appear in two groups');
});

test('a photo taken before any announcement keeps a group of its own', () => {
  /* null is a real location: "he had not said where he was yet". Folding it
     into the first room would invent a place for it, which is the exact
     misattribution the feature exists to prevent. */
  const day = fixtureFor('2026-04-29');
  const nulls = day.photo_groups.filter((g) => g.location === null
                                            || g.location === undefined);
  assert.strictEqual(nulls.length, 1,
    'the fixture must keep exercising the unnamed-location branch');
  assert.ok(nulls[0].filenames.length > 0);
});

test('a day nobody announced anything on carries no groups at all', () => {
  /* Absent, not []. `[]` would read as "he announced somewhere and nothing fell
     in it" and would render an empty heading; absent means the flat grid is the
     whole answer. 2026-04-28 is the control. */
  const day = fixtureFor('2026-04-28');
  assert.strictEqual(day.photo_groups, undefined);
});


test('both branches keep offline coverage: grouped AND ungrouped', () => {
  /* The grouped branch was added by giving 2026-04-29 photo_groups. That
     silently removed the only fixture exercising the FLAT grid -- a branch no
     fixture reaches is one a customer reaches first. 2026-04-25 is the
     ungrouped control and must stay ungrouped. */
  const grouped = fixtureFor('2026-04-29');
  const flat = fixtureFor('2026-04-25');

  assert.ok(grouped.photo_groups && grouped.photo_groups.length,
    '2026-04-29 is the grouped fixture');
  assert.ok(flat.photo_filenames && flat.photo_filenames.length,
    '2026-04-25 must have photos...');
  assert.strictEqual(flat.photo_groups, undefined,
    '...and must NOT have groups, or the flat branch loses its only fixture');
});


/* ---- the day with NO report --------------------------------------------- */

const path = require('node:path');

function loadTimelineApi() {
  /* The mock is a browser IIFE; give it just enough window to register. */
  global.window = {
    FS: { api: { useMocks: true, delay: () => Promise.resolve(),
                 cache: { cached: (k, t, f) => f() } } },
    AuthMock: { currentUser: { role: 'site_manager', name: 'Jarley Trainor' } },
    FieldSight: {},
  };
  delete require.cache[require.resolve('../scripts/mock/daily-report.fixture.js')];
  delete require.cache[require.resolve('../scripts/api/timeline.js')];
  require('../scripts/mock/daily-report.fixture.js');
  require('../scripts/api/timeline.js');
  return window.FS.api.timeline;
}

test('the no-report envelope nests its body under raw, like the real one', async () => {
  /* _fetch.js returns { _notFound, status, raw } and does NOT merge the body.
     The mock used to fabricate the fields FLAT, so every offline render read
     `report.message` where the live app reads `report.raw.message` — a mock
     that does not carry the real shape teaches the wrong contract, and the
     branch it teaches is the one nobody exercises until a customer does. */
  const api = loadTimelineApi();
  const r = await api.getTimeline({ date: '2026-04-27', user: 'Jarley_Trainor' });
  assert.strictEqual(r._notFound, true);
  assert.ok(r.raw, 'the body must be nested under raw');
  assert.strictEqual(r.raw.user, 'Jarley_Trainor',
    'user is a FIELD on the 404 body — the UI must not parse it out of message');
});

test('a no-report day carries what DID arrive', async () => {
  const api = loadTimelineApi();
  const r = await api.getTimeline({ date: '2026-04-27', user: 'Jarley_Trainor' });
  assert.strictEqual(r.raw.uploads.photos, 3);
  assert.strictEqual(r.raw.photo_filenames.length, 3);
  assert.strictEqual(r.raw.day_state, 'captured',
    'day_state reports what can be EVIDENCED — never "pending"');
});

test('most no-report days carry nothing, and that is not the same as zero', async () => {
  /* Three producers emit _notFound with no raw at all (the CloudFront HTML
     trap, the legacy-gateway fallback, mock mode's other dates). No `uploads`
     key means UNKNOWN and must render as the bare message, never as
     "nothing arrived". */
  const api = loadTimelineApi();
  const r = await api.getTimeline({ date: '2026-04-26', user: 'Jarley_Trainor' });
  assert.strictEqual(r._notFound, true);
  assert.strictEqual(r.raw.uploads, undefined);
  assert.strictEqual(r.raw.photo_filenames, undefined);
});
