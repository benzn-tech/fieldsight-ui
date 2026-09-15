'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

global.window = { FieldSight: {}, FS: { api: {} } };
global.React = {
  useState: (v) => [v, () => {}], useContext: () => null,
  createContext: (d) => ({ Provider: 'Provider', _def: d }), Fragment: 'Fragment',
};
global.document = { addEventListener() {}, removeEventListener() {} };
const { versionBumpFor, authoritativeVersionPatch } = require('../scripts/pages/today.js');

const DATA = {
  myTasks:   [{ id: '2026-09-03__Ben_UCPK2_action_0_0', actionItemId: 'ai-1', version: 2 }],
  teamTasks: [{ id: '2026-09-03__Ben_UCPK2_action_1_0', actionItemId: 'ai-2' }],
};

test('a matching content:edited bumps only that item, keyed by actionItemId', () => {
  assert.deepStrictEqual(versionBumpFor(DATA, { table: 'action_items', id: 'ai-1' }),
    { taskId: '2026-09-03__Ben_UCPK2_action_0_0', patch: { version: 3 } });
  assert.deepStrictEqual(versionBumpFor(DATA, { table: 'action_items', id: 'ai-2' }),
    { taskId: '2026-09-03__Ben_UCPK2_action_1_0', patch: { version: 2 } }, 'missing version counts as 1');
});

test('no bump for another table, an unknown id, the composite id, or no data', () => {
  assert.strictEqual(versionBumpFor(DATA, { table: 'topics', id: 'ai-1' }), null);
  assert.strictEqual(versionBumpFor(DATA, { table: 'action_items', id: 'ai-9' }), null);
  assert.strictEqual(versionBumpFor(DATA, { table: 'action_items', id: '2026-09-03__Ben_UCPK2_action_0_0' }), null);
  assert.strictEqual(versionBumpFor(null, { table: 'action_items', id: 'ai-1' }), null);
  assert.strictEqual(versionBumpFor(DATA, null), null);
});

test('history read is authoritative: patch only when it differs', () => {
  assert.deepStrictEqual(authoritativeVersionPatch({ version: 3 }, 2), { version: 2 }, 'optimistic bump ran one ahead');
  assert.strictEqual(authoritativeVersionPatch({ version: 2 }, 2), null);
  assert.strictEqual(authoritativeVersionPatch({}, 1), null);
  assert.strictEqual(authoritativeVersionPatch({ version: 2 }, undefined), null);
});

test('history read guard rejects NaN and null (final review fix 2)', () => {
  // `n < 1` alone let NaN through (typeof NaN === 'number', NaN < 1 is
  // false), which would have returned { version: NaN }.
  assert.strictEqual(authoritativeVersionPatch({ version: 2 }, NaN), null);
  assert.strictEqual(authoritativeVersionPatch({ version: 2 }, null), null);
  assert.strictEqual(authoritativeVersionPatch(null, 2), null);
});

/* SOURCE SCAN (wiring pins). */
const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'today.js'), 'utf8').replace(/\r\n/g, '\n');
test('useTodayState subscribes to content:edited and applies versionBumpFor via patchTask', () => {
  const b = src.slice(src.indexOf('function useTodayState('), src.indexOf('return { state: state, removeMyTask: removeMyTask, patchTask: patchTask };'));
  assert.match(b, /events\.on\('content:edited'/);
  assert.match(b, /versionBumpFor\(/);
  assert.match(b, /patchTask\(hit\.taskId, hit\.patch\)/);
});
test('TodayRightDetail mounts TodoHistory with the item and an onVersion correction', () => {
  const b = src.slice(src.indexOf('function TodayRightDetail('));
  assert.match(b, /React\.createElement\(fs\.TodoHistory, \{/);
  assert.match(b, /authoritativeVersionPatch\(item, n\)/);
});
