'use strict';
const test = require('node:test');
const assert = require('node:assert');
global.window = global.window || {};
global.React = global.React || {};
const { diffWords, formatEditTime, formatContentEdit } = require('../scripts/pages/timeline.js');

const join = (segs, types) => segs.filter(s => types.includes(s.type)).map(s => s.text).join('');

test('diffWords: identical text is one same segment', () => {
  assert.deepStrictEqual(diffWords('a b c', 'a b c'), [{ type: 'same', text: 'a b c' }]);
});
test('diffWords: pure insert', () => {
  const segs = diffWords('a c', 'a b c');
  assert.deepStrictEqual(segs.map(s => s.type), ['same', 'ins', 'same']);
  assert.strictEqual(join(segs, ['same', 'ins']), 'a b c');
});
test('diffWords: pure delete', () => {
  const segs = diffWords('a b c', 'a c');
  assert.deepStrictEqual(segs.map(s => s.type), ['same', 'del', 'same']);
  assert.strictEqual(join(segs, ['same', 'del']), 'a b c');
});
test('diffWords: replaced word is del then ins', () => {
  const segs = diffWords('a b c', 'a x c');
  assert.deepStrictEqual(segs.map(s => s.type), ['same', 'del', 'ins', 'same']);
  assert.strictEqual(join(segs, ['same', 'del']), 'a b c');
  assert.strictEqual(join(segs, ['same', 'ins']), 'a x c');
});
test('diffWords: empty before → single ins; empty after → single del', () => {
  assert.deepStrictEqual(diffWords('', 'a b'), [{ type: 'ins', text: 'a b' }]);
  assert.deepStrictEqual(diffWords('a b', ''), [{ type: 'del', text: 'a b' }]);
});
test('diffWords: full rewrite → all del then all ins, reconstructs both sides', () => {
  const segs = diffWords('a b', 'x y');
  assert.strictEqual(join(segs, ['same', 'del']), 'a b');
  assert.strictEqual(join(segs, ['same', 'ins']), 'x y');
});

test('formatEditTime: UTC → NZ standard time (winter, +12)', () => {
  // 2026-07-22 is NZ winter (NZST, UTC+12): 03:14Z → 15:14
  assert.strictEqual(formatEditTime('2026-07-22T03:14:00+00:00'), '2026/07/22 15:14');
});
test('formatEditTime: UTC → NZ daylight time (summer, +13)', () => {
  // 2026-01-15 is NZ summer (NZDT, UTC+13): 03:14Z → 16:14
  assert.strictEqual(formatEditTime('2026-01-15T03:14:00+00:00'), '2026/01/15 16:14');
});
test('formatEditTime: DB space-separated timestamp with microseconds', () => {
  assert.strictEqual(formatEditTime('2026-07-22 03:14:53.757118+00:00'), '2026/07/22 15:14');
});
test('formatEditTime: empty → empty', () => {
  assert.strictEqual(formatEditTime(''), '');
  assert.strictEqual(formatEditTime(null), '');
});
test('formatContentEdit: assembles field/when/who/segments with name preferred over role', () => {
  const out = formatContentEdit({
    field: 'topic_title', created_at: '2026-07-22T03:14:00+00:00',
    actor_name: 'Bailey Lin', actor_role: 'site_manager',
    before_text: 'a b c', after_text: 'a x c',
  });
  assert.strictEqual(out.field, 'topic_title');
  assert.strictEqual(out.when, '2026/07/22 15:14');
  assert.strictEqual(out.who, 'Bailey Lin');
  assert.deepStrictEqual(out.segments.map(s => s.type), ['same', 'del', 'ins', 'same']);
});
test('formatContentEdit: falls back to actor_role, then Unknown', () => {
  assert.strictEqual(formatContentEdit({ actor_role: 'admin', before_text: '', after_text: 'x' }).who, 'admin');
  assert.strictEqual(formatContentEdit({ before_text: '', after_text: 'x' }).who, 'Unknown');
});
