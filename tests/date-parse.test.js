'use strict';
const test = require('node:test');
const assert = require('node:assert');

/* Stubs so the browser IIFEs load under Node (they only touch these at
   registration / inside functions). */
function addDaysISO(iso, n) {
  const p = String(iso).split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.toISOString().slice(0, 10);
}
global.window = { FieldSight: {}, FS: { api: { addDaysISO } } };
global.React = {};
global.document = { addEventListener() {}, removeEventListener() {} };

const { parseISO } = require('../scripts/composites/date-picker.js');
require('../scripts/api/today-adapter.js');
const resolveDeadline = global.window.FS.api.resolveDeadline;

/* ---- parseISO: never return an Invalid Date (defense-in-depth vs crash) ---- */
test('parseISO: valid ISO -> UTC Date', () => {
  assert.strictEqual(parseISO('2026-07-28').toISOString().slice(0, 10), '2026-07-28');
});
test('parseISO: fuzzy / non-ISO -> null (NOT an Invalid Date)', () => {
  assert.strictEqual(parseISO('Week after next Tuesday (2026-07-28 approx.)'), null);
  assert.strictEqual(parseISO('not a date'), null);
  assert.strictEqual(parseISO('2026-13-40'), null);
  assert.strictEqual(parseISO(''), null);
  assert.strictEqual(parseISO(null), null);
});

/* ---- resolveDeadline: an explicit embedded date wins over relative phrasing ---- */
test('resolveDeadline: embedded ISO wins over the weekday phrase', () => {
  assert.strictEqual(
    resolveDeadline('Week after next Tuesday (2026-07-28 approx.)', '2026-07-15').absolute,
    '2026-07-28');
});
test('resolveDeadline: bare ISO in text', () => {
  assert.strictEqual(resolveDeadline('2026-02-12', '2026-01-01').absolute, '2026-02-12');
});
test('resolveDeadline: relative phrases still resolve when no explicit date', () => {
  assert.strictEqual(resolveDeadline('Today', '2026-07-15').absolute, '2026-07-15');
  assert.strictEqual(resolveDeadline('Tomorrow', '2026-07-15').absolute, '2026-07-16');
  assert.strictEqual(resolveDeadline('within 3 days', '2026-07-15').absolute, '2026-07-18');
});
test('resolveDeadline: empty -> null', () => {
  assert.strictEqual(resolveDeadline('', '2026-07-15').absolute, null);
});
