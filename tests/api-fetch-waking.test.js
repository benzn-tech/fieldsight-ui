'use strict';

/*
 * A cold backend is not a broken one.
 *
 * Aurora is configured to pause when idle (MinCapacity 0,
 * SecondsUntilAutoPause 600) but has never actually paused: the prod
 * finalize sweep connects every minute, so the cluster has sat at a measured
 * floor of 0.5 ACU for weeks. Turning that gate on is what makes it sleep --
 * and a resume after a long pause can outlast API Gateway's 29 s ceiling, so
 * the first request of a quiet Monday can fail while nothing is wrong.
 *
 * This is the safety net, and it ships BEFORE the cluster is allowed to
 * sleep. Reversed, the first person to meet a cold cluster is a real user.
 *
 * What is asserted here:
 *   - a run where EVERY attempt timed out, or every attempt was 502/503/504,
 *     throws with `waking: true` and shows the notice;
 *   - a run of 500s does NOT (that is an application fault, and dressing it
 *     as "please wait" would stop anyone reporting a real bug);
 *   - a failure that recovers inside the existing 1s/2s/4s ladder shows
 *     nothing at all -- the notice is for the exhausted case only;
 *   - the flag rides on the thrown error, NOT on a `{ _waking: true }`
 *     envelope: every caller on this path reaches a `catch` today, and an
 *     envelope would be silently consumed as data by all of them at once;
 *   - _fetch.js still works with no notice module loaded (previews, node).
 *
 * `_fetch.js` is a browser IIFE that registers onto window.FS.api at load, so
 * a minimal window stub is enough to require it under node -- same posture as
 * tests/checkoff-org-api.test.js loading actions.js for real.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

/* ---- harness ------------------------------------------------------------- */

/* The real ladder is 1s/2s/4s. Exercising the exhausted path at those delays
   costs 7 s per test, so every test passes `retryDelaysMs` -- the documented
   override that exists for exactly this. The ladder LENGTH is kept at 3 so the
   attempt count stays the shipped one. */
const FAST = [1, 1, 1];
/* The wake extension (8s/16s) is overridden for the same reason: a
   wake-shaped GET now runs SIX attempts, and at the shipped delays that is
   31 s of sleeping per case. */
const FAST_WAKE = [1, 1];
const OPTS = { allowAnon: true, retryDelaysMs: FAST, wakeExtraDelaysMs: FAST_WAKE };

let fetchCalls;

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

/* A fetch stub that replays a script of outcomes. Each entry is either a
   Response-ish object or an Error to throw. The stub is what stands in for
   the network, so "attempt 3 of 4" is observable rather than inferred. */
