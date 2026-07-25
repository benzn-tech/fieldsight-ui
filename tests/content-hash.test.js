'use strict';

/*
 * Parity guard for scripts/api/content-hash.js — the JS twin of
 * src/content_hash.py that lets the /safety + /quality read path
 * (compliance-aggregator.js) rebuild the durable resolved-mark lookup keyed on
 * content_hash. The write endpoint hashes `text` server-side with the Python
 * module; this twin MUST reproduce it byte-for-byte, or a resolved mark
 * silently orphans across the write/read boundary (no error, the flag just
 * flips back to open).
 *
 * The golden fixture (tests/content_hash_golden.json) is VENDORED verbatim
 * from the backend (src/content_hash_golden.json) so this test travels with
 * the UI code and pins the exact input->hash pairs BOTH sides must agree on.
 * If any pair regresses, the algorithms have drifted — STOP, do not ship.
 *
 * content-hash.js is a browser IIFE that also exports under CommonJS; requiring
 * it under Node needs no window stub (the module guards typeof window).
 */
const test = require('node:test');
const assert = require('node:assert');

const { normalize, contentHash } = require('../scripts/api/content-hash.js');
const golden = require('./content_hash_golden.json');

/* ---- golden-fixture parity: every backend pair, byte-for-byte ------------- */

test('contentHash reproduces every golden-fixture pair (backend parity)', () => {
  assert.ok(Array.isArray(golden.cases) && golden.cases.length === 8,
    'the vendored fixture must carry all 8 backend cases');
  golden.cases.forEach(function (c) {
    assert.strictEqual(contentHash(c.input), c.hash,
      'HASH DRIFT for input ' + JSON.stringify(c.input) +
      ' — the JS twin no longer agrees with src/content_hash.py; STOP');
  });
});

/* ---- normalize(): the exact ordered spec --------------------------------- */

test('normalize trims and collapses every internal whitespace run to one space', () => {
  assert.strictEqual(normalize('  Loose   handrail on level 3  '), 'loose handrail on level 3');
  assert.strictEqual(normalize('Missing guardrail\tnear\nthe edge'), 'missing guardrail near the edge');
});

test('normalize lowercases (casefold twin for ASCII/Latin) but keeps punctuation', () => {
  assert.strictEqual(normalize('LOOSE HANDRAIL ON LEVEL 3'), 'loose handrail on level 3');
  assert.strictEqual(normalize('Rebar @ 200mm c/c -- check spacing'), 'rebar @ 200mm c/c -- check spacing');
});

test('normalize coerces null/undefined to the empty string (a missing field hashes like empty)', () => {
  assert.strictEqual(normalize(null), '');
  assert.strictEqual(normalize(undefined), '');
  assert.strictEqual(contentHash(null), contentHash(''));
  assert.strictEqual(contentHash(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'the empty string is sha256("") — the well-known constant');
});

test('normalize NFC-composes so pre-composed and decomposed forms hash identically', () => {
  const composed = 'café';        // cafe + precomposed e-acute (U+00E9)
  const decomposed = 'café';     // cafe + e + combining acute (U+0301)
  assert.notStrictEqual(composed, decomposed, 'the two inputs are distinct code-point sequences');
  assert.strictEqual(normalize(composed), normalize(decomposed));
  assert.strictEqual(contentHash(composed), contentHash(decomposed));
});
