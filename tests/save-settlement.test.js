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

/* subscribeContentReload is a pure function (events passed explicitly, not
   read off a module-scoped window), so it's safe to require timeline.js
   once here even though load() above reassigns global.window per-test. */
global.window = global.window || {};
global.React = global.React || {};
const { subscribeContentReload } = require('../scripts/pages/timeline.js');
const { createEvents } = require('../scripts/api/events.js');

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

/* ---- 10b: SOURCE SCAN (wiring pin) — ContentHistoryPanel re-fetches on a
   matching content:edited via subscribeContentReload. subscribeContentReload's
   own matching/callback behaviour is exercised behaviourally just below,
   driving the real FS.events (scripts/api/events.js createEvents). A source
   scan alone can't tell an emptied callback from a working one. */
test('10b: ContentHistoryPanel subscribes via subscribeContentReload and re-fetches on tick', () => {
  const src = page('timeline.js');
  const b = block(src, 'function ContentHistoryPanel(', 'function OverviewTab(');
  assert.match(b, /subscribeContentReload\(window\.FS && window\.FS\.events, props\.table, props\.id,/);
  assert.match(b, /\[props\.table, props\.id, reloadTick\]/);
});

test('10b: subscribeContentReload bumps on a matching content:edited emit', () => {
  const ev = createEvents();
  let calls = 0;
  subscribeContentReload(ev, 'action_items', 'ai-1', () => { calls++; });
  ev.emit('content:edited', { table: 'action_items', id: 'ai-1' });
  assert.strictEqual(calls, 1);
});

test('10b: subscribeContentReload does not bump on a different id', () => {
  const ev = createEvents();
  let calls = 0;
  subscribeContentReload(ev, 'action_items', 'ai-1', () => { calls++; });
  ev.emit('content:edited', { table: 'action_items', id: 'ai-2' });
  assert.strictEqual(calls, 0);
});

test('10b: subscribeContentReload does not bump on the same id but a different table', () => {
  const ev = createEvents();
  let calls = 0;
  subscribeContentReload(ev, 'action_items', 'ai-1', () => { calls++; });
  ev.emit('content:edited', { table: 'topics', id: 'ai-1' });
  assert.strictEqual(calls, 0);
});

test('10b: after off(), no more bumps', () => {
  const ev = createEvents();
  let calls = 0;
  const off = subscribeContentReload(ev, 'action_items', 'ai-1', () => { calls++; });
  off();
  ev.emit('content:edited', { table: 'action_items', id: 'ai-1' });
  assert.strictEqual(calls, 0);
});

test('10b: subscribeContentReload with no events does not throw and returns a callable unsubscribe', () => {
  let calls = 0;
  const off = subscribeContentReload(undefined, 'action_items', 'ai-1', () => { calls++; });
  assert.strictEqual(typeof off, 'function');
  assert.doesNotThrow(() => off());
  assert.strictEqual(calls, 0);
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
