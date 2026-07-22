'use strict';
const test = require('node:test');
const assert = require('node:assert');
global.window = global.window || {};
global.React = global.React || {};
const { diffWords } = require('../scripts/pages/timeline.js');

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
