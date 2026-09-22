'use strict';

/*
 * A timed-out write is not sent again.
 *
 * `fetchWithRetry` retried EVERY method on 5xx and transport faults unless the
 * caller passed `retry: false` — and only `/ask` ever did. But a 504 means the
 * GATEWAY stopped waiting; it is not a statement that the Lambda stopped
 * working. So a POST that hit API Gateway's 29 s ceiling was re-sent up to
 * four times, and each of those four could complete on the backend.
 *
 * That is a defect today. It becomes a fleet-wide one the morning after the
 * Aurora gate is turned on, because a resume after a long pause is precisely
 * the thing that produces a wave of gateway timeouts at once
 * (docs/superpowers/plans/2026-09-22-let-the-database-sleep.md, step 2).
 *
 * The rule: a GET may be repeated freely and, when every failure looks like a
 * resume, earns two extra rungs (8s/16s) so a deep resume is covered. Anything
 * else stops at the FIRST wake-shaped failure and surfaces `waking: true`, so
 * the caller can re-enable its control and let the person decide. "Try again"
 * offered to a human beats a retry the client guessed at.
 *
 * What is NOT changed here, deliberately: a non-GET still retries an ordinary
 * 500. That is the pre-existing behaviour, it is a different risk from the one
 * the sleeping cluster creates, and widening the blast radius of this change
 * to cover it would make it harder to review, not safer. Stated so the
 * remaining exposure is on the record rather than assumed away.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const FAST = [1, 1, 1];
const FAST_WAKE = [1, 1];

let fetchCalls;
let seenMethods;

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'application/json' },
    json: async () => body,
  };
}

function timeoutError() {
  const e = new Error('The request timed out after 10s.');
  e.name = 'TimeoutError';
  e.timeout = true;
  return e;
}

function scriptedFetch(outcomes) {
  let i = 0;
  return async function (url, opts) {
    fetchCalls += 1;
    seenMethods.push((opts && opts.method) || 'GET');
    const outcome = outcomes[Math.min(i, outcomes.length - 1)];
    i += 1;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
}

function setup(outcomes) {
  fetchCalls = 0;
  seenMethods = [];
  global.window = global.window || {};
  window.FS = { api: {}, session: null };
  const p = path.join(__dirname, '..', 'scripts', 'api', '_fetch.js');
  delete require.cache[require.resolve(p)];
  require(p);
  global.fetch = scriptedFetch(outcomes);
  return window.FS.api.request;
}

function opts(extra) {
  return Object.assign(
    { allowAnon: true, retryDelaysMs: FAST, wakeExtraDelaysMs: FAST_WAKE },
    extra || {});
}

async function expectThrow(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected a rejection');
}

/* ---- the write path ------------------------------------------------------ */

test('a POST that times out is sent exactly once', async () => {
  const request = setup([timeoutError()]);
  const err = await expectThrow(() =>
    request('/action-items', opts({ method: 'POST', body: { text: 'x' } })));

  assert.equal(fetchCalls, 1, 'the second send is the one that duplicates the row');
  assert.equal(err.waking, true, 'and the caller is told WHY, so it can offer a retry');
});

test('a POST that meets a 504 is sent exactly once', async () => {
  const request = setup([jsonResponse(504, { message: 'Endpoint request timed out' })]);
  const err = await expectThrow(() =>
    request('/action-items', opts({ method: 'POST', body: { text: 'x' } })));

  assert.equal(fetchCalls, 1);
  assert.equal(err.waking, true);
  assert.equal(err.status, 504);
});

test('PATCH and DELETE are writes too', async () => {
  for (const method of ['PATCH', 'DELETE', 'PUT']) {
    const request = setup([jsonResponse(503, {})]);
    await expectThrow(() => request('/x', opts({ method })));
    assert.equal(fetchCalls, 1, `${method} must not be repeated on a wake`);
  }
});

test('a write may opt back in when its endpoint really is idempotent', async () => {
  const request = setup([timeoutError()]);
  await expectThrow(() =>
    request('/idempotent', opts({ method: 'PUT', retry: true })));

  assert.equal(fetchCalls, 6, 'retry:true buys the same budget a GET gets');
  assert.deepEqual(new Set(seenMethods), new Set(['PUT']));
});

test('a write still retries an ordinary 500 — unchanged, and on the record', async () => {
  const request = setup([jsonResponse(500, { error: 'boom' })]);
  const err = await expectThrow(() => request('/x', opts({ method: 'POST' })));

  assert.equal(fetchCalls, 4, 'pre-existing behaviour, deliberately left alone');
  assert.equal(err.waking, undefined);
});

test('a write that recovers before any wake-shaped failure is unaffected', async () => {
  /* The stop rule keys off the FAILURE, not off the method: a POST whose first
     attempt succeeds never reaches any of this. */
  const request = setup([jsonResponse(201, { id: 7 })]);
  const body = await request('/x', opts({ method: 'POST' }));

  assert.deepEqual(body, { id: 7 });
  assert.equal(fetchCalls, 1);
});

/* ---- the read path keeps its budget, and gains two rungs ----------------- */

test('a wake-shaped GET runs six attempts, not four', async () => {
  const request = setup([jsonResponse(504, {})]);
  await expectThrow(() => request('/timeline', opts()));

  assert.equal(fetchCalls, 6,
    '1/2/4 plus the 8/16 rungs — ~75s of coverage for a deep resume');
});

test('an ordinary 5xx GET keeps the four-attempt budget', async () => {
  /* A broken endpoint must not take 75 s to say so. */
  const request = setup([jsonResponse(500, { error: 'boom' })]);
  await expectThrow(() => request('/timeline', opts()));

  assert.equal(fetchCalls, 4);
});

test('a GET that stops looking like a wake loses the extra rungs', async () => {
  /* Two timeouts then 500s: the backend answered, so it was up. */
  const request = setup([
    timeoutError(), timeoutError(),
    jsonResponse(500, { error: 'boom' }), jsonResponse(500, { error: 'boom' }),
  ]);
  await expectThrow(() => request('/timeline', opts()));

  assert.equal(fetchCalls, 4, 'falsified mid-run, so the budget falls back');
});

test('retry:false still means exactly one attempt, for any method', async () => {
  for (const method of ['GET', 'POST']) {
    const request = setup([timeoutError()]);
    await expectThrow(() => request('/ask', opts({ method, retry: false })));
    assert.equal(fetchCalls, 1, `${method} with retry:false`);
  }
});

test('a GET recovering inside the base ladder does not reach the extra rungs', async () => {
  const request = setup([jsonResponse(504, {}), jsonResponse(200, { ok: 1 })]);
  const body = await request('/timeline', opts());

  assert.deepEqual(body, { ok: 1 });
  assert.equal(fetchCalls, 2);
});
