'use strict';
const test = require('node:test');
const assert = require('node:assert');

global.window = { FS: {} };
const { createEvents } = require('../scripts/api/events.js');

test('require registers window.FS.events', () => {
  assert.strictEqual(typeof window.FS.events.on, 'function');
  assert.strictEqual(typeof window.FS.events.emit, 'function');
});

test('on/emit delivers payloads by name, off unsubscribes', () => {
  const ev = createEvents();
  const got = [];
  const off = ev.on('a', (p) => got.push(p));
  ev.on('b', () => got.push('wrong'));
  ev.emit('a', 1);
  off();
  ev.emit('a', 2);
  assert.deepStrictEqual(got, [1]);
});

test('a throwing subscriber does not stop the others', () => {
  const ev = createEvents();
  const got = [];
  const origError = console.error; console.error = () => {};
  ev.on('a', () => { throw new Error('x'); });
  ev.on('a', (p) => got.push(p));
  ev.emit('a', 'ok');
  console.error = origError;
  assert.deepStrictEqual(got, ['ok']);
});

test('onContentEdited fires only for the same table and id', () => {
  const ev = createEvents();
  let n = 0;
  ev.onContentEdited('action_items', 'ai-1', () => { n++; });
  ev.emit('content:edited', { table: 'action_items', id: 'ai-1' });
  ev.emit('content:edited', { table: 'action_items', id: 'ai-2' });
  ev.emit('content:edited', { table: 'topics', id: 'ai-1' });
  ev.emit('content:edited', null);
  assert.strictEqual(n, 1);
});
