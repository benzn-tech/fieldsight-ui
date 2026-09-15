'use strict';
const test = require('node:test');
const assert = require('node:assert');

function Card() {} Card.Body = function CardBody() {};
function Badge() {} function Avatar() {}
global.window = { FieldSight: { Card, Badge, Avatar }, FS: {} };
global.document = { getElementById: () => null };
global.React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (v) => [v, () => {}],
};
const { versionChipFor, TaskCard } = require('../scripts/composites/task-card.js');

test('no chip for missing or v1', () => {
  assert.strictEqual(versionChipFor(undefined), null);
  assert.strictEqual(versionChipFor({}), null);
  assert.strictEqual(versionChipFor({ version: 1 }), null);
});

test('v2: singular copy', () => {
  assert.deepStrictEqual(versionChipFor({ version: 2 }), {
    text: 'v2',
    title: 'Edited 1 time — open to see history',
    ariaLabel: 'Version 2, edited 1 time',
  });
});

test('v3: plural copy', () => {
  const c = versionChipFor({ version: 3 });
  assert.strictEqual(c.title, 'Edited 2 times — open to see history');
  assert.strictEqual(c.ariaLabel, 'Version 3, edited 2 times');
});

function find(node, pred) {
  if (!node || typeof node !== 'object') return null;
  if (pred(node)) return node;
  for (const c of node.children || []) { const r = find(c, pred); if (r) return r; }
  return null;
}
const titleOf = (task) => find(TaskCard({ task }), (n) => n.props && n.props.className === 'fs-task-card__title');

test('chip renders inside the title, before the text, as a quiet neutral outline sm Badge', () => {
  const title = titleOf({ id: 't', title: 'Roofing price', version: 2, status: 'Open', statusTone: 'info' });
  const chip = title.children[0];
  assert.strictEqual(chip.type, Badge);
  assert.deepStrictEqual([chip.props.tone, chip.props.variant, chip.props.size], ['neutral', 'outline', 'sm']);
  assert.strictEqual(chip.props['aria-label'], 'Version 2, edited 1 time');
  assert.deepStrictEqual(chip.children, ['v2']);
  assert.strictEqual(title.children[title.children.length - 1], 'Roofing price');
  assert.strictEqual(chip.props.onClick, undefined, 'no separate handler: the card click opens the panel');
});

test('v1 title renders the text alone', () => {
  assert.deepStrictEqual(titleOf({ id: 't', title: 'Light poles', version: 1 }).children.filter(Boolean), ['Light poles']);
});
