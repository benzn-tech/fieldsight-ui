'use strict';

/*
 * Ask as an async turn, behind FS_ASK_ASYNC (ask orchestration v2, phase 1,
 * task 4).
 *
 * With the flag off the request must be exactly today's single POST /ask.
 * With it on: POST /ask/start, poll GET /ask/result until done, and resolve
 * the same object /ask resolved to. The ONLY fallback to /ask is a start that
 * comes back _notFound (a backend without the route); a 404 on /ask/result
 * means the turn is gone, and falling back there would run the question twice.
 *
 * ask.js is a browser IIFE that registers onto window.FS.api at load, so a
 * window stub with a scripted request() is enough to drive it under Node.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/* `script` maps a path to a function (opts, callIndex) -> response, or to an
   array of responses served in order. */
function loadAsk(flag, script) {
  const seen = [];
  const counts = {};
  global.window = {
    FS: {
      api: {
        useMocks: false,
        askAsync: flag,
        orgBaseUrl: 'https://org.example/prod/api',
        request: function (p, opts) {
          seen.push({ path: p, opts: opts });
          counts[p] = (counts[p] || 0) + 1;
          const s = script[p];
          if (!s) return Promise.reject(new Error('unexpected request ' + p));
          const r = Array.isArray(s) ? s[counts[p] - 1] : s(opts, counts[p]);
          return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
        },
        delay: function () { return Promise.resolve(); },
      },
    },
  };
  delete require.cache[require.resolve('../scripts/api/ask.js')];
  require('../scripts/api/ask.js');
  return { ask: global.window.FS.api.ask.ask, seen: seen };
}

const ANSWER = { answer: 'You poured the slab.', citations: [{ n: 1 }], basis: { x: 1 } };

test('flag off: one POST /ask, nothing else, even with hooks passed', async () => {
  const { ask, seen } = loadAsk(false, { '/ask': [ANSWER] });
  const progress = [];
  const res = await ask({ question: 'q', tz: null },
                        { onProgress: function (s) { progress.push(s); }, isStale: function () { return false; } });
  assert.deepStrictEqual(res, ANSWER);
  assert.deepStrictEqual(seen.map(function (s) { return s.path; }), ['/ask']);
  assert.strictEqual(seen[0].opts.method, 'POST');
  assert.strictEqual(seen[0].opts.retry, false);
  assert.strictEqual(seen[0].opts.timeoutMs, 35000);
  assert.strictEqual(seen[0].opts.baseUrl, 'https://org.example/prod/api');
  assert.deepStrictEqual(progress, []);
});

test('flag on: start, poll through progress, resolve the done result', async () => {
  const { ask, seen } = loadAsk(true, {
    '/ask/start': [{ turn_id: 'abc' }],
    '/ask/result': [
      { status: 'pending' },
      { status: 'searching_web' },
      { status: 'done', result: ANSWER },
    ],
  });
  const progress = [];
  const res = await ask({ question: 'q', tz: null, site_id: 's1' },
                        { onProgress: function (s) { progress.push(s); } });
  assert.deepStrictEqual(res, ANSWER);

  const start = seen[0];
  assert.strictEqual(start.path, '/ask/start');
  assert.strictEqual(start.opts.method, 'POST');
  assert.strictEqual(start.opts.baseUrl, 'https://org.example/prod/api');
  assert.strictEqual(start.opts.body.question, 'q');
  assert.strictEqual(start.opts.body.site_id, 's1');
  assert.strictEqual(start.opts.retry, false);

  const polls = seen.filter(function (s) { return s.path === '/ask/result'; });
  assert.strictEqual(polls.length, 3);
  assert.deepStrictEqual(polls.map(function (p) { return p.opts.params; }), [
    { turn: 'abc', since: 'pending' },
    { turn: 'abc', since: 'pending' },
    { turn: 'abc', since: 'searching_web' },
  ]);
  polls.forEach(function (p) {
    assert.strictEqual(p.opts.method, 'GET');
    assert.ok(p.opts.timeoutMs <= 35000 && p.opts.timeoutMs > 0);
  });
  assert.ok(progress.indexOf('searching_web') !== -1);
  assert.strictEqual(progress[0], 'pending');
  assert.ok(!seen.some(function (s) { return s.path === '/ask' || s.path === '/ask/cancel'; }));
});

test('flag on, start _notFound: falls back to the old POST /ask exactly once', async () => {
  const { ask, seen } = loadAsk(true, {
    '/ask/start': [{ _notFound: true, status: 404 }],
    '/ask': [ANSWER],
  });
  const res = await ask({ question: 'q', tz: null });
  assert.deepStrictEqual(res, ANSWER);
  assert.deepStrictEqual(seen.map(function (s) { return s.path; }), ['/ask/start', '/ask']);
  assert.strictEqual(seen[1].opts.timeoutMs, 35000);
  assert.strictEqual(seen[1].opts.retry, false);
  assert.deepStrictEqual(seen[1].opts.body, seen[0].opts.body);
});

test('flag on, a 404 on /ask/result never falls back to /ask', async () => {
  const { ask, seen } = loadAsk(true, {
    '/ask/start': [{ turn_id: 't' }],
    '/ask/result': [{ _notFound: true, status: 404 }],
    '/ask/cancel': function () { return { _notFound: true, status: 204 }; },
  });
  await assert.rejects(ask({ question: 'q', tz: null }));
  assert.ok(!seen.some(function (s) { return s.path === '/ask'; }));
});

test('flag on, start {error}: handed back as received, no polling', async () => {
  const { ask, seen } = loadAsk(true, { '/ask/start': [{ error: 'Missing question' }] });
  const res = await ask({ question: '', tz: null });
  assert.deepStrictEqual(res, { error: 'Missing question' });
  assert.strictEqual(seen.length, 1);
});

