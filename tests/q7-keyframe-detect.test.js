'use strict';

/*
 * Unit tests for the Q7 keyframe-detection helper in
 * scripts/composites/photo-grid.js. Mirrors the backend's own basename
 * check (DELETE /api/org/media/keyframe rejects any key whose basename
 * doesn't match _kf_s\d{6}\.jpg) — a photo is only ever offered a delete
 * control when isKeyframe(filename) is true.
 *
 * photo-grid.js is a browser IIFE that touches React only inside component
 * bodies and registers on window.FieldSight at load. Stub both globals so
 * requiring it in Node runs the IIFE (registration is a harmless no-op on
 * the stub) and hands us the pure helper via its (browser-guarded)
 * module.exports — same pattern as tests/timeline-redaction-overrides.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {};
global.React = global.React || {};

const { isKeyframe } = require('../scripts/composites/photo-grid.js');

test('isKeyframe: true for an auto-generated keyframe filename', () => {
  assert.strictEqual(isKeyframe('x_kf_s093000.jpg'), true);
});

test('isKeyframe: false for a real (user-taken) photo', () => {
  assert.strictEqual(isKeyframe('IMG_20260722_093015.jpg'), false);
});

test('isKeyframe: false when the second count is not exactly 6 digits', () => {
  assert.strictEqual(isKeyframe('x_kf_s93000.jpg'), false);
  assert.strictEqual(isKeyframe('x_kf_s0930000.jpg'), false);
});

test('isKeyframe: false for a different extension', () => {
  assert.strictEqual(isKeyframe('x_kf_s093000.png'), false);
});

test('isKeyframe: false when the marker is not at the end of the basename', () => {
  assert.strictEqual(isKeyframe('x_kf_s093000.jpg.bak'), false);
});

test('isKeyframe: tolerates falsy input', () => {
  assert.strictEqual(isKeyframe(''), false);
  assert.strictEqual(isKeyframe(null), false);
  assert.strictEqual(isKeyframe(undefined), false);
});
