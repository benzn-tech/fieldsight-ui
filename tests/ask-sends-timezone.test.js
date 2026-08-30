'use strict';

/*
 * The zone the Ask date-anchor needs, and the reason a test exists for one
 * field on one request body.
 *
 * The backend anchors "yesterday" / "last week" on the CALLER'S calendar day,
 * resolved from an IANA zone id the client sends. Every hop of that was built
 * and deployed -- the gateway forwards `tz`, ask-agent reads it, the search
 * filters and widens on it -- and none of it did anything, because this client
 * never put the field in the body. Verified against prod on 2026-08-30: an
 * invoke carrying tz comes back with `basis {from, to, widened}`; the same
 * question without it searches every date, which is the pre-#619 behaviour.
 *
 * That is this repo's recurring shape (CLAUDE.md "How to verify"): the whole
 * chain green, the feature absent, and no error anywhere -- because "no zone"
 * is a legitimate answer that degrades to unfiltered search rather than
 * failing. So the assertion has to be on the assembled body, not on the
 * existence of a helper.
 *
 * ask.js is a browser IIFE that registers onto window.FS.api at load, so a
 * minimal window stub is enough to require it under Node (same posture as
 * tests/checkoff-org-api.test.js).
 */
const test = require('node:test');
const assert = require('node:assert');

let sent;

function loadAsk(opts) {
  opts = opts || {};
  sent = [];
  global.window = {
    FS: {
      api: {
        useMocks: false,
        orgBaseUrl: 'https://example.invalid/api/org',
        delay: async function () {},
        request: async function (path, init) {
          sent.push({ path: path, init: init });
          return { answer: 'ok', citations: [] };
        },
      },
    },
  };
  if (opts.breakIntl) {
    global.Intl = { DateTimeFormat: function () { throw new Error('no Intl'); } };
  }
  delete require.cache[require.resolve('../scripts/api/ask.js')];
  require('../scripts/api/ask.js');
  return global.window.FS.api.ask;
}

test('the ask body carries the browser zone as an IANA id', async () => {
  const realZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ask = loadAsk();
  await ask.ask({ question: 'What happened yesterday?', user: 'Ben_UCPK2' });

  assert.strictEqual(sent.length, 1, 'one request');
  const body = sent[0].init.body;
  assert.ok('tz' in body, 'tz must be in the body -- without it the anchor is unreachable');
  assert.strictEqual(body.tz, realZone);
  /* A zone id, not a date and not an offset: "GMT+12" and "2026-08-30" both
     resolve to nothing server-side, and both would look like a value here. */
  assert.ok(body.tz.includes('/'), 'an IANA zone id, e.g. Pacific/Auckland');
  assert.ok(!/^\d{4}-\d{2}-\d{2}$/.test(body.tz), 'not a date');
});

test('the other fields are unchanged', async () => {
  const ask = loadAsk();
  await ask.ask({ question: 'q', user: 'u', date: '2026-08-30', scope: 'both', topic_id: 3 });
  const body = sent[0].init.body;
  assert.strictEqual(body.question, 'q');
  assert.strictEqual(body.user, 'u');
  assert.strictEqual(body.date, '2026-08-30');
  assert.strictEqual(body.scope, 'both');
  assert.strictEqual(body.topic_id, 3);
});

test('an unusable Intl sends no zone rather than a guessed one', async () => {
  const realIntl = global.Intl;
  try {
    const ask = loadAsk({ breakIntl: true });
    await ask.ask({ question: 'q' });
    /* undefined, never a hardcoded fallback: the server treats a missing zone
       and an unusable one the same way -- no anchor -- and a guessed zone would
       instead produce a confidently wrong day. */
    assert.strictEqual(sent[0].init.body.tz, undefined);
  } finally {
    global.Intl = realIntl;
  }
});