test('flag on, done carrying {error}: resolved as /ask would (200 with the error dict)', async () => {
  const { ask } = loadAsk(true, {
    '/ask/start': [{ turn_id: 't' }],
    '/ask/result': [{ status: 'done', result: { error: 'x' } }],
  });
  assert.deepStrictEqual(await ask({ question: 'q', tz: null }), { error: 'x' });
});

test('flag on, status error / cancelled: rejects (the old failure path)', async () => {
  for (const terminal of [{ status: 'error', error: 'No answer' }, { status: 'cancelled' }]) {
    const { ask } = loadAsk(true, {
      '/ask/start': [{ turn_id: 't' }],
      '/ask/result': [terminal],
      '/ask/cancel': function () { return {}; },
    });
    await assert.rejects(ask({ question: 'q', tz: null }), function (err) {
      assert.strictEqual(err.askStatus, terminal.status);
      return true;
    });
  }
});

test('flag on, the generation goes stale: cancels the turn and settles', async () => {
  let stale = false;
  const { ask, seen } = loadAsk(true, {
    '/ask/start': [{ turn_id: 'gone' }],
    '/ask/result': function () { stale = true; return { status: 'pending' }; },
    '/ask/cancel': function () { return { _notFound: true, status: 204 }; },
  });
  await assert.rejects(
    ask({ question: 'q', tz: null }, { isStale: function () { return stale; } }),
    function (err) { return err.name === 'AbortError'; });
  const cancels = seen.filter(function (s) { return s.path === '/ask/cancel'; });
  assert.strictEqual(cancels.length, 1);
  assert.deepStrictEqual(cancels[0].opts.body, { turn_id: 'gone' });
  assert.strictEqual(cancels[0].opts.method, 'POST');
  assert.strictEqual(seen.filter(function (s) { return s.path === '/ask/result'; }).length, 1);
});

test('flag on, gives up at 60s total: cancels and rejects with a timeout', async () => {
  const realNow = Date.now;
  let clock = 1000000;
  Date.now = function () { return clock; };
  try {
    const { ask, seen } = loadAsk(true, {
      '/ask/start': [{ turn_id: 'slow' }],
      '/ask/result': function () { clock += 25000; return { status: 'pending' }; },
      '/ask/cancel': function () { return {}; },
    });
    await assert.rejects(ask({ question: 'q', tz: null }), function (err) {
      assert.strictEqual(err.timeout, true);
      assert.strictEqual(err.name, 'TimeoutError');
      return true;
    });
    const polls = seen.filter(function (s) { return s.path === '/ask/result'; });
    assert.strictEqual(polls.length, 3);
    /* The third poll began with 10s left, so it may not wait the full 35s. */
    assert.strictEqual(polls[2].opts.timeoutMs, 10000);
    assert.strictEqual(seen.filter(function (s) { return s.path === '/ask/cancel'; }).length, 1);
  } finally {
    Date.now = realNow;
  }
});

test('the flag reaches FS.api from env, default off', () => {
  function flagFor(env) {
    global.window = { FS_ENV: env };
    delete require.cache[require.resolve('../scripts/api/index.js')];
    require('../scripts/api/index.js');
    return global.window.FS.api.askAsync;
  }
  assert.strictEqual(flagFor({}), false);
  assert.strictEqual(flagFor({ askAsync: false }), false);
  assert.strictEqual(flagFor({ askAsync: true }), true);
});

test('the build emits askAsync from FS_ASK_ASYNC, default false, in format order', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'amplify.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(/externalCorroboration: %s, askAsync: %s, navDailyV2: %s/.test(yml));
  assert.ok(/"\$\{FS_EXTERNAL_CORROBORATION:-false\}" "\$\{FS_ASK_ASYNC:-false\}" "\$\{FS_NAV_DAILY_V2:-false\}"/.test(yml));
});

test('ask-chat passes isStale + onProgress and labels the two stages', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/composites/ask-chat.js'), 'utf8');
  assert.match(src, /window\.FS\.api\.ask\.ask\(body, \{\s*isStale:/);
  assert.match(src, /Searching your records…/);
  assert.match(src, /Checking the web…/);
  assert.match(src, /Looking through your records…/);
});

/* The orchestrator (ASK_AGENTIC) reports two more stages on a screen turn:
   `searching_records` and `writing` (backend ask_voice_turn._SCREEN_STATES).
   Treated as unknown, the first poll cancelled a healthy turn and rendered
   "FieldSight is busy" (TEST, 2026-10-21). */
test('flag on: the orchestrator stages are progress, not a failure', async () => {
  const { ask, seen } = loadAsk(true, {
    '/ask/start': [{ turn_id: 'abc' }],
    '/ask/result': [
      { status: 'searching_records' },
      { status: 'searching_web' },
      { status: 'writing' },
      { status: 'done', result: ANSWER },
    ],
  });
  const progress = [];
  const res = await ask({ question: 'q', tz: null },
                        { onProgress: function (s) { progress.push(s); } });
  assert.deepStrictEqual(res, ANSWER);
  const polls = seen.filter(function (s) { return s.path === '/ask/result'; });
  assert.deepStrictEqual(polls.map(function (p) { return p.opts.params.since; }),
                         ['pending', 'searching_records', 'searching_web', 'writing']);
  assert.deepStrictEqual(progress, ['pending', 'searching_records', 'searching_web', 'writing']);
  assert.ok(!seen.some(function (s) { return s.path === '/ask/cancel'; }));
});

test('ask-chat labels the orchestrator stages', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/composites/ask-chat.js'), 'utf8');
  assert.match(src, /progress === 'searching_records' \? 'Searching your records…'/);
  assert.match(src, /progress === 'writing'\s+\? 'Writing the answer…'/);
});
