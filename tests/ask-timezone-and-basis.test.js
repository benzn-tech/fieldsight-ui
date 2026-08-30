'use strict';
const test = require('node:test');
const assert = require('node:assert');

/* Two things, and they fail in opposite directions.

   The zone: Ask now reads "yesterday" out of the question, and it resolves it
   in the ASKER'S zone. The browser is the only place that knows which zone that
   is. If this field stops being sent, nothing breaks and nothing errors — every
   relative question quietly goes back to searching all of time, which is the
   defect this was built to fix. That is exactly how `date` sat here for months:
   sent, forwarded, and read by nobody.

   The basis: the answer says what it was built from. It is COMPUTED by the
   backend, so the test's job is to prove the UI passes it through rather than
   composing its own sentence — two renderings of one dict, and only one of them
   is allowed to be the source of the words. */

function loadAskApi(capture) {
  delete require.cache[require.resolve('../scripts/api/ask.js')];
  global.window = {
    FieldSight: {},
    FS: {
      api: {
        useMocks: false,
        orgBaseUrl: 'https://org.example',
        request: function (path, opts) {
          capture.path = path;
          capture.body = opts.body;
          return Promise.resolve({ answer: 'ok', citations: [] });
        },
      },
    },
  };
  require('../scripts/api/ask.js');
  return global.window.FS.api.ask;
}

test('ask sends an IANA zone id, not a computed date', async () => {
  const cap = {};
  const api = loadAskApi(cap);

  await api.ask({ question: '昨天发生了什么' });

  /* A zone id, because NZ and AU are both on daylight saving for part of the
     year and do not switch on the same date — a date computed here is wrong
     for one of them for several weeks a year. */
  assert.ok(cap.body.tz, 'no tz sent');
  assert.match(cap.body.tz, /^[A-Za-z]+\/[A-Za-z_+-]+$/, 'not an IANA zone: ' + cap.body.tz);
  assert.ok(!/^[+-]?\d/.test(cap.body.tz), 'an offset is not a zone: ' + cap.body.tz);
});

test('ask still sends what it always sent', async () => {
  const cap = {};
  const api = loadAskApi(cap);

  await api.ask({ question: 'q', date: '2026-08-30', user: 'Ben', scope: 'both', topic_id: 3 });

  assert.strictEqual(cap.body.question, 'q');
  assert.strictEqual(cap.body.date, '2026-08-30');
  assert.strictEqual(cap.body.user, 'Ben');
  assert.strictEqual(cap.body.scope, 'both');
  assert.strictEqual(cap.body.topic_id, 3);
});

test('a caller can override the zone, and an explicit null suppresses it', async () => {
  const cap = {};
  const api = loadAskApi(cap);

  await api.ask({ question: 'q', tz: 'Australia/Sydney' });
  assert.strictEqual(cap.body.tz, 'Australia/Sydney');

  await api.ask({ question: 'q', tz: null });
  assert.ok(!('tz' in cap.body), 'explicit null must not become a resolved zone');
});

/* ---- the basis line the answer carries ---------------------------------- */

function loadFormatter() {
  delete require.cache[require.resolve('../scripts/composites/ask-chat.js')];
  global.window = { FieldSight: {}, FS: { api: {} } };
  global.React = { createElement: function () { return null; } };
  global.document = { addEventListener() {}, removeEventListener() {} };
  require('../scripts/composites/ask-chat.js');
  return global.window.FieldSight.formatAnswerBasis;
}

test('the basis line is built from the numbers, not from prose', () => {
  const fmt = loadFormatter();

  assert.strictEqual(fmt({ from: '2026-08-29', to: '2026-08-29', widened: false, chunks: 4, dates: ['2026-08-29'] }),
    'Based on 2026-08-29 · 4 excerpts');

  /* Widened is the case that must SAY it widened: the person asked about
     yesterday and is being shown the 27th. Silently answering from another day
     is the original defect wearing a date. */
  assert.strictEqual(fmt({ from: '2026-08-27', to: '2026-08-27', widened: true, chunks: 2, dates: ['2026-08-27'] }),
    'Nothing in the period asked about — based on 2026-08-27 instead · 2 excerpts');

  assert.strictEqual(fmt({ from: '2026-08-24', to: '2026-08-30', widened: false, chunks: 6,
                           dates: ['2026-08-24', '2026-08-27', '2026-08-30'] }),
    'Based on 2026-08-24 to 2026-08-30 · 3 days · 6 excerpts');
});

test('an unfiltered ask says so rather than inventing a range', () => {
  const fmt = loadFormatter();
  assert.strictEqual(fmt({ from: null, to: null, widened: false, chunks: 5, dates: ['2026-08-27'] }),
    'Based on all records you can see · 5 excerpts');
});

test('no basis renders nothing at all', () => {
  const fmt = loadFormatter();
  /* An older backend, or the legacy path. A line saying "based on nothing"
     would be worse than no line. */
  assert.strictEqual(fmt(null), null);
  assert.strictEqual(fmt(undefined), null);
  assert.strictEqual(fmt({ chunks: 0, dates: [], from: null, to: null, widened: false }), null);
});
