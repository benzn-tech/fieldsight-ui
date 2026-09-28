'use strict';

/*
 * Evidence, grouped by WHERE the photos were taken.
 *
 * A photo belongs to "this day" and "that place". The backend already sends
 * the place: `photo_groups` (migration 0054 -> day_location_markers), shaped
 * [{location, filenames}] with `location: null` meaning "taken before anyone
 * said where they were" — a true and useful heading, never a made-up room
 * (lambda_org_api.py::_photo_groups).
 *
 * Timeline already renders that grouping. Evidence did not: it offered "By
 * day" and "By topic" only, so the photos that reach no topic — the ones the
 * whole-day list exists for, 71 of 90 on prod days WITH a report — arrived in
 * one undifferentiated "No topic" pile.
 *
 * The invariant that matters here is the same one groupByTopic carries: every
 * photo in, exactly once, out. A grouping that loses a photo is worse than no
 * grouping, because the pile at least showed it.
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = { FieldSight: {}, FS: { api: {} } };
require('../scripts/api/evidence-grouping.js');
const { groupByPlace } = window.FS.api.evidenceGrouping;

const P = (name) => ({ filename: name, topic_id: null, userDisplayName: 'Jarley Trainor' });

const DAY = [
  P('Benl1_2026-04-29_07-12-04.jpg'),
  P('Benl1_2026-04-29_07-19-22.jpg'),
  P('Benl1_2026-04-29_08-46-11.jpg'),
  P('Benl1_2026-04-29_11-08-44.jpg'),
];
const GROUPS = [
  { location: null,      filenames: ['Benl1_2026-04-29_07-12-04.jpg'] },
  { location: 'Level 2', filenames: ['Benl1_2026-04-29_07-19-22.jpg',
                                     'Benl1_2026-04-29_08-46-11.jpg'] },
  { location: 'Level 3', filenames: ['Benl1_2026-04-29_11-08-44.jpg'] },
];

test('photos land under the place they were taken, in the order the day happened', () => {
  const out = groupByPlace(DAY, GROUPS);
  assert.deepStrictEqual(out.groups.map((g) => g.location), ['Level 2', 'Level 3']);
  assert.deepStrictEqual(out.groups[0].photos.map((p) => p.filename),
    ['Benl1_2026-04-29_07-19-22.jpg', 'Benl1_2026-04-29_08-46-11.jpg']);
});

test('a photo taken before anyone said where they were is ungrouped, not invented a room', () => {
  const out = groupByPlace(DAY, GROUPS);
  assert.deepStrictEqual(out.ungrouped.map((p) => p.filename),
    ['Benl1_2026-04-29_07-12-04.jpg']);
});

test('every photo comes out exactly once', () => {
  const out = groupByPlace(DAY, GROUPS);
  const seen = out.groups.reduce((a, g) => a.concat(g.photos), []).concat(out.ungrouped);
  assert.strictEqual(seen.length, DAY.length);
  assert.strictEqual(new Set(seen.map((p) => p.filename)).size, DAY.length);
});

test('a photo no group mentions is still shown, not dropped', () => {
  /* The lists come from two different queries on the backend — the flat day
     list and the marker grouping — and they can disagree. The flat list is
     the one that decides a photo exists. */
  const extra = DAY.concat([P('Benl1_2026-04-29_15-00-00.jpg')]);
  const out = groupByPlace(extra, GROUPS);
  const seen = out.groups.reduce((a, g) => a.concat(g.photos), []).concat(out.ungrouped);
  assert.strictEqual(seen.length, extra.length);
  assert.ok(out.ungrouped.some((p) => p.filename === 'Benl1_2026-04-29_15-00-00.jpg'));
});

test('no groups at all means every photo is ungrouped, and nothing throws', () => {
  /* `photo_groups` is ABSENT (not []) when nobody announced a location —
     the ordinary case for a meeting. Absent must not read as "zero photos". */
  [null, undefined, []].forEach(function (nothing) {
    const out = groupByPlace(DAY, nothing);
    assert.deepStrictEqual(out.groups, []);
    assert.strictEqual(out.ungrouped.length, DAY.length);
  });
});

test('no photos is an empty grouping, not a crash', () => {
  const out = groupByPlace([], GROUPS);
  assert.deepStrictEqual(out.groups, []);
  assert.deepStrictEqual(out.ungrouped, []);
});

test('a group whose every photo is missing from the day does not render an empty heading', () => {
  /* A tombstoned photo is filtered out of the flat list by the backend but
     can still be named in the marker grouping. An empty "Level 3" heading
     would say a place was photographed when its photo has been deleted. */
  const out = groupByPlace(
    [P('Benl1_2026-04-29_07-19-22.jpg')],
    [{ location: 'Level 2', filenames: ['Benl1_2026-04-29_07-19-22.jpg'] },
     { location: 'Level 3', filenames: ['Benl1_2026-04-29_11-08-44.jpg'] }]);
  assert.deepStrictEqual(out.groups.map((g) => g.location), ['Level 2']);
});

test('one photo named by two places is placed once, by the first that claims it', () => {
  /* The backend assigns each photo one location, so this should not happen.
     It is pinned because the grouping must not silently double a photo if it
     ever does — the same failure the topic binding actually has on prod. */
  const out = groupByPlace(
    [P('Benl1_2026-04-29_07-19-22.jpg')],
    [{ location: 'Level 2', filenames: ['Benl1_2026-04-29_07-19-22.jpg'] },
     { location: 'Level 3', filenames: ['Benl1_2026-04-29_07-19-22.jpg'] }]);
  const seen = out.groups.reduce((a, g) => a.concat(g.photos), []).concat(out.ungrouped);
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual(out.groups.map((g) => g.location), ['Level 2']);
});

/* ---- wiring pins (source scan — these pin CONNECTIONS, not behaviour) ---- */

const fsmod = require('node:fs');
const pathmod = require('node:path');
const readPage = () =>
  fsmod.readFileSync(pathmod.join(__dirname, '..', 'scripts', 'pages', 'evidence.js'), 'utf8')
    .replace(/\r\n/g, '\n');

test('Evidence offers By place and routes it through groupByPlace', () => {
  const src = readPage();
  assert.match(src, /\['place', 'By place'\]/, 'the control exists');
  assert.match(src, /eg\.groupByPlace\(day\.photos, day\.photo_groups\)/,
    'and is backed by the real grouping over the day s own groups');
});

test('the day row carries photo_groups, or By place has nothing to group by', () => {
  assert.match(readPage(), /photo_groups: x\.report\.photo_groups/);
});

test('the grouped render is not gated on the topic mode alone', () => {
  /* It used to read `props.groupMode === 'topic'`, which silently fell back
     to the flat grid for any mode added later — the failure would be a
     control that does nothing, not an error. */
  assert.doesNotMatch(readPage(), /props\.groupMode === 'topic' && grouped/);
});
