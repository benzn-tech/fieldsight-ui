'use strict';

/*
 * Ask conversation history, API layer (spec 2026-10-22 ask-conversation-history
 * §5/§7, plan task 7), behind FS_ASK_THREADS -> window.FS_ENV.askThreads ->
 * FS.api.askThreadsOn.
 *
 * - ask() is a whitelist (the ui#316 trap): `thread_id` and `new_thread` must
 *   be named there or they vanish, and must be ABSENT when the caller did not
 *   set them, so every caller that never sets them sends today's body.
 * - FS.api.askThreads.list/get/remove ride the org channel
 *   (GET/GET/DELETE /api/org/ask/threads[/id]) and make no request at all
 *   with the flag off, in mock mode, or without an org base URL.
 * - A backend without the routes (404) reads as "no conversations"; a 403 or
 *   a 5xx does NOT -- an AccessDenied read as an empty list is the failure
 *   this feature's review named.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TID = '0123456789abcdef0123456789abcdef';

/* ---- flag wiring ---------------------------------------------------------- */

test('T1 the flag reaches FS.api.askThreadsOn from env, default off', () => {
  function flagFor(env) {
    global.window = { FS_ENV: env };
    delete require.cache[require.resolve('../scripts/api/index.js')];
    require('../scripts/api/index.js');
    return global.window.FS.api.askThreadsOn;
  }
  assert.strictEqual(flagFor({}), false);
  assert.strictEqual(flagFor({ askThreads: false }), false);
  assert.strictEqual(flagFor({ askThreads: true }), true);
});

test('T2 the build emits askThreads from FS_ASK_THREADS, default false, same position in format and args', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'amplify.yml'), 'utf8').replace(/\r\n/g, '\n');
  const fmt = yml.match(/printf 'window\.FS_ENV = \{([^']*)\};\\n'/);
  assert.ok(fmt, 'printf format string not found');
  const keys = fmt[1].split(',').map(function (s) { return s.trim().split(':')[0]; });
  const argsLine = yml.slice(fmt.index + fmt[0].length).split('\n')[1];
  const args = argsLine.trim().match(/"[^"]*"/g);
  assert.strictEqual(keys.length, args.length, 'format keys and arguments out of step');
  const k = keys.indexOf('askThreads');
  assert.ok(k >= 0, 'askThreads missing from the format string');
  assert.strictEqual(args[k], '"${FS_ASK_THREADS:-false}"');
});

test('T3 the page loads api/ask-threads.js after api/index.js', () => {
  const html = fs.readFileSync(path.join(ROOT, 'app-shell-preview.html'), 'utf8');
  const idx = html.indexOf('scripts/api/index.js');
  const at = html.indexOf('scripts/api/ask-threads.js');
  assert.ok(idx > 0, 'api/index.js not found');
  assert.ok(at > idx, 'ask-threads.js missing or loaded before api/index.js (which replaces FS.api)');
});

/* ---- ask() forwards the thread fields, on both transports ------------------ */

function loadAsk(asyncFlag) {
  const seen = [];
  global.window = {
    FS: {
      api: {
        useMocks: false,
        askAsync: asyncFlag,
        orgBaseUrl: 'https://org.example/api',
        request: function (p, opts) {
          seen.push({ path: p, opts: opts });
          if (p === '/ask') return Promise.resolve({ answer: 'a' });
          if (p === '/ask/start') return Promise.resolve({ turn_id: 't1' });
          if (p === '/ask/result') return Promise.resolve({ status: 'done', result: { answer: 'a' } });
          return Promise.resolve({});
        },
        delay: function () { return Promise.resolve(); },
      },
    },
  };
  delete require.cache[require.resolve('../scripts/api/ask.js')];
  require('../scripts/api/ask.js');
  return { ask: global.window.FS.api.ask.ask, seen: seen };
}

for (const asyncFlag of [false, true]) {
  const route = asyncFlag ? '/ask/start' : '/ask';
  test('T4 ask() forwards thread_id and new_thread:true, drops new_thread:false and non-string ids (' + route + ')', async () => {
    async function bodyFor(opts) {
      const L = loadAsk(asyncFlag);
      await L.ask(Object.assign({ question: 'q', tz: null }, opts));
      return L.seen.find(function (s) { return s.path === route; }).opts.body;
    }
    let body = await bodyFor({ thread_id: TID });
    assert.strictEqual(body.thread_id, TID);
    assert.ok(!('new_thread' in body));

    body = await bodyFor({ new_thread: true });
    assert.strictEqual(body.new_thread, true);
    assert.ok(!('thread_id' in body));

    for (const bad of [{ new_thread: false }, { new_thread: 'true' }, { new_thread: 1 },
                       { thread_id: 42 }, { thread_id: null }, { thread_id: '' },
                       { thread_id: '../x' }, { thread_id: TID.toUpperCase() }]) {
      body = await bodyFor(bad);
      assert.ok(!('new_thread' in body), 'new_thread reached the wire for ' + JSON.stringify(bad));
      assert.ok(!('thread_id' in body), 'thread_id reached the wire for ' + JSON.stringify(bad));
    }
  });

  test('T5 without thread fields the body is exactly today\'s (' + route + ')', async () => {
    const L = loadAsk(asyncFlag);
    await L.ask({ question: 'q', tz: null, history: [{ question: 'a', answer: 'b' }], offer_web: true });
    const body = L.seen.find(function (s) { return s.path === route; }).opts.body;
    assert.strictEqual(JSON.stringify(body),
      JSON.stringify({ question: 'q', history: [{ question: 'a', answer: 'b' }], offer_web: true }));
  });
}

