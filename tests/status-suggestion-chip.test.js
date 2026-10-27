'use strict';

/*
 * Status suggestions from speech (backend spec 2026-10-27). The read payload
 * carries `status_suggestion {id, status, quote}` on an action item; a person
 * accepts or dismisses it via POST /action-items/{id}/status-suggestion.
 *
 * decideStatusSuggestion must ALWAYS RESOLVE a normalised envelope — org
 * writes RESOLVE 403/404 as {_accessDenied}/{_notFound}, and a bare .catch()
 * would read a refusal as success (the recurring bug in this codebase).
 */
const test = require('node:test');
const assert = require('node:assert');

const calls = [];
let reply = { state: 'accepted', status: 'done' };
global.window = {
  FieldSight: {},
  FS: {
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

global.React = { useState: (v) => [v, () => {}], useRef: (v) => ({ current: v }),
                 useEffect() {}, createElement() { return null; } };
global.document = { getElementById() { return null; } };
const { suggestionLabel } = require('../scripts/composites/action-item-row.js');

test('accept posts the decision to the item and resolves ok', async () => {
  calls.length = 0;
  reply = { suggestion_id: 's1', state: 'accepted', status: 'done' };
  const env = await actions.decideStatusSuggestion('a 1', 's1', 'accept');
  assert.deepStrictEqual(env, { ok: true, state: 'accepted', status: 'done' });
  assert.strictEqual(calls[0].path, '/action-items/a%201/status-suggestion');
  assert.deepStrictEqual(calls[0].opts, { method: 'POST',
                                          body: { suggestion_id: 's1', decision: 'accept' } });
});

test('a refusal or a gone suggestion resolves not-ok with a reason', async () => {
  reply = { _accessDenied: true };
  assert.strictEqual((await actions.decideStatusSuggestion('a', 's', 'dismiss')).reason, 'denied');
  reply = { _notFound: true };
  assert.strictEqual((await actions.decideStatusSuggestion('a', 's', 'dismiss')).reason, 'not_found');
  reply = new Error('409 already decided');
  const env = await actions.decideStatusSuggestion('a', 's', 'dismiss');
  assert.strictEqual(env.ok, false);
  assert.strictEqual(env.reason, 'error');
});

test('no ids or no live org write path never calls the server', async () => {
  calls.length = 0;
  assert.strictEqual((await actions.decideStatusSuggestion(null, 's', 'accept')).reason, 'no_id');
  window.FS.api.useMocks = true;
  assert.strictEqual((await actions.decideStatusSuggestion('a', 's', 'accept')).reason, 'unavailable');
  window.FS.api.useMocks = false;
  assert.strictEqual(calls.length, 0);
});

test('chip labels: closed reads as not needed, unknown renders nothing', () => {
  assert.strictEqual(suggestionLabel({ status: 'done' }), 'Done');
  assert.strictEqual(suggestionLabel({ status: 'closed' }), 'Closed (not needed)');
  assert.strictEqual(suggestionLabel({ status: 'finished' }), null);
  assert.strictEqual(suggestionLabel(null), null);
});
