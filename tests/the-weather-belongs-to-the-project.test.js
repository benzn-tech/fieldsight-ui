'use strict';

/*
 * The weather panel showed a forecast and never said where it was for, and
 * the last link in its coordinate chain was a hardcoded Christchurch.
 *
 * Measured on prod: five of the eight active projects have no coordinate.
 * MANGERE WASTEWATER (location "Auckland") and SB1131 Northbrook Wanaka
 * (location "Wanaka") were both being shown Christchurch — 760km away, and
 * coastal weather standing in for alpine — with nothing on screen to reveal
 * it. UC PK has a full street address and still no coordinate, so the
 * address-only backfill either never ran against prod or failed on it.
 *
 * The chain now is: saved coordinates -> geocode the address -> geocode the
 * human label -> say we cannot place it. `location` holds city names in
 * practice ("Auckland", "Wanaka", "Christchurch"), which all resolve and are
 * the right granularity for a forecast anyway.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/* app-shell.js is a browser script, not a module. Lift the three functions
   under test out and run them, so these exercise the real definitions rather
   than a restatement of them. */
function loadWeatherHelpers(geocodeAddress) {
  const source = fs
    .readFileSync(path.join(__dirname, '..', 'scripts', 'app-shell.js'), 'utf8')
    .replace(/\r\n/g, '\n');

  const parts = ['shortPlace', 'geocodeOnce', 'resolveSitePlace', 'placeProvenance'].map(function (name) {
    const m = source.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'));
    assert.ok(m, name + ' has moved or been renamed');
    return m[0];
  });

  const memo = source.match(/const geocodeMemo = \{\};/);
  assert.ok(memo, 'geocodeMemo has moved or been renamed');

  const sandbox = {
    FS: { api: { org: { geocodeAddress: geocodeAddress } } },
  };
  // eslint-disable-next-line no-new-func
  return new Function('window',
    'const geocodeMemo = {};\n' + parts.join('\n')
    + '\nreturn { shortPlace, geocodeOnce, resolveSitePlace, placeProvenance };')(sandbox);
}

/* A geocoder that answers for the three city names prod actually stores, and
   records what it was asked so a test can prove the chain stopped early. */
function fakeGeocoder(calls, table) {
  return function (q) {
    calls.push(q);
    const hit = table[String(q).toLowerCase()];
    return Promise.resolve(hit ? [hit] : []);
  };
}

const CITIES = {
  auckland:     { lat: -36.8521, lng: 174.7632, formatted: 'Auckland' },
  wanaka:       { lat: -44.6942, lng: 169.1365, formatted: 'Wanaka' },
  christchurch: { lat: -43.5310, lng: 172.6364, formatted: 'Christchurch' },
};

/* ---------- the chain, in order --------------------------------------- */

test('a saved coordinate is used as-is and asks the geocoder nothing', async () => {
  const calls = [];
  const { resolveSitePlace } = loadWeatherHelpers(fakeGeocoder(calls, CITIES));

  const out = await resolveSitePlace({
    name: 'Project For Sam', location: '', address: '63 Manchester Street',
    latitude: -43.5321, longitude: 172.6362,
  });

  assert.strictEqual(out.source, 'saved');
  assert.deepStrictEqual([out.lat, out.lng], [-43.5321, 172.6362]);
  assert.deepStrictEqual(calls, [],
    'a site that already has coordinates must not be geocoded — the record '
    + 'is the answer, and a guess could quietly disagree with it');
});

test('with no coordinate, the address is geocoded', async () => {
  const calls = [];
  const { resolveSitePlace } = loadWeatherHelpers(
    fakeGeocoder(calls, { 'christchurch': CITIES.christchurch }));

  const out = await resolveSitePlace({
    name: 'UC PK', location: 'South Island', address: 'Christchurch',
    latitude: null, longitude: null,
  });

  assert.strictEqual(out.source, 'address');
  assert.strictEqual(out.place, 'Christchurch');
  assert.deepStrictEqual(calls, ['Christchurch']);
});

