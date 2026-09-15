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

/* ---- 9: SOURCE SCAN (wiring pin), not a behaviour test --------------------
   The four field-editor save sites each call settleSave(; Today's title
   editor mounts timeline.js's EditableText and must NOT add its own call
   (that would double the toast). */
const fs = require('node:fs');
const path = require('node:path');
const page = (f) => fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pages', f), 'utf8').replace(/\r\n/g, '\n');

function block(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  assert.ok(s >= 0, 'marker not found: ' + startMarker);
  const e = src.indexOf(endMarker, s + startMarker.length);
  assert.ok(e > s, 'end marker not found after: ' + startMarker);
  return src.slice(s, e);
}

test('9: timeline EditableText.commit calls settleSave before the glossary early return', () => {
  const b = block(page('timeline.js'), 'function EditableText(', 'function cancel()');
  const call = b.indexOf('settleSave(');
  assert.ok(call > 0);
  assert.ok(call < b.indexOf('props.showGlossaryConfirm && res.candidates'));
});

test('9: timeline assignTo calls settleSave', () => {
  assert.match(block(page('timeline.js'), 'function assignTo(', 'var rosterRef'), /settleSave\(/);
});

test('9: today commitTaskField calls settleSave', () => {
  assert.match(block(page('today.js'), 'function commitTaskField(', 'var fieldsEditable'), /settleSave\(/);
});

test('9: tasks commitRowField calls settleSave', () => {
  assert.match(block(page('tasks.js'), 'function commitRowField(', '\n    }\n'), /settleSave\(/);
});

test('9: today title editor block does not call settleSave', () => {
  const b = block(page('today.js'), 'feat/today-title-edit — mounts window.FieldSight.EditableText', "item.kind === 'urgent'");
  assert.doesNotMatch(b, /settleSave\(/);
});

test('9: exactly these four call sites exist in pages/', () => {
  const n = ['timeline.js', 'today.js', 'tasks.js']
    .map((f) => (page(f).match(/settleSave\(/g) || []).length)
    .reduce((a, b) => a + b, 0);
  assert.strictEqual(n, 4);
});
