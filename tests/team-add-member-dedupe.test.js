'use strict';

/*
 * "Add member" on the Team page. POST /members is idempotent on the email, so
 * re-adding someone already listed returns that same person; the list must
 * show them once (prod, 2026-10-28: Blair Collie appeared twice until reload).
 * The page is a browser IIFE with no export, so its wiring is pinned by source
 * and the behaviour is asserted on the api helper it calls.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function loadOrg() {
  global.window = { FieldSight: { fixtures: {} }, FS: { api: { useMocks: true } } };
  delete require.cache[require.resolve('../scripts/api/org.js')];
  require('../scripts/api/org.js');
  return global.window.FS.api.org;
}

test('re-adding a listed person replaces their row instead of adding a second one', () => {
  const org = loadOrg();
  const before = [{ device_id: 'a', name: 'Ann' }, { device_id: 'b', name: 'Blair', archived: true }];
  const after = org.withAddedMember(before, { device_id: 'b', name: 'Blair' });
  assert.strictEqual(after.length, 2);
  assert.deepStrictEqual(after.map((u) => u.device_id), ['a', 'b']);
  assert.strictEqual(after[1].archived, undefined, 'the returned record wins');
});

test('a new person is put at the top', () => {
  const org = loadOrg();
  const after = org.withAddedMember([{ device_id: 'a' }], { device_id: 'c' });
  assert.deepStrictEqual(after.map((u) => u.device_id), ['c', 'a']);
});

test('copes with an empty list and a missing user', () => {
  const org = loadOrg();
  assert.deepStrictEqual(org.withAddedMember(null, { device_id: 'c' }).map((u) => u.device_id), ['c']);
  assert.deepStrictEqual(org.withAddedMember([{ device_id: 'a' }], null), [{ device_id: 'a' }]);
});

test('the Team page adds through the helper and labels the sub "User ID"', () => {
  const src = fs.readFileSync(path.join(__dirname, '../scripts/pages/team.js'), 'utf8');
  const add = src.slice(src.indexOf('function addUser('), src.indexOf('function removeUser('));
  assert.match(add, /org\.withAddedMember\(s\.users, user\)/);
  assert.doesNotMatch(add, /\[user\]\.concat/);
  assert.match(src, /'User ID'\)/);
  assert.doesNotMatch(src, /'Device ID'\)/);
});