test('with no address, the human label is geocoded — this is the prod majority', async () => {
  const calls = [];
  const { resolveSitePlace } = loadWeatherHelpers(fakeGeocoder(calls, CITIES));

  const out = await resolveSitePlace({
    name: 'MANGERE WASTEWATER TREATMENT', location: 'Auckland',
    address: null, latitude: null, longitude: null,
  });

  assert.strictEqual(out.source, 'location');
  assert.strictEqual(out.place, 'Auckland');
  assert.deepStrictEqual([out.lat, out.lng], [-36.8521, 174.7632]);

  /* The failure this replaces: this project was being shown -43.53, 172.63. */
  assert.ok(Math.abs(out.lat - (-43.5321)) > 5,
    'Auckland must not resolve anywhere near the old Christchurch default');
});

test('an address that will not geocode falls through to the label, not to a default', async () => {
  const calls = [];
  const { resolveSitePlace } = loadWeatherHelpers(
    fakeGeocoder(calls, { 'wanaka': CITIES.wanaka }));

  const out = await resolveSitePlace({
    name: 'SB1131 Northbrook Wanaka', location: 'Wanaka',
    address: 'Lot 4, no street number', latitude: null, longitude: null,
  });

  assert.strictEqual(out.source, 'location');
  assert.deepStrictEqual([out.lat, out.lng], [-44.6942, 169.1365]);
  assert.deepStrictEqual(calls, ['Lot 4, no street number', 'Wanaka'],
    'the address is tried first and the label second');
});

test('a project with nothing to place resolves to null, never to a city', async () => {
  const calls = [];
  const { resolveSitePlace } = loadWeatherHelpers(fakeGeocoder(calls, CITIES));

  const out = await resolveSitePlace({
    name: 'UC', location: '', address: null, latitude: null, longitude: null,
  });

  assert.strictEqual(out, null,
    'null is the honest answer. Falling back to a hardcoded coordinate is '
    + 'what made a wrong forecast indistinguishable from a right one');
});

test('a geocoder that answers nothing yields null rather than a stale guess', async () => {
  const { resolveSitePlace } = loadWeatherHelpers(function () { return Promise.resolve([]); });
  const out = await resolveSitePlace({
    name: 'Somewhere', location: 'Nowhere At All', address: null,
    latitude: null, longitude: null,
  });
  assert.strictEqual(out, null);
});

test('a geocoder that throws does not take the panel down', async () => {
  const { resolveSitePlace } = loadWeatherHelpers(function () {
    return Promise.reject(new Error('network'));
  });
  const out = await resolveSitePlace({
    name: 'Somewhere', location: 'Auckland', address: null,
    latitude: null, longitude: null,
  });
  assert.strictEqual(out, null);
});

test('zero is a coordinate, not a missing one', async () => {
  const calls = [];
  const { resolveSitePlace } = loadWeatherHelpers(fakeGeocoder(calls, CITIES));
  const out = await resolveSitePlace({
    name: 'Null Island', location: 'Auckland', address: null,
    latitude: 0, longitude: 0,
  });
  assert.strictEqual(out.source, 'saved',
    'a `!site.latitude` test would treat 0 as absent and geocode over a real '
    + 'stored position');
  assert.deepStrictEqual(calls, []);
});

/* ---------- which of the two place fields gets shown ------------------- */

/* Reported from the running app: UC PK's panel read "South Island".
   That project's address is "Forestry Road, Christchurch, 8041, Canterbury,
   New Zealand". The first version of this file chose the label as
   `location || address || name`, on the theory that `location` is the human
   one — but in production `location` is mostly an administrative region, so
   that theory put a third of the country on screen in place of a street. */

test('a saved coordinate is labelled by its address, not by a region in `location`', async () => {
  const { resolveSitePlace } = loadWeatherHelpers(fakeGeocoder([], CITIES));
  const out = await resolveSitePlace({
    name: 'UC PK', location: 'South Island',
    address: 'Forestry Road, Christchurch, 8041, Canterbury, New Zealand',
    latitude: -43.5227319, longitude: 172.5852876,
  });
  assert.strictEqual(out.place, 'Forestry Road, Christchurch',
    '"South Island" does not answer "where is this forecast for?"');
  assert.strictEqual(out.placeFull,
    'Forestry Road, Christchurch, 8041, Canterbury, New Zealand',
    'the full postal string stays available for the title attribute');
});

test('`location` is still the label when there is no address', async () => {
  const { resolveSitePlace } = loadWeatherHelpers(fakeGeocoder([], CITIES));
  const out = await resolveSitePlace({
    name: 'MANGERE WASTEWATER TREATMENT', location: 'Auckland',
    address: null, latitude: null, longitude: null,
  });
  assert.strictEqual(out.place, 'Auckland');
});

