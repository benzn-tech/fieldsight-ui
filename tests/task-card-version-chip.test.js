'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

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

/* SOURCE SCAN (final review fix 1). The chip is rendered with
   className: 'fs-task-card__version' on top of tone:'neutral'
   variant:'outline', so it inherits `.fs-badge--outline.fs-badge--neutral`
   from styles/components.css. That base rule's `color` is
   `--color-neutral-600` — a palette-scale token that does NOT flip in dark
   mode (~2.3:1 on --surface-panel there). The chip must instead resolve its
   foreground from a scoped rule using a semantic token (e.g. --text-*),
   which DOES flip, without touching any other outline/neutral badge. */
const componentsCss = fs.readFileSync(
  path.join(__dirname, '..', 'styles', 'components.css'), 'utf8'
).replace(/\r\n/g, '\n');

function ruleBodyFor(css, selectorRe) {
  const m = selectorRe.exec(css);
  if (!m) return null;
  const braceStart = css.indexOf('{', m.index);
  const braceEnd = css.indexOf('}', braceStart);
  return css.slice(braceStart + 1, braceEnd);
}

test('the base outline/neutral badge rule keeps its palette-scale color (other badges untouched)', () => {
  const body = ruleBodyFor(componentsCss, /\.fs-badge--outline\.fs-badge--neutral\s*\{/);
  assert.ok(body, 'expected the base .fs-badge--outline.fs-badge--neutral rule to still exist');
  assert.match(body, /color:\s*var\(--color-neutral-600\)/);
});

test('fs-task-card__version overrides the chip foreground with a semantic (theme-flipping) token', () => {
  const matches = componentsCss.match(/[^{}]*\.fs-task-card__version[^{}]*\{[^}]*\}/g) || [];
  assert.ok(matches.length > 0, 'expected a CSS rule scoped to .fs-task-card__version');

  const hasSemanticColor = matches.some((rule) => /color:\s*var\(--text-[a-z-]+\)/.test(rule));
  assert.ok(hasSemanticColor, 'expected .fs-task-card__version to set color from a --text-* semantic token');

  const usesNeutralScaleForeground = matches.some((rule) => {
    // Strip out non-color declarations (e.g. box-shadow using --border-default
    // or a --color-neutral-* dot) before checking for a palette-scale `color:`.
    const colorDecls = rule.match(/color:\s*[^;]+;?/g) || [];
    return colorDecls.some((d) => /--color-neutral-\d+/.test(d));
  });
  assert.strictEqual(usesNeutralScaleForeground, false,
    'the version chip must not use a --color-neutral-* token as its foreground color');
});
