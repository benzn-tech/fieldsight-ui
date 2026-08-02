'use strict';

/*
 * Window preference round-trip.
 *
 * The preset lives in the user's prefs on the server, not localStorage, so it
 * follows someone from the office desktop to the site tablet (spec §7). That
 * makes the read path the fragile one: it has to survive a caller with no
 * prefs at all, a prefs blob written by some other surface, and a stored key
 * that no longer matches any preset.
 *
 * The write path has its own hazard — sending the whole prefs object back
 * would clobber every other surface's settings. It sends one key and lets the
 * server's `prefs || %s` merge do the rest.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  readWindowPref, windowPrefPatch, PREF_KEY,
} = require('../scripts/composites/programme-window-picker.js');
const { DEFAULT_PRESET_KEY } = require('../scripts/api/programme-window.js');

/* ---- reading ------------------------------------------------------------- */

test('a stored preset is used', () => {
  assert.strictEqual(readWindowPref({ prefs: { programmeWindow: '4-12' } }).key, '4-12');
});

test('a caller with no prefs at all falls back to the default', () => {
  assert.strictEqual(readWindowPref({}).key, DEFAULT_PRESET_KEY);
  assert.strictEqual(readWindowPref({ prefs: {} }).key, DEFAULT_PRESET_KEY);
  assert.strictEqual(readWindowPref(null).key, DEFAULT_PRESET_KEY);
});

test('prefs written by another surface do not break the read', () => {
  /* prefs is shared. A surface that has never heard of programmeWindow will
     still have written its own keys there. */
  const me = { prefs: { theme: 'dark', todayHideAged: true } };
  assert.strictEqual(readWindowPref(me).key, DEFAULT_PRESET_KEY);
});

test('a stored key that no longer matches any preset falls back', () => {
  /* Presets can be renamed or dropped between releases; the stored value
     outlives them. Returning undefined here would throw on the next page
     load with no way for the user to clear it. */
  assert.strictEqual(readWindowPref({ prefs: { programmeWindow: '99-99' } }).key,
    DEFAULT_PRESET_KEY);
});

test('a non-string stored value falls back rather than throwing', () => {
  assert.strictEqual(readWindowPref({ prefs: { programmeWindow: 7 } }).key,
    DEFAULT_PRESET_KEY);
  assert.strictEqual(readWindowPref({ prefs: { programmeWindow: null } }).key,
    DEFAULT_PRESET_KEY);
});

/* ---- writing ------------------------------------------------------------- */

test('the patch carries only this surface\'s key', () => {
  /* Sending the whole prefs object back would clobber every other surface's
     settings with whatever this page happened to be holding. */
  const patch = windowPrefPatch('2-8');
  assert.deepStrictEqual(patch, { prefs: { [PREF_KEY]: '2-8' } });
  assert.strictEqual(Object.keys(patch.prefs).length, 1);
});

test('the patch accepts a preset object as well as a key', () => {
  assert.deepStrictEqual(windowPrefPatch({ key: '4-4' }),
    { prefs: { [PREF_KEY]: '4-4' } });
});

test('an unknown key is normalised before being stored', () => {
  /* Otherwise the next read has to cope with it, and every future reader
     inherits the mess. */
  assert.deepStrictEqual(windowPrefPatch('nonsense'),
    { prefs: { [PREF_KEY]: DEFAULT_PRESET_KEY } });
});