function scriptedFetch(outcomes) {
  let i = 0;
  return async function () {
    fetchCalls += 1;
    const outcome = outcomes[Math.min(i, outcomes.length - 1)];
    i += 1;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
}

/* fetchWithTimeout wraps our stub's rejection and re-labels it ONLY when its
   own timer fired. A stub that throws synchronously never trips that timer, so
   a TimeoutError thrown by the stub arrives at fetchWithRetry unchanged --
   which is the shape a real deadline produces, and what `err.timeout` keys
   off. */
function loadFetchModule() {
  global.window = global.window || {};
  window.FS = { api: {}, session: null };
  /* No FormData / AbortController stubs needed: node 18+ has both, and the
     tests send no body. */
  const p = path.join(__dirname, '..', 'scripts', 'api', '_fetch.js');
  delete require.cache[require.resolve(p)];
  require(p);
  return window.FS.api.request;
}

/* A DOM stub sufficient for waking-notice.js: it only ever does
   getElementById / createElement / appendChild / removeChild. */
function installDom() {
  const children = [];
  global.document = {
    body: {
      appendChild(el) { children.push(el); el.parentNode = global.document.body; },
      removeChild(el) {
        const i = children.indexOf(el);
        if (i !== -1) children.splice(i, 1);
      },
    },
    createElement() {
      return { style: { cssText: '' }, setAttribute() {}, textContent: '' };
    },
    getElementById(id) { return children.find((c) => c.id === id) || null; },
  };
  return children;
}

function loadNotice() {
  const p = path.join(__dirname, '..', 'scripts', 'composites', 'waking-notice.js');
  delete require.cache[require.resolve(p)];
  require(p);
  return window.FS.wakingNotice;
}

function setup(outcomes, { withNotice = true } = {}) {
  fetchCalls = 0;
  const request = loadFetchModule();
  const children = installDom();
  const notice = withNotice ? loadNotice() : null;
  global.fetch = scriptedFetch(outcomes);
  return { request, notice, children };
}

async function expectThrow(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected a rejection');
}

/* ---- the exhausted wake-shaped run -------------------------------------- */

test('a GET that only ever times out is reported as a waking backend', async () => {
  const { request, notice } = setup([timeoutError()]);
  const err = await expectThrow(() =>
    request('/timeline', OPTS));

  assert.equal(fetchCalls, 6,
    'a wake-shaped GET earns the two extra rungs on top of the 1/2/4 ladder');
  assert.equal(err.waking, true);
  assert.equal(notice.isShown(), true);
});

test('four 504s are reported as a waking backend', async () => {
  const { request, notice } = setup([jsonResponse(504, { message: 'Endpoint request timed out' })]);
  const err = await expectThrow(() =>
    request('/timeline', OPTS));

  assert.equal(err.waking, true);
  assert.equal(err.status, 504);
  assert.equal(notice.isShown(), true);
});

test('503 and 502 count too', async () => {
  for (const status of [502, 503]) {
    const { request } = setup([jsonResponse(status, {})]);
    const err = await expectThrow(() =>
      request('/timeline', OPTS));
    assert.equal(err.waking, true, `${status} should read as a wake`);
  }
});

/* ---- what must NOT be dressed up ---------------------------------------- */

test('a run of 500s stays a plain error', async () => {
  const { request, notice } = setup([jsonResponse(500, { error: 'boom' })]);
  const err = await expectThrow(() =>
    request('/timeline', OPTS));

  assert.equal(err.waking, undefined, 'a 500 is an application fault, not a cold start');
  assert.equal(err.message, 'boom', 'and it keeps the message the server sent');
  assert.equal(notice.isShown(), false);
});

test('a single non-wake failure falsifies the whole run', async () => {
  /* Two timeouts, then a 500: the backend answered, so it was up. Reporting
     this as a wake would hide the 500 behind "please wait". */
  const { request, notice } = setup([
    timeoutError(), timeoutError(), jsonResponse(500, { error: 'boom' }), jsonResponse(500, { error: 'boom' }),
  ]);
  const err = await expectThrow(() =>
    request('/timeline', OPTS));

  assert.equal(err.waking, undefined);
  assert.equal(notice.isShown(), false);
});

test('a network fault that is not our deadline is not a wake', async () => {
  /* DNS / CORS / offline do not get better by waiting, and telling someone to
     wait for one is advice that cannot work. */
  const { request, notice } = setup([new TypeError('Failed to fetch')]);
  const err = await expectThrow(() =>
    request('/timeline', OPTS));

  assert.equal(err.waking, undefined);
  assert.equal(notice.isShown(), false);
});

/* ---- recovery ------------------------------------------------------------ */

test('a 504 that recovers inside the ladder shows nothing', async () => {
  const { request, notice } = setup([
    jsonResponse(504, {}), jsonResponse(200, { ok: 1 }),
  ]);
  const body = await request('/timeline', OPTS);

  assert.deepEqual(body, { ok: 1 });
  assert.equal(fetchCalls, 2);
  assert.equal(notice.isShown(), false, 'the notice is for the exhausted case only');
});

test('the next answer retracts the notice, whatever its status', async () => {
  /* A 403 is an answer: the backend is up. The notice must not outlive it. */
  const { request, notice } = setup([jsonResponse(504, {})]);
  await expectThrow(() => request('/a', OPTS));
  assert.equal(notice.isShown(), true);

  global.fetch = scriptedFetch([jsonResponse(403, { error: 'nope' })]);
  const out = await request('/b', OPTS);
  assert.equal(out._accessDenied, true);
  assert.equal(notice.isShown(), false);
});

/* ---- the shape of the report -------------------------------------------- */

test('the verdict rides on the thrown error, never on a returned envelope', async () => {
  /* If this ever becomes `{ _waking: true }`, every existing caller's catch
     block stops running and the object flows on as if it were data. */
  const { request } = setup([jsonResponse(504, {})]);
  const err = await expectThrow(() =>
    request('/timeline', OPTS));

  assert.ok(err instanceof Error, 'must remain a thrown Error');
  assert.equal(err._waking, undefined, 'no envelope key');
});

/* ---- the notice is optional -------------------------------------------- */

test('_fetch works with no notice module loaded', async () => {
  const { request } = setup([jsonResponse(504, {})], { withNotice: false });
  const err = await expectThrow(() =>
    request('/timeline', OPTS));

  assert.equal(err.waking, true, 'still classified');
});

test('show() twice leaves one bar', async () => {
  setup([jsonResponse(200, {})]);
  const notice = window.FS.wakingNotice;
  notice.show();
  notice.show();
  notice.hide();
  assert.equal(notice.isShown(), false, 'one hide clears it, so one show created it');
});
