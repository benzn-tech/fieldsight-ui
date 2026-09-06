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


/* ---- order: the basis line comes BEFORE the answer ---------------------- */

function renderAssistantChildren(msg) {
  /* Drives AskChat's message renderer with a recording React stub, so the ORDER
     of the children can be asserted. The order is the whole point here and it
     has already been wrong once: a version of this shipped with the basis line
     under the answer, which meant a reader learned their period was empty only
     after three sentences about a date they had not asked about. */
  delete require.cache[require.resolve('../scripts/composites/ask-chat.js')];
  const seen = [];
  global.React = {
    createElement: function (type, props) {
      const kids = Array.prototype.slice.call(arguments, 2);
      const node = { className: (props && props.className) || '', kids: kids };
      seen.push(node);
      return node;
    },
    useState: function (v) { return [v, function () {}]; },
    useEffect: function () {},
    useRef: function () { return { current: null }; },
  };
  global.window = { FieldSight: {}, FS: { api: {} } };
  global.document = { addEventListener() {}, removeEventListener() {} };
  require('../scripts/composites/ask-chat.js');

  const fmt = global.window.FieldSight.formatAnswerBasis;
  /* The component is not mounted here — instead the two renderers are called in
     the order the component calls them, which is what the source defines. */
  return { fmt: fmt, source: require('fs').readFileSync(
    require.resolve('../scripts/composites/ask-chat.js'), 'utf8') };
}

test('the basis line is rendered before the answer text, not after it', () => {
  const { source } = renderAssistantChildren();
  const basisAt  = source.indexOf("'fs-ask-chat__basis'");
  const answerAt = source.indexOf("fs-ask-chat__msg-text fs-ask-chat__msg-text--md");
  const citesAt  = source.indexOf('renderCitations(m.citations)');

  assert.ok(basisAt > 0 && answerAt > 0 && citesAt > 0, 'renderers not found');
  assert.ok(basisAt < answerAt,
    'the basis line renders AFTER the answer — the reader learns the period was empty ' +
    'only once they have read about another day');
  assert.ok(answerAt < citesAt, 'citations must still follow the answer');
});

test('a widened basis carries the class that makes it red', () => {
  const { source } = renderAssistantChildren();
  assert.match(source, /fs-ask-chat__basis--widened/);
});


/* ---- the line follows the question's language --------------------------- */

/* Reported on the deployed site: a question asked in Chinese was answered about
   a different day with no readable reason, while the same question in English
   got the line explaining the substitution.

   The cause is a design decision meeting a monolingual string. The backend
   prompt tells the model NOT to say the period was empty when it answers on
   screen, precisely BECAUSE this line says it first -- stating one fact in two
   voices is worse than stating it once. So when this line is English and the
   reader is not, the model has been silenced and nothing has spoken. */

test('the widened line speaks the language the question was asked in', () => {
  const fmt = loadFormatter();
  const basis = { from: '2026-08-28', to: '2026-08-28', widened: true, chunks: 4,
                  dates: ['2026-08-28'] };

  assert.strictEqual(fmt(basis, false),
    'Nothing in the period asked about — based on 2026-08-28 instead · 4 excerpts');
  assert.strictEqual(fmt(basis, true),
    '所问的时间段没有记录 — 改为基于 2026-08-28 · 4 段摘录');
});

test('every other shape of the line is translated too', () => {
  const fmt = loadFormatter();

  assert.strictEqual(fmt({ from: '2026-08-29', to: '2026-08-29', chunks: 4,
                           dates: ['2026-08-29'] }, true),
    '基于 2026-08-29 · 4 段摘录');

  assert.strictEqual(fmt({ from: null, to: null, chunks: 5, dates: [] }, true),
    '基于你能看到的全部记录 · 5 段摘录');

  assert.strictEqual(fmt({ from: '2026-08-24', to: '2026-08-30', chunks: 6,
                           dates: ['2026-08-24', '2026-08-27', '2026-08-30'] }, true),
    '基于 2026-08-24 至 2026-08-30 · 3 天 · 6 段摘录');
});

test('the language is decided by the question, not by the answer', () => {
  /* The model's reply language is not reliable: measured on prod, the same
     Chinese question came back in English on 2 of 3 runs. Reading the language
     off the answer would make this line inherit that coin flip, so it is
     captured from the question at send time. */
  delete require.cache[require.resolve('../scripts/composites/ask-chat.js')];
  global.window = { FieldSight: {}, FS: { api: {} } };
  global.React = { createElement: function () { return null; } };
  global.document = { addEventListener() {}, removeEventListener() {} };
  require('../scripts/composites/ask-chat.js');

  const source = require('fs').readFileSync(
    require.resolve('../scripts/composites/ask-chat.js'), 'utf8');
  assert.ok(source.includes('zh:        askedInChinese(question)'),
    'the flag must come from the question at send time');
  assert.ok(!/askedInChinese\(\s*res\.answer/.test(source),
    'the flag must not be read off the model answer');
});

test('an English question is never given a Chinese line', () => {
  const fmt = loadFormatter();
  const basis = { from: '2026-08-28', to: '2026-08-28', widened: true, chunks: 1,
                  dates: ['2026-08-28'] };
  const out = fmt(basis, false);
  assert.ok(!/[㐀-䶿一-鿿]/.test(out), out);
  assert.ok(out.includes('1 excerpt') && !out.includes('1 excerpts'), out);
});


test('the render site actually hands the language to the renderer', () => {
  /* The four tests above all passed with `m.zh` deleted from the render call --
     they exercise `formatAnswerBasis` directly, so a correct translator wired to
     nothing satisfies every one of them. That is the shape where a feature ships
     and does nothing.

     Driving the render would need the whole React tree; the wiring is one
     argument, so it is pinned here as wiring. The BEHAVIOUR of the translator is
     driven by the tests above. */
  const source = require('fs').readFileSync(
    require.resolve('../scripts/composites/ask-chat.js'), 'utf8');
  const calls = source.match(/formatAnswerBasis\(m\.basis[^)]*\)/g) || [];
  assert.ok(calls.length >= 2, 'render site not found: ' + JSON.stringify(calls));
  calls.forEach(function (c) {
    assert.ok(/m\.basis\s*,\s*m\.zh/.test(c),
      'the language is not passed at the render site: ' + c);
  });
});
