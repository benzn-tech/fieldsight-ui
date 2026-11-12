'use strict';

/*
 * Status pick cards (spec 2026-11-12 §4.3): one heard status, several tasks it
 * could belong to, and a person picks one. The API helpers:
 *
 *   listPickCards(siteId)        GET  /api/org/status-pick-cards?site=
 *   decidePickCard(id, body)     POST /api/org/status-pick-cards/{id}
 *
 * Both ALWAYS RESOLVE. orgRequest THROWS on a 409 (err.status) and RESOLVES
 * 403/404 as {_accessDenied}/{_notFound}; a bare .catch() would read a refusal
 * as success, the recurring bug in this codebase.
 */
const test = require('node:test');
const assert = require('node:assert');

const calls = [];
let reply = null;
global.window = {
  FieldSight: {},
  FS: {
    actionsBus: { emit() {} },
    api: {
      useMocks: false, writeMocks: false, timelineSource: 'aurora', orgBaseUrl: 'https://x',
      orgRequest: async function (path, opts) {
        calls.push({ path, opts });
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  },
};
require('../scripts/api/actions.js');
const actions = window.FS.api.actions;

function conflict(msg) { return Object.assign(new Error(msg), { status: 409 }); }

test('listPickCards reads the site as ?site= and resolves the cards', async () => {
  calls.length = 0;
  reply = { cards: [{ id: 'c1', candidates: [] }] };
  const env = await actions.listPickCards('site-1');
  assert.deepStrictEqual(env, { ok: true, cards: [{ id: 'c1', candidates: [] }] });
  assert.strictEqual(calls[0].path, '/status-pick-cards');
  assert.deepStrictEqual(calls[0].opts.params, { site: 'site-1' });
});

test('listPickCards without a site reads every reachable site', async () => {
  calls.length = 0;
  reply = { cards: [] };
  await actions.listPickCards(null);
  assert.strictEqual(calls[0].path, '/status-pick-cards');
  assert.ok(!calls[0].opts || !calls[0].opts.params || calls[0].opts.params.site === undefined);
});

test('listPickCards under mocks shows nothing and never calls the server', async () => {
  calls.length = 0;
  window.FS.api.useMocks = true;
  const env = await actions.listPickCards('s');
  window.FS.api.useMocks = false;
  assert.deepStrictEqual(env, { ok: true, cards: [] });
  assert.strictEqual(calls.length, 0);
});

test('decidePickCard sends only decision and stable_id', async () => {
  calls.length = 0;
  reply = { id: 'c 1', state: 'chosen', status: 'done', action_item_id: 'a1' };
  const env = await actions.decidePickCard('c 1', { decision: 'choose', stable_id: 'sid-1',
                                                    text: 'leak', status: 'done', extra: 1 });
  assert.deepStrictEqual(env, { ok: true, state: 'chosen', status: 'done', action_item_id: 'a1' });
  assert.strictEqual(calls[0].path, '/status-pick-cards/c%201');
  assert.strictEqual(calls[0].opts.method, 'POST');
  assert.deepStrictEqual(calls[0].opts.body, { decision: 'choose', stable_id: 'sid-1' });

  calls.length = 0;
  reply = { id: 'c2', state: 'none', status: 'done', action_item_id: null };
  await actions.decidePickCard('c2', { decision: 'none', stable_id: undefined });
  assert.deepStrictEqual(calls[0].opts.body, { decision: 'none' });
});

test('decidePickCard maps a thrown 409 to conflict', async () => {
  reply = conflict('card already decided');
  const env = await actions.decidePickCard('c1', { decision: 'choose', stable_id: 's' });
  assert.deepStrictEqual(env, { ok: false, reason: 'conflict', status: 409,
                                message: 'card already decided' });
  reply = conflict('item no longer open');
  assert.strictEqual((await actions.decidePickCard('c1', { decision: 'none' })).reason, 'conflict');
});

test('decidePickCard maps _notFound to not_found', async () => {
  reply = { _notFound: true, status: 404 };
  const env = await actions.decidePickCard('c1', { decision: 'none' });
  assert.strictEqual(env.ok, false);
  assert.strictEqual(env.reason, 'not_found');
});

test('decidePickCard maps a refusal or any other failure to error with a message', async () => {
  reply = { _accessDenied: true, status: 403, error: 'not allowed here' };
  let env = await actions.decidePickCard('c1', { decision: 'none' });
  assert.strictEqual(env.ok, false);
  assert.strictEqual(env.reason, 'error');
  assert.strictEqual(env.message, 'not allowed here');

  reply = Object.assign(new Error('boom'), { status: 500 });
  env = await actions.decidePickCard('c1', { decision: 'none' });
  assert.strictEqual(env.reason, 'error');
  assert.strictEqual(env.message, 'boom');
});

test('decidePickCard drops ticks on a successful choose', async () => {
  /* Seed this session's remembered tick for task a1 through the real writer. */
  reply = { id: 'a1', status: 'done', updated_by_name: 'Ben', updated_at: 'T' };
  const seeded = await actions.resolveActionItem({ actionItemId: 'a1', date: 'D', topic_id: 1,
                                                    action_index: 0, checked: true });
  assert.strictEqual(seeded.ok, true);
  assert.strictEqual(Object.values(actions.ticksFor('D'))[0].actionItemId, 'a1');

  reply = { id: 'c1', state: 'chosen', status: 'blocked', action_item_id: 'a1' };
  const env = await actions.decidePickCard('c1', { decision: 'choose', stable_id: 's' });
  assert.strictEqual(env.ok, true);
  assert.deepStrictEqual(actions.ticksFor('D'), {});
});