/* ---- FS.api.askThreads ---------------------------------------------------- */

function loadThreads(apiOver, script) {
  const seen = [];
  const api = Object.assign({
    useMocks: false,
    orgBaseUrl: 'https://org.example/prod/api',
    askThreadsOn: true,
    request: function (p) {
      seen.push({ path: p, report: true });
      return Promise.reject(new Error('the report channel must not be used'));
    },
    orgRequest: function (p, opts) {
      seen.push({ path: p, opts: opts || {} });
      const r = script ? script(p, opts || {}) : {};
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    },
  }, apiOver || {});
  global.window = { FS: { api: api } };
  delete require.cache[require.resolve('../scripts/api/ask-threads.js')];
  require('../scripts/api/ask-threads.js');
  return { T: global.window.FS.api.askThreads, seen: seen };
}

test('T6 list/get/remove hit /api/org/ask/threads[/id] with GET/GET/DELETE on the org channel', async () => {
  const thread = { thread_id: TID, scope: {}, turns: [] };
  const { T, seen } = loadThreads({}, function (p, o) {
    if (p === '/ask/threads') return { threads: [{ thread_id: TID, title: 't', updated_at: 1, turns: 1 }] };
    if (p === '/ask/threads/' + TID && (o.method || 'GET') === 'GET') return thread;
    /* A 204 carries no JSON content-type, so request() resolves it as this. */
    if (p === '/ask/threads/' + TID && o.method === 'DELETE') return { _notFound: true, status: 204 };
    return new Error('unexpected ' + p);
  });
  const list = await T.list();
  assert.deepStrictEqual(list, [{ thread_id: TID, title: 't', updated_at: 1, turns: 1 }]);
  assert.deepStrictEqual(await T.get(TID), thread);
  assert.strictEqual(await T.remove(TID), true);
  /* orgRequest prefixes /org; the logical paths are what this layer owns. */
  assert.deepStrictEqual(seen.map(function (s) { return [s.path, (s.opts.method || 'GET')]; }), [
    ['/ask/threads', 'GET'],
    ['/ask/threads/' + TID, 'GET'],
    ['/ask/threads/' + TID, 'DELETE'],
  ]);
  assert.ok(!seen.some(function (s) { return s.report; }));
});

test('T7 list resolves [] without a request when the flag is off, in mock mode, or with no org base', async () => {
  for (const over of [{ askThreadsOn: false }, { askThreadsOn: undefined },
                      { useMocks: true }, { orgBaseUrl: '' }]) {
    const { T, seen } = loadThreads(over);
    assert.deepStrictEqual(await T.list(), []);
    assert.strictEqual(await T.get(TID), null);
    assert.strictEqual(await T.remove(TID), false);
    assert.strictEqual(seen.length, 0, 'a request went out for ' + JSON.stringify(over));
  }
});

test('T8 a backend without the routes (404) is "no conversations"; a 403 or a 5xx is a failure', async () => {
  let L = loadThreads({}, function () { return { _notFound: true, status: 404 }; });
  assert.deepStrictEqual(await L.T.list(), []);
  assert.strictEqual(await L.T.get(TID), null);

  L = loadThreads({}, function () { return { _accessDenied: true, status: 403, error: 'no' }; });
  await assert.rejects(L.T.list());
  await assert.rejects(L.T.get(TID));
  await assert.rejects(L.T.remove(TID));

  const boom = Object.assign(new Error('HTTP 502'), { status: 502 });
  L = loadThreads({}, function () { return boom; });
  await assert.rejects(L.T.list(), /502/);

  /* A body that is not the contract's shape is not an empty list either. */
  L = loadThreads({}, function () { return { something: 'else' }; });
  await assert.rejects(L.T.list());
});

test('T9 a malformed id never reaches the wire', async () => {
  const { T, seen } = loadThreads({}, function () { return {}; });
  assert.strictEqual(await T.get('../me'), null);
  assert.strictEqual(await T.remove('../me'), false);
  assert.strictEqual(seen.length, 0);
});
