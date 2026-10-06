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
  const tree = load().render(web({ status: 'unverified', answer: 'x' }));
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

/* ---- review fixes: grounded+from_web numbering, unverified wording ------ */

const cites = [{ source_s3_key: 'k1', topic_title: 'A' }, { source_s3_key: 'k2', topic_title: 'B' }];

test('grounded + from_web: record cards are numbered [n], not bullets', () => {
  const t = text(load().citations(cites, false));
  assert.match(t, /\[1\]/); assert.match(t, /\[2\]/);
  assert.ok(!t.includes('•'));
});
test('ungrounded from_web: bullets only', () => {
  const t = text(load().citations(cites, true));
  assert.match(t, /•/); assert.ok(!/\[1\]/.test(t));
});
test('message wiring: grounded stored and picks the numbered form', () => {
  const src = fs.readFileSync(require.resolve('../scripts/composites/ask-chat.js'), 'utf8');
  assert.match(src, /grounded:\s+!!res\.grounded/);
  assert.match(src, /renderCitations\(m\.citations, !m\.grounded\)/);
});
test('unverified with no answer says no general answer', () => {
  const t = text(load().render(web({ status: 'unverified', answer: null })));
  assert.match(t, /Web check unavailable — no general answer/);
  assert.ok(!/Model knowledge/.test(t));
  assert.match(text(load().render(web({ status: 'unverified', answer: '  ' }))), /no general answer/);
});
test('unverified with an answer keeps the model-knowledge line', () => {
  assert.match(text(load().render(web({ status: 'unverified', answer: 'x' }))), /Model knowledge — not verified online/);
});
test('web block header: model knowledge when unverified, open web only when verified', () => {
  const o = load().origin;
  const base = { fromWeb: true, text: 'main', web: { answer: 'general', sources: [] } };
  const un = text(o(Object.assign({}, base, { web: Object.assign({}, base.web, { status: 'unverified' }) })));
  assert.match(un, /Model knowledge — not verified online/);
  assert.ok(!/open web/.test(un));
  const ok = text(o(Object.assign({}, base, { web: Object.assign({}, base.web, { status: 'verified' }) })));
  assert.match(ok, /From the open web/);
  assert.match(text(o({ fromWeb: true, text: 'm', web: { sources: [] } })), /From the open web/);
});
