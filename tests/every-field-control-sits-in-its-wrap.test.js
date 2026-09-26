'use strict';

/*
 * Every form control in the report dialog sits inside `.fs-field__control-wrap`.
 *
 * THE THIRD SHAPE OF THE SAME DEFECT. The dialog shipped with no stylesheet;
 * then it turned out two of the names were wrong; and once both were fixed,
 * every single-line input still rendered 18px tall with its text sitting on the
 * border. Every class had a rule. The rules were right. The ELEMENTS WERE
 * NESTED WRONG:
 *
 *   .fs-field__control is `flex: 1 1 0%`, written for a child of
 *   .fs-field__control-wrap -- a ROW, where it means "fill the width". The
 *   dialog put the control straight into .fs-field, which is a COLUMN, and the
 *   same declaration then applied to the height axis: basis 0, and the size
 *   modifier's `height: 40px` lost to it.
 *
 * Measured in the browser, on the live page: 18.3px unwrapped, 40px with the
 * wrap inserted by hand. The textareas looked fine only because their
 * min-height beat the basis.
 *
 * `report-dialog-has-a-stylesheet.test.js` cannot see this -- every class here
 * HAS a rule -- and neither can a scan of the source for class names. So this
 * one renders the step components into a tree, with a React stub just rich
 * enough to build one, and checks each control's actual parent.
 *
 * THE test is `every labelled control is inside a wrap`.
 */
const test = require('node:test');
const assert = require('node:assert');

/* ---- a React stub that builds a tree and nothing else ----------------------- */

function createElement(type, props) {
  const children = Array.prototype.slice.call(arguments, 2);
  return { type: type, props: props || {}, children: children };
}
global.React = {
  createElement: createElement,
  useState: function (init) { return [typeof init === 'function' ? init() : init, function () {}]; },
  useEffect: function () {},
  useRef: function (v) { return { current: v }; },
  useMemo: function (f) { return f(); },
  useCallback: function (f) { return f; },
};
global.window = global.window || {};
global.window.FieldSight = global.window.FieldSight || {};
global.window.React = global.React;

const M = require('../scripts/composites/session-report-modal.js');

/* Expand function components into their output, recursively, so the tree is
   what the browser would lay out -- not what the source happens to say. */
function expand(node) {
  if (node === null || node === undefined || node === false || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node.type === 'function') {
    return expand(node.type(Object.assign({}, node.props, { children: node.children })));
  }
  return { type: node.type, props: node.props, children: node.children.map(expand) };
}

function classes(node) {
  return String((node && node.props && node.props.className) || '').split(/\s+/);
}

/* Every element carrying `cls`, with its parent. */
function findWithParent(tree, cls) {
  const out = [];
  (function walk(node, parent) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(function (n) { walk(n, parent); }); return; }
    if (classes(node).indexOf(cls) >= 0) out.push({ node: node, parent: parent });
    (node.children || []).forEach(function (c) { walk(c, node); });
  })(tree, null);
  return out;
}

function assertWrapped(tree, where) {
  const controls = findWithParent(tree, 'fs-field__control')
    .filter(function (x) { return classes(x.node).indexOf('fs-srm__window-time') < 0; });
  assert.ok(controls.length, where + ': expected at least one field control');
  controls.forEach(function (x) {
    assert.ok(classes(x.parent).indexOf('fs-field__control-wrap') >= 0,
      where + ': a <' + x.node.type + '> sits in "' + classes(x.parent).join(' ').trim()
      + '" instead of .fs-field__control-wrap -- in a column it renders 18px tall');
  });
  return controls.length;
}

/* ---- THE test -------------------------------------------------------------- */

test('THE test: every labelled control in the fill step is inside a wrap', () => {
  const tree = expand(createElement(M.FillStep, {
    form: { title: 'x', attendees: ['Ben'], fields: {} },
    setForm: function () {},
    onChooseTemplate: function () {},
  }));
  // template select + title + attendees + weather + sign-off
  assert.strictEqual(assertWrapped(tree, 'FillStep'), 5);
});

test('the recipients box is wrapped too, when email is chosen', () => {
  const tree = expand(createElement(M.DeliveryChooser, {
    deliver: 'email', onDeliver: function () {},
    recipientsText: '', onRecipients: function () {},
  }));
  assert.strictEqual(assertWrapped(tree, 'DeliveryChooser'), 1);
});

test('the template select, rendered alone, is wrapped', () => {
  const tree = expand(createElement(M.TemplateChooser, { templateId: null, onChoose: function () {} }));
  assert.strictEqual(assertWrapped(tree, 'TemplateChooser'), 1);
});

/* ---- that the stub is not flattering the check --------------------------- */

test('the check fails on an unwrapped control', () => {
  /* A structural test that could not fail would be decoration. This is the
     shape the dialog had: the control straight inside the labelled field. */
  const bare = createElement('label', { className: 'fs-field fs-field--md' },
    createElement('span', { className: 'fs-field__label' }, 'Title'),
    createElement('input', { className: 'fs-field__control' }));
  assert.throws(function () { assertWrapped(bare, 'bare'); }, /instead of .fs-field__control-wrap/);
});
