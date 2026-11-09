'use strict';

/*
 * Action pack page: the poller (spec 2026-11-10-action-pack-page-design.md §6.2).
 * A chained timer -- the next GET is scheduled only after the previous one settled --
 * that stops on a final state, on an orgRequest envelope, and on stop().
 */
const test = require('node:test');
const assert = require('node:assert');

const flush = () => new Promise((r) => setImmediate(r));

function loadPage() {
  global.window = global.window || {};
  global.window.FieldSight = global.window.FieldSight || {};
  delete require.cache[require.resolve('../scripts/pages/action-packs.js')];
  return require('../scripts/pages/action-packs.js');
}

const { createPoller } = loadPage();

function harness(answers, opts) {
  opts = opts || {};
  const timers = [];
  const seen = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let fetches = 0;
  const resolvers = [];
  const poller = createPoller({
    fetch: () => {
      fetches++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const a = answers[Math.min(fetches - 1, answers.length - 1)];
      if (opts.manual) {
        return new Promise((res, rej) => resolvers.push(() => { inFlight--; a instanceof Error ? rej(a) : res(a); }));
      }
      inFlight--;
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    },
    onData: (r) => seen.push(r),
    isDone: (res) => ['ready', 'failed', 'cancelled'].includes(res && res.state),
    delay: { visible: 4000, hidden: 15000 },
    visibility: opts.visibility || (() => 'visible'),
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; },
  });
  const fire = async () => {
    const t = timers.filter((x) => !x.cleared && !x.fired).pop();
    if (!t) return false;
    t.fired = true;
    t.fn();
    await flush();
    return true;
  };
  return { poller, timers, seen, fire, resolvers, get fetches() { return fetches; }, get maxInFlight() { return maxInFlight; } };
}

test('no second fetch starts before the first settles', async () => {
  const h = harness([{ state: 'running' }, { state: 'running' }], { manual: true });
  h.poller.start();
  await flush();
  h.poller.kick();
  h.poller.kick();
  await flush();
  assert.strictEqual(h.fetches, 1, 'kick while in flight does nothing');
  assert.strictEqual(h.timers.length, 0, 'nothing is scheduled while a fetch is in flight');
  h.resolvers[0]();
  await flush();
  assert.strictEqual(h.timers.length, 1);
  assert.strictEqual(h.timers[0].ms, 4000);
  assert.strictEqual(h.maxInFlight, 1);
});

test('stops when isDone is true', async () => {
  const h = harness([{ state: 'running' }, { state: 'ready' }]);
  h.poller.start();
  await flush();
  assert.ok(await h.fire());
  assert.strictEqual(h.fetches, 2);
  assert.strictEqual(h.seen[1].res.state, 'ready');
  assert.strictEqual(await h.fire(), false, 'no timer after a final state');
});

test('stops on a _notFound or _accessDenied envelope', async () => {
  for (const env of [{ _notFound: true, status: 404 }, { _notFound: true, status: 502 }, { _accessDenied: true, status: 403 }]) {
    const h = harness([env]);
    h.poller.start();
    await flush();
    assert.strictEqual(h.seen.length, 1);
    assert.strictEqual(h.timers.length, 0);
  }
});

test('uses the hidden delay while hidden', async () => {
  let vis = 'hidden';
  const h = harness([{ state: 'running' }], { visibility: () => vis });
  h.poller.start();
  await flush();
  assert.strictEqual(h.timers[0].ms, 15000);
  vis = 'visible';
  h.poller.kick();
  await flush();
  assert.ok(h.timers[0].cleared, 'a kick replaces the pending tick');
  assert.strictEqual(h.fetches, 2);
  assert.strictEqual(h.timers[1].ms, 4000);
});

test('a thrown fetch keeps polling', async () => {
  const h = harness([new Error('Failed to fetch'), { state: 'ready' }]);
  h.poller.start();
  await flush();
  assert.ok(h.seen[0].err);
  assert.strictEqual(h.timers.length, 1);
  await h.fire();
  assert.strictEqual(h.seen[1].res.state, 'ready');
});

test('stop cancels the next tick and drops a late response', async () => {
  const h = harness([{ state: 'running' }], { manual: true });
  h.poller.start();
  await flush();
  h.poller.stop();
  h.resolvers[0]();
  await flush();
  assert.strictEqual(h.seen.length, 0, 'a response after stop() is dropped');
  assert.strictEqual(h.timers.length, 0);
  const h2 = harness([{ state: 'running' }]);
  h2.poller.start();
  await flush();
  h2.poller.stop();
  assert.ok(h2.timers[0].cleared);
});
