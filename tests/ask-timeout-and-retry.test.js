'use strict';

/*
 * The Ask box gave up before the agent could answer, and then asked again
 * three more times.
 *
 * Measured against the deployed prod ask-agent, six consecutive runs of
 * "what did I do today" (two citations, no error, a correct answer every
 * time):
 *
 *     9.6s  9.5s  9.0s  9.6s  10.3s  10.8s
 *
 * `_fetch.js` uses DEFAULT_TIMEOUT_MS = 10000 and `ask()` passed no
 * `timeoutMs`, so the browser aborted somewhere around the median. Those are
 * Lambda round trips measured from a shell; the browser also pays API Gateway
 * and CORS on top, so the real crossing rate is higher than 3-in-6.
 *
 * What the user saw was not a timeout message. `fetchWithRetry` only declines
 * to retry an AbortError when the CALLER supplied the aborted signal, and
 * `ask()` supplies none -- so its own timeout looked like a network blip and
 * was retried on the 1s/2s/4s ladder. Four full RAG+LLM calls, ~47s of
 * waiting, and then the browser's own DOMException text surfaced verbatim:
 *
 *     "Could not reach the agent. signal is aborted without reason"
 *
 * The backend was healthy throughout and each of those four attempts kept
 * running after the browser stopped listening.
 *
 * The ceiling is not a matter of taste: ask.js's own comment records that
 * `/ask` is capped by API Gateway's 29s integration timeout. A client budget
 * below that abandons answers the gateway would still have delivered; above
 * it, the gateway's own 504 arrives first and says something true.
 *
 * _fetch.js and ask.js are browser IIFEs that register onto window.FS.api at
 * load, so a window stub is enough to require them under Node (same posture as
 * tests/checkoff-org-api.test.js).
 */
const test = require('node:test');
const assert = require('node:assert');

const GATEWAY_INTEGRATION_TIMEOUT_MS = 29000;

/* ---- harness ------------------------------------------------------------- */

function loadFetchModule() {
  global.window = { FS: {} };
  delete require.cache[require.resolve('../scripts/api/_fetch.js')];
  require('../scripts/api/_fetch.js');
  return global.window.FS.api;
}

/* A server that accepts the connection and then never answers -- which is what
   a slow agent looks like from the browser. Resolves only if aborted. */
function hangingFetch(record) {
  return function (url, opts) {
    record.push(url);
    return new Promise(function (_resolve, reject) {
      opts.signal.addEventListener('abort', function () {
        /* The exact shape the browser throws, including the message the user
           was shown. */
        const err = new Error('signal is aborted without reason');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };
}

/* ---- the ask call asks for enough time ----------------------------------- */

test('ask() gives the agent longer than the gateway will hold the request', async () => {
  const seen = [];
  global.window = {
    FS: {
      api: {
        useMocks: false,
        orgBaseUrl: 'https://org.example/prod/api',
        request: function (path, opts) {
          seen.push({ path: path, opts: opts });
          return Promise.resolve({ answer: 'ok', citations: [] });
        },
        delay: function () { return Promise.resolve(); },
      },
    },
  };
  delete require.cache[require.resolve('../scripts/api/ask.js')];
  require('../scripts/api/ask.js');

  await global.window.FS.api.ask.ask({ question: 'what did I do today', tz: null });

  assert.strictEqual(seen.length, 1, 'expected exactly one /ask call');
  const timeoutMs = seen[0].opts.timeoutMs;
  assert.ok(
    typeof timeoutMs === 'number' && timeoutMs > GATEWAY_INTEGRATION_TIMEOUT_MS,
    'ask() must set a timeout above the gateway ceiling; got ' + timeoutMs
  );
});

test('ask() does not let a slow answer be re-asked three more times', async () => {
  const seen = [];
  global.window = {
    FS: {
      api: {
        useMocks: false,
        orgBaseUrl: 'https://org.example/prod/api',
        request: function (path, opts) {
          seen.push({ path: path, opts: opts });
          return Promise.resolve({ answer: 'ok', citations: [] });
        },
        delay: function () { return Promise.resolve(); },
      },
    },
  };
  delete require.cache[require.resolve('../scripts/api/ask.js')];
  require('../scripts/api/ask.js');

  await global.window.FS.api.ask.ask({ question: 'q', tz: null });
  assert.strictEqual(seen[0].opts.retry, false,
    'a timed-out RAG+LLM call must not be replayed: it costs a second full answer');
});

test('corroborate() carries the same budget -- it is the second model call', async () => {
  const seen = [];
  global.window = {
    FS: {
      api: {
        useMocks: false,
        orgBaseUrl: 'https://org.example/prod/api',
        request: function (path, opts) {
          seen.push({ path: path, opts: opts });
          return Promise.resolve({ corroborations: [] });
        },
        delay: function () { return Promise.resolve(); },
      },
    },
  };
  delete require.cache[require.resolve('../scripts/api/ask.js')];
  require('../scripts/api/ask.js');

  await global.window.FS.api.ask.corroborate({ question: 'q', answer: 'a' });
  assert.ok(seen[0].opts.timeoutMs > GATEWAY_INTEGRATION_TIMEOUT_MS, 'corroborate timeout');
  assert.strictEqual(seen[0].opts.retry, false, 'corroborate must not be replayed either');
});

/* ---- the transport honours it -------------------------------------------- */

test('retry:false stops after one attempt instead of four', async () => {
  const api = loadFetchModule();
  const urls = [];
  global.fetch = hangingFetch(urls);

  await assert.rejects(
    api.request('/ask', { method: 'POST', allowAnon: true, timeoutMs: 20, retry: false }),
    (err) => err instanceof Error
  );
  assert.strictEqual(urls.length, 1,
    'one question must produce one backend call; got ' + urls.length);
});

test('a timeout says it timed out, not "signal is aborted without reason"', async () => {
  const api = loadFetchModule();
  global.fetch = hangingFetch([]);

  await assert.rejects(
    api.request('/ask', { method: 'POST', allowAnon: true, timeoutMs: 20, retry: false }),
    (err) => {
      assert.ok(!/aborted without reason/i.test(err.message),
        'the browser\'s own DOMException text reached the user: ' + err.message);
      assert.ok(/timed out|took longer/i.test(err.message),
        'expected a message naming the timeout; got: ' + err.message);
      return true;
    }
  );
});

test('the default is still to retry -- this fix must not disarm it everywhere', async () => {
  const api = loadFetchModule();
  const urls = [];
  global.fetch = function (url) {
    urls.push(url);
    return Promise.reject(new TypeError('Failed to fetch'));
  };

  await assert.rejects(api.request('/reports', { allowAnon: true, timeoutMs: 20 }));
  assert.strictEqual(urls.length, 4,
    'unrelated GETs keep the 1s/2s/4s ladder; got ' + urls.length);
});

/* ---- the copy the user actually saw -------------------------------------- */

test('a slow agent is not reported as an unreachable one', () => {
  /* Wiring, not behaviour, and that is all this claims: ask-chat.js is a React
     IIFE with no export, and the repo's existing tests for it (ask-panel-ux)
     read the source the same way. What it pins is that the branch exists and
     keys off the flag `_fetch` now sets -- the words themselves are checked by
     reading them, which is what copy deserves. */
  const fs = require('fs');
  const src = fs.readFileSync(
    require.resolve('../scripts/composites/ask-chat.js'), 'utf8');
  assert.ok(/err && err\.timeout/.test(src),
    'the error branch must distinguish a timeout from an unreachable agent');
  assert.ok(/took too long to answer/.test(src), 'timeout copy missing');
});
