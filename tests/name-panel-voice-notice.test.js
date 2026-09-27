'use strict';

/*
 * The naming panel TELLS the user a voice is stored; it does not ask for a
 * separate consent tick (owner decision 2026-09-27).
 *
 * The removed checkbox said "only they can agree" but gated nothing: with the
 * company's basis declared, the voice was stored whether or not it was ticked.
 * These render NamePanel against a minimal React double and read the tree.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function el(type, props) {
  const children = Array.prototype.slice.call(arguments, 2);
  return { type: type, props: props || {}, children: children };
}

function loadPanel() {
  const React = {
    createElement: el,
    useState: function (init) { return [init, function () {}]; },
    useEffect: function () {},
    useRef: function () { return { current: null }; },
    Fragment: 'Fragment',
  };
  const window = { FS: { speakerNaming: require('../scripts/api/speaker-naming.js') }, FieldSight: {} };
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'composites', 'transcript-list.js'), 'utf8');
  vm.runInNewContext(src, { window: window, React: React, console: console });
  return window.FieldSight.TranscriptList.NamePanel;
}

function walk(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(function (n) { walk(n, out); }); return out; }
  out.push(node);
  (node.children || []).forEach(function (c) { walk(c, out); });
  return out;
}

function text(node) {
  return walk(node, []).map(function (n) {
    return (n.children || []).filter(function (c) { return typeof c === 'string'; }).join('');
  }).join(' ');
}

function render(extra) {
  const NamePanel = loadPanel();
  const saved = [];
  const tree = NamePanel(Object.assign({
    segment: { speaker_name: 'Sam Yu' },
    candidates: [{ name: 'Sam Yu', source: 'here' }],
    consentAvailable: true,
    roster: [{ id: 'u1', display_name: 'Sam Yu' }],
    onSave: function (name, consent) { saved.push([name, consent]); },
    onCancel: function () {},
  }, extra || {}));
  return { tree: tree, saved: saved };
}

test('there is no consent checkbox in the naming panel', function () {
  const nodes = walk(render().tree, []);
  const boxes = nodes.filter(function (n) {
    return n.type === 'input' && n.props.type === 'checkbox';
  });
  assert.strictEqual(boxes.length, 0);
});

test('the panel says the voice will be stored, naming the person', function () {
  assert.match(text(render().tree), /Saving also stores Sam Yu’s voice/);
});

test('no notice where naming cannot store anything', function () {
  assert.doesNotMatch(text(render({ consentAvailable: false }).tree), /stores/);
});

test('Save sends the name with no per-person consent claim', function () {
  const r = render();
  const save = walk(r.tree, []).filter(function (n) {
    return n.type === 'button' && (n.children || []).indexOf('Save') !== -1;
  })[0];
  assert.ok(save, 'Save button rendered');
  save.props.onClick();
  assert.deepStrictEqual(r.saved, [['Sam Yu', null]]);
});
