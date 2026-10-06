'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

/* Outside-lookup status line + conflicts (backend spec 2026-10-06, D1/D5).
 * React is stubbed so createElement returns a plain tree we can flatten. */

function load() {
  global.window = { FieldSight: {}, FS: { api: {} } };
  global.React = { createElement: function (type, props) {
    return { type, props: props || {}, kids: [].slice.call(arguments, 2) };
  } };
  delete require.cache[require.resolve('../scripts/composites/ask-chat.js')];
  require('../scripts/composites/ask-chat.js');
  return global.window.FieldSight._askWebStatus;
}
function text(n) {
  if (n == null) return '';
  if (typeof n === 'string') return n;
  if (Array.isArray(n)) return n.map(text).join('|');
  return text(n.kids);
}
const web = (o) => ({ web: Object.assign({ answer: null, sources: [] }, o) });

test('verified: counts web sources', () => {
  const t = text(load().render(web({ status: 'verified', sources: [{}, {}, {}] })));
  assert.match(t, /Checked against 3 web sources/);
});
test('unverified: says model knowledge, with warning style', () => {
  const tree = load().render(web({ status: 'unverified' }));
  assert.match(text(tree), /Model knowledge — not verified online \(web search failed\)/);
  assert.match(tree.kids[1].props.className, /--warn/);
});
test('too_long: says not searched', () => {
  assert.match(text(load().render(web({ status: 'too_long' }))), /Not searched online \(question too long\)/);
});
test('not_needed renders nothing', () => {
  assert.strictEqual(load().render(web({ status: 'not_needed' })), null);
});
test('no web block (project answer) renders nothing', () => {
  assert.strictEqual(load().render({ web: null }), null);
  assert.strictEqual(load().render({}), null);
});
test('old-shape response without status renders nothing new', () => {
  assert.strictEqual(load().render(web({ refused: 'x', timed_out: true })), null);
});
test('conflicts render under a heading', () => {
  const t = text(load().render(web({ status: 'verified', sources: [{}], conflicts: ['records say 900 mm; F4/AS1 says 1000 mm'] })));
  assert.match(t, /⚠ Records and the standard disagree/);
  assert.match(t, /900 mm/);
});
test('web sources are never merged into citations; refused line is gated on status', () => {
  const src = fs.readFileSync(require.resolve('../scripts/composites/ask-chat.js'), 'utf8');
  const i = src.indexOf('m.web && m.web.refused');
  assert.match(src.slice(i, i + 120), /typeof m\.web\.status !== 'string'/);
  const f = src.slice(src.indexOf('function renderWebStatus'), src.indexOf('function renderWebOrigin'));
  assert.ok(f.length > 200);
  assert.ok(!/citations/.test(f.replace(/\/\*[\s\S]*?\*\//g, '')));
});
