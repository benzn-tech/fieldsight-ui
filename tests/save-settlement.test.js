'use strict';
const test = require('node:test');
const assert = require('node:assert');

let toasts, emits;
function load() {
  toasts = []; emits = [];
  global.window = {
    FieldSight: { fixtures: { actions: {} } },
    FS: {
      api: { useMocks: true, writeMocks: true, delay: () => Promise.resolve() },
      toast:  { show: (t) => toasts.push(t) },
      events: { emit: (name, p) => emits.push({ name, p }) },
    },
  };
  delete require.cache[require.resolve('../scripts/api/actions.js')];
  return require('../scripts/api/actions.js');
}

const TARGET = { table: 'action_items', id: 'ai-1' };

test('8a: a resolved row settles ok, one Saved toast, one content:edited', () => {
  const { settleSave } = load();
  assert.deepStrictEqual(settleSave({ id: 'ai-1', deadline: '2026-09-19' }, TARGET), { ok: true });
  assert.deepStrictEqual(toasts, [{ message: 'Saved', tone: 'success', duration: 2000 }]);
  assert.deepStrictEqual(emits, [{ name: 'content:edited', p: { table: 'action_items', id: 'ai-1' } }]);
});

for (const [label, res] of [
  ['_accessDenied',              { _accessDenied: true }],
  ['_notFound',                  { _notFound: true }],
  ['{error}',                    { error: 'bad' }],
  ['undefined',                  undefined],
  ['_accessDenied + error (403)', { _accessDenied: true, error: 'nope' }],
]) {
  test('8b: ' + label + ' settles not ok, no toast, no emit', () => {
    const { settleSave } = load();
    assert.deepStrictEqual(settleSave(res, TARGET), { ok: false });
    assert.strictEqual(toasts.length, 0);
    assert.strictEqual(emits.length, 0);
  });
}

test('8c: settleSave works when toast and events are not loaded', () => {
  const { settleSave } = load();
  delete window.FS.toast; delete window.FS.events;
  assert.deepStrictEqual(settleSave({ row: {} }, TARGET), { ok: true });
});
