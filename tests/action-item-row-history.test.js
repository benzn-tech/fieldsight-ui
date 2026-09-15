'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

global.window = { FieldSight: {}, FS: {} };
global.React = { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) };
const { historyEnabled } = require('../scripts/composites/action-item-row.js');

test('historyEnabled needs both the host flag and a durable id', () => {
  assert.strictEqual(historyEnabled({ withHistory: true, action: { id: 'ai-1' } }), true);
  assert.strictEqual(historyEnabled({ withHistory: true, action: {} }), false, 'legacy row');
  assert.strictEqual(historyEnabled({ action: { id: 'ai-1' } }), false, 'host did not ask');
  assert.strictEqual(historyEnabled({}), false);
});

/* SOURCE SCAN (wiring pin). */
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'scripts', ...p), 'utf8').replace(/\r\n/g, '\n');

test('OverviewTab mount passes withHistory and the topic session props', () => {
  const src = read('pages', 'timeline.js');
  const s = src.indexOf('React.createElement(ActionItemRow, {', src.indexOf('function OverviewTab('));
  const b = src.slice(s, src.indexOf('}),', s));
  assert.match(b, /withHistory:\s*true/);
  assert.match(b, /sessionId:\s*topic\.session_id/);
  assert.match(b, /sessionKind:\s*topic\.session_kind/);
});

test('topic-card mount does not opt in', () => {
  assert.doesNotMatch(read('composites', 'topic-card.js'), /withHistory/);
});

test('history renders outside the label and the toggle blocks label activation', () => {
  const src = read('composites', 'action-item-row.js');
  assert.match(src, /'fs-action-item-row-wrap'/);
  const t = src.slice(src.indexOf('fs-action-item-row__history-toggle'));
  assert.match(t.slice(0, 600), /preventDefault\(\)/);
});