test('the name is the last resort, not a coordinate pair', async () => {
  const { resolveSitePlace } = loadWeatherHelpers(fakeGeocoder([], CITIES));
  const out = await resolveSitePlace({
    name: 'Bridge 4 Abutment', location: '', address: '',
    latitude: -41.2, longitude: 174.8,
  });
  assert.strictEqual(out.place, 'Bridge 4 Abutment',
    'the reader wants to recognise the site, not verify the arithmetic');
});

test('a postal address is shortened to the street and the town', () => {
  const { shortPlace } = loadWeatherHelpers(function () { return Promise.resolve([]); });
  assert.strictEqual(
    shortPlace('Forestry Road, Christchurch, 8041, Canterbury, New Zealand'),
    'Forestry Road, Christchurch');
  assert.strictEqual(
    shortPlace('63 Manchester Street, Christchurch, 8011, Canterbury, New Zealand'),
    '63 Manchester Street, Christchurch');
});

test('a postcode never becomes the second half of the label', () => {
  const { shortPlace } = loadWeatherHelpers(function () { return Promise.resolve([]); });
  /* This one has no suburb, so the naive "first two parts" reads
     "111 Frankton-Ladies Mile Highway, 9304". */
  assert.strictEqual(
    shortPlace('111 Frankton-Ladies Mile Highway, 9304, Otago, New Zealand'),
    '111 Frankton-Ladies Mile Highway, Otago');
});

test('an address with nothing to trim is returned as it stands', () => {
  const { shortPlace } = loadWeatherHelpers(function () { return Promise.resolve([]); });
  assert.strictEqual(shortPlace('Riccarton'), 'Riccarton');
  assert.strictEqual(shortPlace('  '), null);
  assert.strictEqual(shortPlace(null), null);
  assert.strictEqual(shortPlace('8041'), '8041',
    'an address that is ONLY a number is odd data, but dropping every part '
    + 'would leave the panel with no label at all');
});

/* ---------- the geocoder is asked once -------------------------------- */

test('the same query is asked once, however many times it is resolved', async () => {
  const calls = [];
  const { geocodeOnce } = loadWeatherHelpers(fakeGeocoder(calls, CITIES));

  await geocodeOnce('Auckland');
  await geocodeOnce('auckland');
  await geocodeOnce('  Auckland  ');

  assert.deepStrictEqual(calls, ['Auckland'],
    'the panel re-resolves on every site switch; without memoisation a user '
    + 'flicking between projects hammers a free public geocoder');
});

test('a miss is remembered too', async () => {
  const calls = [];
  const { geocodeOnce } = loadWeatherHelpers(fakeGeocoder(calls, {}));
  await geocodeOnce('Nowhere');
  await geocodeOnce('Nowhere');
  assert.strictEqual(calls.length, 1,
    'caching only the hits re-asks the unanswerable question forever');
});

/* ---------- what the reader is told ------------------------------------ */

test('a guessed coordinate says so; a saved one does not apologise', () => {
  const { placeProvenance } = loadWeatherHelpers(function () { return Promise.resolve([]); });

  assert.strictEqual(placeProvenance('saved'), null,
    'a coordinate from the record needs no caveat');
  assert.match(placeProvenance('address'), /address/);
  assert.match(placeProvenance('location'), /location/);
  assert.match(placeProvenance('default'), /no project selected/);
});

/* ---------- the panel has somewhere to render it ----------------------- */

test('the place line and the unplaceable state exist in the stylesheet', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'styles', 'app-shell.css'), 'utf8');
  ['.fs-weather-popover__place',
   '.fs-weather-popover__place-name',
   '.fs-weather-popover__place-source',
   '.fs-weather-popover__empty-body',
   '.fs-utility-item--muted'].forEach(function (cls) {
    assert.ok(css.indexOf(cls) !== -1, cls + ' is rendered but has no rule');
  });
});

test('the popover is handed the place and its provenance, not just numbers', () => {
  const source = fs
    .readFileSync(path.join(__dirname, '..', 'scripts', 'app-shell.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  assert.match(source, /place: coord && coord\.place/);
  assert.match(source, /placeSource: coord && coord\.source/);
  assert.doesNotMatch(source, /\|\| WEATHER_DEFAULT_COORD;/,
    'the unconditional fallback to Christchurch is the defect; it must not '
    + 'come back as the tail of the live chain');
});
