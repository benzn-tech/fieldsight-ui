'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

/* One Ask, scoped to what you are looking at (docs/specs/2026-09-15-one-ask-scoped.md §5).

   The request is a REQUEST: the backend decides what it enforces and says so in
   `applied_scope`. So every helper here is pinned on both halves -- what we ask
   for, and that what we SHOW comes from the answer, never from our own request. */

function loadScope() {
  delete require.cache[require.resolve('../scripts/composites/ask-chat.js')];
  global.window = { FieldSight: {}, FS: { api: {} } };
  global.React = { createElement: function () { return null; } };
  global.document = { addEventListener() {}, removeEventListener() {} };
  require('../scripts/composites/ask-chat.js');
  return global.window.FieldSight.askScope;
}

function loadAskApi(capture) {
  delete require.cache[require.resolve('../scripts/api/ask.js')];
  global.window = {
    FieldSight: {},
    FS: { api: {
      useMocks: false,
      orgBaseUrl: 'https://org.example',
      request: function (path, opts) {
        capture.body = opts.body;
        return Promise.resolve({ answer: 'ok', citations: [] });
      },
    } },
  };
  require('../scripts/api/ask.js');
  return global.window.FS.api.ask;
}

const DAY = { date: '2026-09-03', siteId: 'site-uuid', siteName: 'UC PK',
              authorFolder: 'Ben_UCPK2', authorName: 'Ben UCPK2' };
const TOPIC = Object.assign({}, DAY, { topicRowId: 'topic-uuid',
              topicTitle: 'Morning commercial chase and landscaping cost escalation' });

/* ---- 1. requestBodyFor --------------------------------------------------- */

test('1a requestBodyFor maps every context field to its contract name', () => {
  const S = loadScope();
  assert.deepStrictEqual(S.requestBodyFor(TOPIC, 'q'), {
    question: 'q', date: '2026-09-03', site_id: 'site-uuid',
    author_folder: 'Ben_UCPK2', topic_row_id: 'topic-uuid', scoped: true,
  });
});

test('1b absent fields are absent -- not empty string, not null', () => {
  const S = loadScope();
  const body = S.requestBodyFor({ date: '2026-09-03', siteId: '', authorFolder: null,
                                  topicRowId: undefined }, 'q');
  assert.deepStrictEqual(Object.keys(body).sort(), ['date', 'question', 'scoped']);
  assert.deepStrictEqual(S.requestBodyFor({}, 'q'), { question: 'q' });
  assert.deepStrictEqual(S.requestBodyFor(undefined, 'q'), { question: 'q' });
});

test('1c scope and topic_id are never sent, whatever the context carries', () => {
  const S = loadScope();
  const body = S.requestBodyFor(Object.assign({ scope: 'both', topic_id: 3 }, TOPIC), 'q');
  assert.ok(!('scope' in body), 'scope leaked into the body');
  assert.ok(!('topic_id' in body), 'topic_id leaked into the body');
});

test('1c2 scoped:true is sent whenever any narrowing field is, and omitted otherwise', () => {
  const S = loadScope();
  assert.strictEqual(S.requestBodyFor(TOPIC, 'q').scoped, true);
  assert.strictEqual(S.requestBodyFor({ date: '2026-09-03' }, 'q').scoped, true);
  assert.strictEqual(S.requestBodyFor({ siteId: 's' }, 'q').scoped, true);
  assert.strictEqual(S.requestBodyFor({ authorFolder: 'A' }, 'q').scoped, true);
  assert.strictEqual(S.requestBodyFor({ topicRowId: 't' }, 'q').scoped, true);
  assert.ok(!('scoped' in S.requestBodyFor({}, 'q')), 'scoped present with no narrowing field');
  assert.ok(!('scoped' in S.requestBodyFor(undefined, 'q')), 'scoped present with no context');
});

test('1d the api forwards the new fields, and omits them when absent', async () => {
  const cap = {};
  const api = loadAskApi(cap);
  await api.ask({ question: 'q', date: '2026-09-03', site_id: 's', author_folder: 'A',
                  topic_row_id: 't', tz: null });
  assert.strictEqual(cap.body.site_id, 's');
  assert.strictEqual(cap.body.author_folder, 'A');
  assert.strictEqual(cap.body.topic_row_id, 't');

  await api.ask({ question: 'q', tz: null });
  /* The wire is JSON: an undefined value is a missing key there. */
  const wire = JSON.parse(JSON.stringify(cap.body));
  ['site_id', 'author_folder', 'topic_row_id', 'scope', 'topic_id', 'scoped'].forEach(function (k) {
    assert.ok(!(k in wire), k + ' present on the wire when not supplied');
  });
});

test('1e the api forwards scoped:true, and the real ask.js body carries it end to end', async () => {
  const S = loadScope();
  const cap = {};
  const api = loadAskApi(cap);
  const body = S.requestBodyFor(TOPIC, 'q');
  await api.ask(Object.assign({ tz: null }, body));
  assert.strictEqual(cap.body.scoped, true);

  /* Any other value than true must not reach the wire. */
  const cap2 = {};
  const api2 = loadAskApi(cap2);
  await api2.ask({ question: 'q', scoped: false, tz: null });
  assert.ok(!('scoped' in JSON.parse(JSON.stringify(cap2.body))), 'scoped:false leaked onto the wire');
});

/* ---- 2. chipsFor --------------------------------------------------------- */

test('2a an empty context has no chips', () => {
  const S = loadScope();
  assert.deepStrictEqual(S.chipsFor({}), []);
  assert.deepStrictEqual(S.chipsFor(undefined), []);
});

test('2b a day context is one chip: date · site · owner', () => {
  const S = loadScope();
  const chips = S.chipsFor(DAY);
  assert.strictEqual(chips.length, 1);
  assert.strictEqual(chips[0].kind, 'day');
  /* 2026-09-03 is a Thursday (the spec example said Wed; computed, not typed). */
  assert.strictEqual(chips[0].label, 'Thu 3 Sep · UC PK · Ben_UCPK2');
  assert.deepStrictEqual(chips[0].segments.map(s => s.field), ['date', 'site_id', 'author_folder']);
});

test('2c a topic context is two chips, the topic title truncated', () => {
  const S = loadScope();
  const chips = S.chipsFor(TOPIC);
  assert.deepStrictEqual(chips.map(c => c.kind), ['day', 'topic']);
  assert.strictEqual(chips[1].label, 'Topic: Morning commercial chase…');
  assert.strictEqual(chips[1].title, TOPIC.topicTitle, 'the full title belongs in the tooltip');
});

test('2d a day without siteId has no site segment', () => {
  const S = loadScope();
  const ctx = { date: '2026-09-03', authorFolder: 'Ben_UCPK2', siteName: 'UC PK' };
  const chips = S.chipsFor(ctx);
  assert.strictEqual(chips[0].label, 'Thu 3 Sep · Ben_UCPK2');
  assert.ok(!chips[0].segments.some(s => s.field === 'site_id'));
});

test('2e removing the day clears the topic; removing the topic keeps the day', () => {
  const S = loadScope();
  const chips = S.chipsFor(TOPIC);
  assert.deepStrictEqual(chips[0].next, {}, 'a topic cannot outlive its day');
  assert.deepStrictEqual(chips[1].next, DAY);
  assert.ok(!('topicRowId' in chips[1].next) && !('topicTitle' in chips[1].next));
});

test('2f the date label never goes through new Date(string)', () => {
  const src = fs.readFileSync(require.resolve('../scripts/composites/ask-chat.js'), 'utf8');
  const fn = src.slice(src.indexOf('function shortDay'), src.indexOf('function shortDay') + 400);
  assert.match(fn, /Date\.UTC/);
  assert.doesNotMatch(fn, /new Date\(iso/);
});

/* ---- 4. chips say what was enforced once an answer exists ---------------- */

test('4a before any answer the chips show the request, unmarked', () => {
  const S = loadScope();
  S.chipsFor(TOPIC).forEach(c => c.segments.forEach(s =>
    assert.strictEqual(s.enforced, null, s.field + ' marked before an answer')));
});

test('4b an answer whose applied_scope lacks author_folder marks the owner segment', () => {
  const S = loadScope();
  const res = { applied_scope: { date: '2026-09-03', site_id: 'site-uuid',
    dropped: [{ field: 'author_folder', reason: 'not_visible' }] } };
  const seg = f => S.chipsFor(DAY, res)[0].segments.find(s => s.field === f);
  assert.strictEqual(seg('author_folder').enforced, false);
  assert.strictEqual(seg('date').enforced, true);
  assert.strictEqual(seg('site_id').enforced, true);
});

test('4c an answer with no applied_scope at all marks every segment not enforced', () => {
  const S = loadScope();
  S.chipsFor(TOPIC, { answer: 'x' }).forEach(c => c.segments.forEach(s =>
    assert.strictEqual(s.enforced, false, s.field)));
});

/* ---- 3. basisLinesFor ---------------------------------------------------- */

test('3a no applied_scope means the backend did not scope: say so', () => {
  const S = loadScope();
  assert.deepStrictEqual(S.basisLinesFor({ answer: 'x' }), ['Searched all your projects']);
  assert.deepStrictEqual(S.basisLinesFor({ applied_scope: null }), ['Searched all your projects']);
});

test('3b every dropped row of the spec table renders its own copy', () => {
  const S = loadScope();
  const rows = [
    ['topic_row_id', 'not_visible', 'Topic not available — answered for the day'],
    ['topic_row_id', 'invalid', 'Topic not available — answered for the day'],
    ['author_folder', 'not_visible', "Couldn't narrow to this person — answered for the project and day"],
    ['author_folder', 'invalid', "Couldn't narrow to this person — answered for the project and day"],
    ['site_id', 'not_visible', "Couldn't narrow to this project"],
    ['site_id', 'invalid', "Couldn't narrow to this project"],
    ['date', 'invalid', "Couldn't narrow to this day"],
    ['date', 'overridden_by_question', 'Used the dates in your question'],
    ['date', 'overridden_by_topic', "Answered for this topic's day"],
    ['question_range', 'overridden_by_topic', "Answered for this topic's day, not the dates in your question"],
  ];
  rows.forEach(function (r) {
    assert.deepStrictEqual(
      S.basisLinesFor({ applied_scope: { dropped: [{ field: r[0], reason: r[1] }] } }),
      [r[2]], r[0] + '/' + r[1]);
  });
});

test('3c an unknown field/reason pair renders nothing, never a raw code', () => {
  const S = loadScope();
  const out = S.basisLinesFor({ applied_scope: { dropped: [
    { field: 'date', reason: 'not_visible' },
    { field: 'weather', reason: 'invalid' },
    { field: 'site_id', reason: 'exploded' },
    null,
  ] } });
  assert.deepStrictEqual(out, []);
});

test('3d a fully enforced scope has no line', () => {
  const S = loadScope();
  assert.deepStrictEqual(S.basisLinesFor({ applied_scope: {
    date: '2026-09-03', site_id: 's', author_folder: 'A', topic_row_id: 't',
    topic_title: 'T', dropped: [] } }), []);
  assert.deepStrictEqual(S.basisLinesFor({ applied_scope: { date: '2026-09-03' } }), []);
});

test('3e the line comes from the response, not the request', () => {
  const S = loadScope();
  /* Same request, two answers: the lines must differ, so they cannot have
     been built from the request. */
  const a = S.basisLinesFor({ applied_scope: { date: '2026-09-03', dropped: [] } });
  const b = S.basisLinesFor({ applied_scope: { dropped: [{ field: 'date', reason: 'invalid' }] } });
  assert.notDeepStrictEqual(a, b);
  assert.strictEqual(S.basisLinesFor.length, 1, 'basisLinesFor must take the response only');
});

/* ---- 5. suggestions and placeholder follow the scope --------------------- */

test('5a three contexts, three suggestion sets', () => {
  const S = loadScope();
  assert.deepStrictEqual(S.suggestionsFor(TOPIC),
    ['What was decided?', 'Who is responsible for follow-ups?', 'Were any risks flagged?']);
  assert.deepStrictEqual(S.suggestionsFor(DAY),
    ['What were the safety issues?', 'Which actions are still open?', 'What was decided?']);
  assert.deepStrictEqual(S.suggestionsFor({}),
    ['What happened this week?', 'Which actions are overdue?']);
});

test('5b three contexts, three placeholders', () => {
  const S = loadScope();
  assert.strictEqual(S.placeholderFor(TOPIC), 'Ask about this topic…');
  assert.strictEqual(S.placeholderFor(DAY), 'Ask about this day…');
  assert.strictEqual(S.placeholderFor({}), 'Ask across all your projects…');
});

test('5c no suggestion is the fixture scaffold question', () => {
  const S = loadScope();
  [TOPIC, DAY, {}].forEach(function (ctx) {
    S.suggestionsFor(ctx).concat([S.placeholderFor(ctx)]).forEach(function (s) {
      assert.ok(!/scaffold/i.test(s), s);
    });
  });
});

test('3f a duplicate {field, reason} in dropped renders only one line', () => {
  const S = loadScope();
  const out = S.basisLinesFor({ applied_scope: { dropped: [
    { field: 'site_id', reason: 'not_visible' },
    { field: 'site_id', reason: 'not_visible' },
  ] } });
  assert.deepStrictEqual(out, ["Couldn't narrow to this project"]);
});

/* ---- wiring: the helpers are what the component actually uses ----------- */

const askSrc = () => fs.readFileSync(require.resolve('../scripts/composites/ask-chat.js'), 'utf8');

/* What the driven tests below do not reach: the focus effect needs a DOM, and
   the two override props are one expression each. */
test('W4 focus and the suggestion/placeholder overrides are wired', () => {
  const src = askSrc();
  assert.match(src, /\[props\.focusNonce\]/);
  assert.match(src, /props\.suggestions \|\| suggestionsFor\(context\)/);
  assert.match(src, /props\.placeholder \|\| placeholderFor\(context\)/);
});

/* ---- driven: the component itself, rendered with a recording React ------

   Same approach as tests/ask-timezone-and-basis.test.js (a createElement that
   records nodes), extended with hooks that keep state between renders and
   effects that run the way React runs them: after a render, and only when
   their deps changed. Nothing here reads the source. */

function flushMicrotasks() {
  return new Promise(r => setImmediate(r));
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function mountAsk() {
  delete require.cache[require.resolve('../scripts/composites/ask-chat.js')];
  const h = { states: [], refs: [], effects: [], asks: [], pending: [] };
  let si = 0, ri = 0, ei = 0;
  global.React = {
    Fragment: 'Fragment',
    createElement(type, props, ...kids) { return { type, props: props || {}, kids }; },
    useState(init) {
      const i = si++;
      if (!(i in h.states)) h.states[i] = init;
      return [h.states[i], v => { h.states[i] = typeof v === 'function' ? v(h.states[i]) : v; }];
    },
    useRef(init) {
      const i = ri++;
      if (!(i in h.refs)) h.refs[i] = { current: init };
      return h.refs[i];
    },
    useEffect(fn, deps) {
      const i = ei++;
      const prev = h.effects[i];
      const changed = !prev || !deps || deps.some((d, k) => d !== prev.deps[k]);
      h.effects[i] = { fn, deps, changed };
    },
  };
  global.document = { addEventListener() {}, removeEventListener() {} };
  global.window = {
    FieldSight: { renderMarkdown: s => s },
    FS: { api: { ask: { ask(body) {
      h.asks.push(body);
      const d = deferred();
      h.pending.push(d);
      return d.promise;
    } } } },
  };
  require('../scripts/composites/ask-chat.js');
  const AskChat = global.window.FieldSight.AskChat;

  h.render = function (props) {
    si = 0; ri = 0; ei = 0;
    h.props = props;
    h.tree = AskChat(props);
    /* Attach a recording element to every ref the tree hands out, the way
       React fills refs before effects run. */
    h.nodes().forEach(n => {
      if (n.props.ref && n.props.ref.current == null) {
        n.props.ref.current = {
          scrollIntoView(o) { h.dom.scrolls.push(o); },
          focus(o) { h.dom.focuses.push(o); },
          querySelectorAll() { return []; },
        };
      }
    });
    h.effects.forEach(e => { if (e.changed) { e.changed = false; e.fn(); } });
    return h.tree;
  };
  h.dom = { scrolls: [], focuses: [] };
  /* Unmount: every hook slot is gone; the next render is a fresh mount. */
  h.unmount = () => { h.states = []; h.refs = []; h.effects = []; };
  h.rerender = () => h.render(h.props);
  h.nodes = function () {
    const out = [];
    (function walk(n) {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      out.push(n);
      n.kids.forEach(walk);
    })(h.tree);
    return out;
  };
  h.byClass = cls => h.nodes().filter(n =>
    String(n.props.className || '').split(' ').includes(cls));
  h.text = function (n) {
    return n.kids.map(function t(k) {
      if (Array.isArray(k)) return k.map(t).join('');
      if (k && typeof k === 'object') return h.text(k);
      return k == null || k === false ? '' : String(k);
    }).join('');
  };
  h.ask = async function (question) {
    h.byClass('fs-ask-chat__input')[0].props.onChange({ target: { value: question } });
    h.rerender();
    h.byClass('fs-ask-chat__form')[0].props.onSubmit({ preventDefault() {} });
    h.rerender();
  };
  h.settle = async function (i, res) {
    h.pending[i].resolve(res);
    for (let k = 0; k < 5; k++) await flushMicrotasks();
    h.rerender();
  };
  return h;
}

const SCOPED = { date: '2026-09-03', siteId: 's', siteName: 'UC PK', authorFolder: 'Ben' };
const segOf = (h, text) => h.byClass('fs-ask-chip__seg').find(n => h.text(n).startsWith(text));

test('D-a the request body is built from the context, and nothing else', async () => {
  let h = mountAsk();
  h.render({ user: 'Ben', context: { date: '2026-09-03', siteId: 's', authorFolder: 'Ben' } });
  await h.ask('what happened');
  assert.strictEqual(h.asks.length, 1);
  assert.deepStrictEqual(h.asks[0], { question: 'what happened', date: '2026-09-03',
    site_id: 's', author_folder: 'Ben', scoped: true, user: 'Ben' });
  assert.ok(!('scope' in h.asks[0]) && !('topic_id' in h.asks[0]));

  h = mountAsk();
  h.render({ user: 'Ben', context: {} });
  await h.ask('what happened');
  assert.deepStrictEqual(h.asks[0], { question: 'what happened', user: 'Ben' });
  assert.ok(!('scoped' in h.asks[0]), 'an unscoped Ask opted into scoping');
});

test('D-b chips and scope lines show what the backend enforced', async () => {
  let h = mountAsk();
  h.render({ user: 'Ben', context: SCOPED });
  await h.ask('q');
  await h.settle(0, { answer: 'a', citations: [], applied_scope: { date: '2026-09-03' } });
  const unenf = n => String(n.props.className).includes('fs-ask-chip__seg--unenforced');
  const srOnly = n => n.kids.some(k => k && k.props && k.props.className === 'fs-sr-only'
                                     && h.text(k) === ' (not applied)');
  assert.ok(!unenf(segOf(h, 'Thu 3 Sep')), 'the enforced date is marked not applied');
  ['UC PK', 'Ben'].forEach(t => {
    assert.ok(unenf(segOf(h, t)), t + ' is not marked unenforced');
    assert.ok(srOnly(segOf(h, t)), t + ' does not say "(not applied)" in words');
  });
  assert.ok(!srOnly(segOf(h, 'Thu 3 Sep')));
  assert.strictEqual(h.byClass('fs-ask-chat__scope-line').length, 0);

  h = mountAsk();
  h.render({ user: 'Ben', context: SCOPED });
  await h.ask('q');
  await h.settle(0, { answer: 'a', citations: [] });
  ['Thu 3 Sep', 'UC PK', 'Ben'].forEach(t =>
    assert.ok(unenf(segOf(h, t)), t + ' reads as scoped on a backend without applied_scope'));
  const nodes = h.nodes();
  const line = nodes.findIndex(n => n.props.className === 'fs-ask-chat__scope-line'
                                    && h.text(n) === 'Searched all your projects');
  const answer = nodes.findIndex(n => String(n.props.className).includes('fs-ask-chat__msg-text--md'));
  assert.ok(line > -1, 'no "Searched all your projects" line');
  assert.ok(answer > -1 && line < answer, 'the scope line is not above the answer');
});

test('D-c "Ask across everything" appears only when it means something, and re-asks unscoped', async () => {
  const widenAfter = async function (props, res) {
    const h = mountAsk();
    h.render(props);
    await h.ask('q');
    await h.settle(0, res);
    return h;
  };
  const spy = [];
  const onContextChange = c => spy.push(c);
  const EMPTY = { answer: 'a', citations: [], applied_scope: { date: '2026-09-03' } };

  assert.strictEqual((await widenAfter({ context: SCOPED }, EMPTY))
    .byClass('fs-ask-chat__widen').length, 0, 'shown without onContextChange');
  assert.strictEqual((await widenAfter({ context: SCOPED, onContextChange },
    Object.assign({}, EMPTY, { citations: [{ source_s3_key: 'reports/2026-09-03/Ben/x' }] })))
    .byClass('fs-ask-chat__widen').length, 0, 'shown with citations');
  assert.strictEqual((await widenAfter({ context: SCOPED, onContextChange },
    { answer: 'a', citations: [] }))
    .byClass('fs-ask-chat__widen').length, 0, 'shown on a backend that already searched everything');
  assert.strictEqual((await widenAfter({ context: {}, onContextChange }, EMPTY))
    .byClass('fs-ask-chat__widen').length, 0, 'shown on an unscoped question');

  const h = await widenAfter({ user: 'Ben', context: SCOPED, onContextChange }, EMPTY);
  const btn = h.byClass('fs-ask-chat__widen');
  assert.strictEqual(btn.length, 1);
  assert.strictEqual(h.text(btn[0]), 'Ask across everything');
  btn[0].props.onClick();
  assert.deepStrictEqual(spy, [{}]);
  h.render({ user: 'Ben', context: {}, onContextChange });
  assert.strictEqual(h.asks.length, 2, 'the question was not asked again');
  assert.deepStrictEqual(h.asks[1], { question: 'q', user: 'Ben' });
});

test('D-d a scope key change clears the history; a user change does not', async () => {
  for (const key of ['date', 'siteId', 'authorFolder']) {
    const h = mountAsk();
    h.render({ user: 'Ben', context: SCOPED });
    await h.ask('q');
    await h.settle(0, { answer: 'a', citations: [], applied_scope: {} });
    assert.ok(h.byClass('fs-ask-chat__msg--user').length === 1);
    h.render({ user: 'Ben', context: Object.assign({}, SCOPED, { [key]: 'changed' }) });
    h.rerender();
    assert.strictEqual(h.byClass('fs-ask-chat__msg').length, 0, key + ' change kept the history');
  }
  const h = mountAsk();
  h.render({ user: 'Ben', context: SCOPED });
  await h.ask('q');
  await h.settle(0, { answer: 'a', citations: [], applied_scope: {} });
  h.render({ user: 'Someone', context: Object.assign({}, SCOPED) });
  h.rerender();
  assert.strictEqual(h.byClass('fs-ask-chat__msg--assistant').length, 1, 'a user change cleared the history');
});

test('D-e a response to an old context is dropped, but the wait still ends', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: SCOPED });
  await h.ask('q');
  assert.strictEqual(h.byClass('fs-ask-chat__msg--pending').length, 1);
  h.render({ user: 'Ben', context: Object.assign({}, SCOPED, { date: '2026-09-04' }) });
  await h.settle(0, { answer: 'stale', citations: [], applied_scope: {} });
  assert.strictEqual(h.byClass('fs-ask-chat__msg').length, 0, 'the stale answer was appended');
  assert.ok(!h.byClass('fs-ask-chip__seg').some(n =>
    String(n.props.className).includes('--unenforced')), 'the chips read the stale answer');
  assert.strictEqual(h.byClass('fs-ask-chat__input')[0].props.disabled, false, 'busy never cleared');

  /* The error path is dropped the same way. */
  const e = mountAsk();
  e.render({ context: SCOPED });
  await e.ask('q');
  e.render({ context: {} });
  e.pending[0].reject(new Error('boom'));
  for (let k = 0; k < 5; k++) await flushMicrotasks();
  e.rerender();
  assert.strictEqual(e.byClass('fs-ask-chat__msg').length, 0, 'the stale error was appended');
  assert.strictEqual(e.byClass('fs-ask-chat__input')[0].props.disabled, false);
});

test('D-f a widen that lands mid-request is sent once the request settles', async () => {
  const onContextChange = () => {};
  const h = mountAsk();
  h.render({ user: 'Ben', context: SCOPED, onContextChange });
  await h.ask('first');
  await h.settle(0, { answer: 'a', citations: [], applied_scope: { date: '2026-09-03' } });
  h.byClass('fs-ask-chat__widen')[0].props.onClick();
  /* The host is slow to apply it; the reader asks something else meanwhile. */
  await h.ask('second');
  h.render({ user: 'Ben', context: {}, onContextChange });
  assert.strictEqual(h.asks.length, 2, 'sent while busy (it would have been dropped)');
  await h.settle(1, { answer: 'b', citations: [] });
  assert.strictEqual(h.asks.length, 3, 'the widen was dropped');
  assert.deepStrictEqual(h.asks[2], { question: 'first', user: 'Ben' });
  /* The resend must clear its own ref: settling the resent request must not
     fire it again. Rerender first so the harness's effect deps observe
     busy flip back to true (the resend itself put a new request in flight)
     before it flips to false again on settle. */
  h.rerender();
  await h.settle(2, { answer: 'c', citations: [] });
  assert.strictEqual(h.asks.length, 3, 'a never-cleared deferred resend fired again');
});

test('D-g a widen the host did not apply never fires on a later change', async () => {
  const onContextChange = () => {};
  const h = mountAsk();
  h.render({ user: 'Ben', context: SCOPED, onContextChange });
  await h.ask('first');
  await h.settle(0, { answer: 'a', citations: [], applied_scope: { date: '2026-09-03' } });
  h.byClass('fs-ask-chat__widen')[0].props.onClick();
  /* The host moved to another day instead of clearing the scope. */
  h.render({ user: 'Ben', context: Object.assign({}, SCOPED, { date: '2026-09-05' }), onContextChange });
  assert.strictEqual(h.asks.length, 1, 'the widen fired into a scoped context');
  h.render({ user: 'Ben', context: {}, onContextChange });
  assert.strictEqual(h.asks.length, 1, 'a stale widen fired on a later, unrelated change');
});

test('D-i a focus request fires once; a remount with the same nonce does not refire it', () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: SCOPED, focusNonce: 0 });
  assert.strictEqual(h.dom.scrolls.length + h.dom.focuses.length, 0, 'focused on a plain mount');

  h.render({ user: 'Ben', context: SCOPED, focusNonce: 1 });
  assert.strictEqual(h.dom.scrolls.length, 1, 'a nonce bump did not scroll the Ask into view');
  assert.strictEqual(h.dom.focuses.length, 1, 'a nonce bump did not focus the input');
  assert.strictEqual(h.dom.scrolls[0].behavior, 'smooth');

  h.rerender();
  assert.strictEqual(h.dom.scrolls.length, 1, 'a rerender with the same nonce scrolled again');

  /* Day change / refetch: the middle column unmounts AskChat and mounts it
     again, while the Provider still holds nonce 1. */
  h.unmount();
  h.render({ user: 'Ben', context: SCOPED, focusNonce: 1 });
  assert.strictEqual(h.dom.scrolls.length, 1, 'a remount with an old nonce scrolled the page');
  assert.strictEqual(h.dom.focuses.length, 1, 'a remount with an old nonce focused the input');

  /* The remounted Ask still answers a new request. */
  h.render({ user: 'Ben', context: SCOPED, focusNonce: 2 });
  assert.strictEqual(h.dom.focuses.length, 2, 'a new request after a remount was ignored');
});

test('D-h the chip remove button names what it removes', async () => {
  const h = mountAsk();
  h.render({ context: Object.assign({}, SCOPED, { topicRowId: 't', topicTitle: 'Crane' }),
             onContextChange() {} });
  const labels = h.byClass('fs-ask-chip__remove').map(n => n.props['aria-label']);
  assert.deepStrictEqual(labels, ['Remove scope: Thu 3 Sep · UC PK · Ben', 'Remove scope: Topic: Crane']);
});

test('D-j selecting a topic adds topic_row_id to the next request and keeps the prior messages', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: SCOPED });
  await h.ask('first question');
  await h.settle(0, { answer: 'a', citations: [], applied_scope: {} });
  assert.strictEqual(h.byClass('fs-ask-chat__msg--user').length, 1);
  assert.strictEqual(h.byClass('fs-ask-chat__msg--assistant').length, 1);

  h.render({ user: 'Ben', context: Object.assign({}, SCOPED, { topicRowId: 't', topicTitle: 'Crane' }) });
  h.rerender();
  assert.strictEqual(h.byClass('fs-ask-chat__msg--user').length, 1, 'the prior question was dropped');
  assert.strictEqual(h.byClass('fs-ask-chat__msg--assistant').length, 1, 'the prior answer was dropped');
  const dividers = h.byClass('fs-ask-chat__msg--divider');
  assert.strictEqual(dividers.length, 1, 'no divider, or more than one');
  assert.strictEqual(h.text(dividers[0]), 'Now asking about: Crane');

  await h.ask('second question');
  assert.strictEqual(h.asks[1].topic_row_id, 't');
});

test('D-k deselecting adds a divider and drops topic_row_id', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: Object.assign({}, SCOPED, { topicRowId: 't', topicTitle: 'Crane' }) });
  await h.ask('first question');
  await h.settle(0, { answer: 'a', citations: [], applied_scope: {} });

  h.render({ user: 'Ben', context: SCOPED });
  h.rerender();
  const dividers = h.byClass('fs-ask-chat__msg--divider');
  assert.strictEqual(dividers.length, 1);
  assert.strictEqual(h.text(dividers[0]), 'Now asking about the whole day');

  await h.ask('second question');
  assert.ok(!('topic_row_id' in h.asks[1]), 'topic_row_id survived deselection');
});

test('D-l a date/site/owner change still clears the conversation and appends no divider', async () => {
  for (const key of ['date', 'siteId', 'authorFolder']) {
    const h = mountAsk();
    h.render({ user: 'Ben', context: Object.assign({}, SCOPED, { topicRowId: 't', topicTitle: 'Crane' }) });
    await h.ask('q');
    await h.settle(0, { answer: 'a', citations: [], applied_scope: {} });
    h.render({ user: 'Ben', context: Object.assign({}, SCOPED,
      { topicRowId: 't', topicTitle: 'Crane', [key]: 'changed' }) });
    h.rerender();
    assert.strictEqual(h.byClass('fs-ask-chat__msg').length, 0,
      key + ' change left a message or a divider behind');
  }
});

test('D-m a late answer from the pre-switch scope is not appended after a topic switch', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: SCOPED });
  await h.ask('first question');
  assert.strictEqual(h.byClass('fs-ask-chat__msg--pending').length, 1);

  h.render({ user: 'Ben', context: Object.assign({}, SCOPED, { topicRowId: 't', topicTitle: 'Crane' }) });
  h.rerender();

  await h.settle(0, { answer: 'a', citations: [], applied_scope: {} });

  assert.strictEqual(h.byClass('fs-ask-chat__msg--assistant').length, 0, 'the stale answer was appended');
  assert.strictEqual(h.byClass('fs-ask-chat__msg--user').length, 1, 'the original question is gone');
  const dividers = h.byClass('fs-ask-chat__msg--divider');
  assert.strictEqual(dividers.length, 1, 'the divider from the switch is gone');
  assert.strictEqual(h.byClass('fs-ask-chat__input')[0].props.disabled, false, 'busy never cleared');
});

test('D-n a day change that also changes the topic appends no divider', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: Object.assign({}, SCOPED, { topicRowId: 't', topicTitle: 'Crane' }) });
  await h.ask('q');
  await h.settle(0, { answer: 'a', citations: [], applied_scope: {} });

  h.render({ user: 'Ben', context: Object.assign({}, SCOPED, { date: '2026-09-04' }) });
  h.rerender();
  assert.strictEqual(h.byClass('fs-ask-chat__msg').length, 0,
    'a divider or message survived a same-commit day+topic change');
});

test('D-q a topic-only change still appends a divider after an EARLIER day-only change', async () => {
  const h = mountAsk();
  /* 1. mount on day A, no topic; ask; answer arrives. */
  h.render({ user: 'Ben', context: SCOPED });
  await h.ask('first question');
  await h.settle(0, { answer: 'a', citations: [], applied_scope: {} });
  assert.strictEqual(h.byClass('fs-ask-chat__msg--user').length, 1);
  assert.strictEqual(h.byClass('fs-ask-chat__msg--assistant').length, 1);

  /* 2. change to day B: the day effect clears (deps [date] changed); the
     topic effect does NOT run (topicRowId is still undefined). */
  const DAY_B = Object.assign({}, SCOPED, { date: '2026-09-04' });
  h.render({ user: 'Ben', context: DAY_B });
  h.rerender();
  assert.strictEqual(h.byClass('fs-ask-chat__msg').length, 0, 'day change did not clear');

  /* 3. ask again on day B; answer arrives. */
  await h.ask('second question');
  await h.settle(1, { answer: 'b', citations: [], applied_scope: {} });
  assert.strictEqual(h.byClass('fs-ask-chat__msg--user').length, 1);
  assert.strictEqual(h.byClass('fs-ask-chat__msg--assistant').length, 1);

  /* 4. change ONLY the topic -- the topic effect finally runs. It must
     compare the CURRENT day key against the day key as of THIS commit, not
     a bookmark from whenever it last happened to run (day A). */
  h.render({ user: 'Ben', context: Object.assign({}, DAY_B, { topicRowId: 't', topicTitle: 'Crane' }) });
  h.rerender();

  assert.strictEqual(h.byClass('fs-ask-chat__msg--user').length, 1, 'the prior question was lost');
  assert.strictEqual(h.byClass('fs-ask-chat__msg--assistant').length, 1, 'the prior answer was lost');
  const dividers = h.byClass('fs-ask-chat__msg--divider');
  assert.strictEqual(dividers.length, 1,
    'a topic-only change after an earlier day-only change dropped the divider');
  assert.strictEqual(h.text(dividers[0]), 'Now asking about: Crane');
});

/* ---- Timeline --------------------------------------------------------- */

function makeReactStub(extra) {
  return Object.assign({
    createElement(type, props) {
      const kids = Array.prototype.slice.call(arguments, 2);
      const flat = [].concat.apply([], kids).filter(k => k !== null && k !== undefined && k !== false);
      return { type: type, props: props || {}, children: flat };
    },
    useState(v) { return [typeof v === 'function' ? v() : v, function () {}]; },
    useRef(v) { return { current: v }; },
    useEffect() {}, useLayoutEffect() {}, useContext() { return null; },
    useMemo(fn) { return fn(); }, useCallback(fn) { return fn; },
    Fragment: 'Fragment', memo(c) { return c; },
  }, extra || {});
}

function loadTimeline(reactExtra) {
  global.React = makeReactStub(reactExtra);
  global.window = {
    FieldSight: {},
    FS: { api: { folderName: n => String(n || '').trim().replace(/ /g, '_') } },
    AuthMock: { currentUser: null },
    location: { href: 'https://example.test/#/timeline' },
    addEventListener() {}, removeEventListener() {},
  };
  global.document = { addEventListener() {}, removeEventListener() {},
                      createElement() { return { style: {} }; } };
  delete require.cache[require.resolve('../scripts/pages/timeline.js')];
  const mod = require('../scripts/pages/timeline.js');
  return { mod: mod, page: global.window.FieldSight.PAGES['/timeline'] };
}

const timelineSrc = () => fs.readFileSync(require.resolve('../scripts/pages/timeline.js'), 'utf8');

/* ---- 6. one Ask on the page ------------------------------------------ */

test('6a the topic detail tabs have no ask tab', () => {
  const { mod } = loadTimeline();
  assert.ok(Array.isArray(mod.DAILY_TABS) && Array.isArray(mod.MEETING_TABS), 'tabs not exported');
  assert.ok(!mod.DAILY_TABS.some(t => t.key === 'ask'), 'DAILY_TABS still has ask');
  assert.ok(!mod.MEETING_TABS.some(t => t.key === 'ask'), 'MEETING_TABS still has ask');
});

test('6b the page registers a Provider', () => {
  const { page } = loadTimeline();
  assert.strictEqual(typeof page.Provider, 'function');
  assert.strictEqual(typeof page.Middle, 'function');
  assert.strictEqual(typeof page.Right, 'function');
});

test('6c the Provider holds only the ask fields', () => {
  const { page } = loadTimeline({ createContext() { return { Provider: 'AskCtxProvider' }; } });
  const el = page.Provider({ children: 'kids' });
  assert.strictEqual(el.type, 'AskCtxProvider');
  assert.deepStrictEqual(Object.keys(el.props.value).sort(),
    ['askContext', 'askFocusNonce', 'hasAsk', 'requestAskFocus', 'setAskContext', 'setHasAsk']);
  assert.strictEqual(el.props.value.hasAsk, false, 'a fresh page claims an Ask is mounted');
});

test('6e outside a Provider there is no Ask to point a topic button at', () => {
  const { mod } = loadTimeline();
  assert.strictEqual(mod.useTimelineAsk().hasAsk, false);
});

test('6d exactly one AskChat mount remains in timeline.js', () => {
  const mounts = timelineSrc().match(/React\.createElement\(AskChat\b/g) || [];
  assert.strictEqual(mounts.length, 1, 'found ' + mounts.length + ' AskChat mounts');
});

/* ---- 7. Ask about this topic ------------------------------------------ */

test('7a the button is hidden for a topic without topic_row_id', () => {
  const { mod } = loadTimeline();
  assert.strictEqual(mod.TopicAskButton({ topic: { topic_id: 2 }, hasAsk: true, onAsk() {} }), null);
  assert.strictEqual(mod.TopicAskButton({ topic: null, hasAsk: true, onAsk() {} }), null);
});

test('7a2 the button is hidden when no Ask is mounted (aggregated site view)', () => {
  const { mod } = loadTimeline();
  assert.strictEqual(mod.topicAskVisible(true, { topic_row_id: 't' }), true);
  assert.strictEqual(mod.topicAskVisible(false, { topic_row_id: 't' }), false);
  assert.strictEqual(mod.topicAskVisible(undefined, { topic_row_id: 't' }), false);
  assert.strictEqual(mod.topicAskVisible(true, { topic_id: 2 }), false);
  /* Driven through the component, not only the helper. */
  assert.strictEqual(mod.TopicAskButton({ topic: { topic_row_id: 't' }, hasAsk: false, onAsk() {} }), null,
    'a topic button rendered with no Ask on the page');
});

test('7a3 AskPresence publishes hasAsk for exactly as long as it is mounted', () => {
  const effects = [];
  const { mod } = loadTimeline({ useEffect(fn) { effects.push(fn); } });
  const seen = [];
  assert.strictEqual(mod.AskPresence({ setHasAsk: v => seen.push(v) }), null);
  assert.strictEqual(effects.length, 1);
  const cleanup = effects[0]();
  assert.deepStrictEqual(seen, [true], 'mounting the Ask did not publish hasAsk');
  assert.strictEqual(typeof cleanup, 'function', 'unmounting the Ask would leave hasAsk true');
  cleanup();
  assert.deepStrictEqual(seen, [true, false]);
});

test('7a4 the presence marker sits next to the one AskChat mount', () => {
  const src = timelineSrc();
  const at = src.indexOf('React.createElement(AskChat,');
  const before = src.slice(at - 200, at);
  assert.match(before, /React\.createElement\(AskPresence, \{ setHasAsk: askApi\.setHasAsk \}\)/);
  const right = src.slice(src.indexOf('function TimelineRightDetail('), src.indexOf('/* ---------- Register'));
  assert.match(right, /hasAsk: askApi\.hasAsk/, 'the topic button is not told whether an Ask exists');
});

test('7b the button renders and clicking it calls onAsk', () => {
  const { mod } = loadTimeline();
  let clicked = 0;
  const el = mod.TopicAskButton({ topic: { topic_row_id: 't' }, hasAsk: true, onAsk() { clicked++; } });
  assert.strictEqual(el.type, 'button');
  assert.deepStrictEqual(el.children, ['Ask about this topic']);
  el.props.onClick();
  assert.strictEqual(clicked, 1);
});

test('7c pinning sets topicRowId on the current day and bumps the focus nonce', () => {
  const { mod } = loadTimeline();
  const api = {
    askContext: DAY, askFocusNonce: 4, set: null,
    setAskContext(next) { this.set = next; },
    requestAskFocus() { this.askFocusNonce++; },
  };
  const ok = mod.pinTopicAsk(api,
    { topic_row_id: 'topic-uuid', topic_title: 'Morning commercial chase' },
    { date: '2026-09-03', authorFolder: 'Ben_UCPK2' });
  assert.strictEqual(ok, true);
  assert.strictEqual(api.set.topicRowId, 'topic-uuid');
  assert.strictEqual(api.set.topicTitle, 'Morning commercial chase');
  assert.strictEqual(api.set.siteName, 'UC PK', 'the current day scope is kept');
  assert.strictEqual(api.askFocusNonce, 5);
});

test('7d pinning from an empty or other-day context uses the topic\'s own day', () => {
  const { mod } = loadTimeline();
  const dayCtx = { date: '2026-09-04', authorFolder: 'Ben_UCPK2' };
  assert.deepStrictEqual(mod.askContextWithTopic({}, { topic_row_id: 't', topic_title: 'T' }, dayCtx),
    { date: '2026-09-04', authorFolder: 'Ben_UCPK2', topicRowId: 't', topicTitle: 'T' });
  assert.strictEqual(mod.askContextWithTopic(DAY, { topic_row_id: 't' }, dayCtx).date, '2026-09-04');
  assert.strictEqual(mod.askContextWithTopic(DAY, { topic_id: 1 }, dayCtx), null);
});

test('7d2 the current scope is kept only when it is the topic\'s own day, owner and site', () => {
  const { mod } = loadTimeline();
  const T = { topic_row_id: 't', topic_title: 'T' };
  /* Same date, another owner: the topic's owner wins. */
  const otherOwner = mod.askContextWithTopic(DAY, T, { date: '2026-09-03', authorFolder: 'Someone' });
  assert.strictEqual(otherOwner.authorFolder, 'Someone');
  assert.ok(!('siteName' in otherOwner), 'the other owner\'s site leaked into the topic scope');
  /* Same date and owner, another site (both known): the topic's site wins. */
  const otherSite = mod.askContextWithTopic(DAY, T,
    { date: '2026-09-03', authorFolder: 'Ben_UCPK2', siteId: 'other-site' });
  assert.strictEqual(otherSite.siteId, 'other-site');
  /* Same date, owner and site: the current scope (with its site name) is kept. */
  const same = mod.askContextWithTopic(DAY, T,
    { date: '2026-09-03', authorFolder: 'Ben_UCPK2', siteId: 'site-uuid' });
  assert.strictEqual(same.siteName, 'UC PK');
  /* Site known on one side only is not a mismatch. */
  assert.strictEqual(mod.askContextWithTopic(DAY, T,
    { date: '2026-09-03', authorFolder: 'Ben_UCPK2' }).siteName, 'UC PK');
});

test('7e the topic detail header mounts the button; selecting a topic does not touch the context', () => {
  const src = timelineSrc();
  const right = src.slice(src.indexOf('function TimelineRightDetail('), src.indexOf('/* ---------- Register'));
  assert.match(right, /React\.createElement\(TopicAskButton/);
  assert.match(right, /pinTopicAsk\(/);
  /* Only the button changes the Ask context from this column. */
  assert.strictEqual((right.match(/setAskContext\(/g) || []).length, 0,
    'the right detail must go through pinTopicAsk, not set the context on selection');
});

/* ---- 8. day changes reset; palette hand-off is global ------------------ */

test('8a the loaded day builds a fresh context: no topic survives a day change', () => {
  const { mod } = loadTimeline();
  const report = { site_id: 'site-uuid', site: 'UC PK', user_name: 'Ben UCPK2' };
  const ctx = mod.askContextForLoadedDay(report, '2026-09-04', 'Ben_UCPK2', false);
  assert.deepStrictEqual(ctx, { date: '2026-09-04', siteId: 'site-uuid', siteName: 'UC PK',
    authorFolder: 'Ben_UCPK2', authorName: 'Ben UCPK2' });
  assert.ok(!('topicRowId' in ctx));
});

test('8b without report.site_id the site is omitted; owner falls back to the report name', () => {
  const { mod } = loadTimeline();
  const ctx = mod.askContextForDay({ site: 'UC PK', user_name: 'Ben UCPK2' }, '2026-09-03', undefined);
  assert.deepStrictEqual(ctx, { date: '2026-09-03', authorFolder: 'Ben_UCPK2', authorName: 'Ben UCPK2' });
  assert.deepStrictEqual(mod.askContextForDay(null, '2026-09-03', 'Ben_UCPK2'),
    { date: '2026-09-03', authorFolder: 'Ben_UCPK2' });
});

test('8b2 a site_id with an empty site name is omitted; with a site name both are present', () => {
  const { mod } = loadTimeline();
  const noName = mod.askContextForDay({ site_id: 'site-uuid', site: '', user_name: 'Ben UCPK2' },
    '2026-09-03', undefined);
  assert.ok(!('siteId' in noName), 'siteId set without a visible site name');
  assert.ok(!('siteName' in noName));

  const both = mod.askContextForDay({ site_id: 'site-uuid', site: 'UC PK', user_name: 'Ben UCPK2' },
    '2026-09-03', undefined);
  assert.strictEqual(both.siteId, 'site-uuid');
  assert.strictEqual(both.siteName, 'UC PK');
});

test('8c a question handed off from the palette stays global', () => {
  const { mod } = loadTimeline();
  assert.deepStrictEqual(
    mod.askContextForLoadedDay({ site_id: 's', site: 'UC PK', user_name: 'B' }, '2026-09-03', 'B', true),
    {});
});

test('8d the middle column wires the day reset and the palette rule', () => {
  const src = timelineSrc();
  const mid = src.slice(src.indexOf('function TimelineMiddleColumn('), src.indexOf('function SessionPicker('));
  assert.match(mid, /React\.useRef\(!!askPrefill\)/, 'palette hand-off is not remembered');
  assert.match(mid, /askContextForLoadedDay\(/);
  const eff = mid.slice(mid.indexOf('askContextForLoadedDay('));
  const deps = eff.slice(eff.indexOf('}, [') , eff.indexOf(']);') + 1);
  assert.match(deps, /\bdate\b/, 'day change does not reset the context');
  assert.match(deps, /askOwner/, 'owner change does not reset the context');
  assert.match(mid, /askFromPaletteRef\.current \? \{\} : askApi\.askContext/,
    'mount #1 can auto-send a palette question with a stale scope');
  assert.match(mid, /dayKey === askDayKeyRef\.current\) return;/,
    'the reset does not compare against the last applied day');
});

test('8f a refetch of the same day keeps a pinned topic; a real day change resets', () => {
  const { mod } = loadTimeline();
  const k = mod.askDayResetKey;
  assert.strictEqual(k('loading', '2026-09-03', 'Ben', 's'), null, 'a loading render reset the scope');
  const applied = k('ok', '2026-09-03', 'Ben', 's');
  /* loading → ok on the same day (content edit refresh, retry). */
  assert.strictEqual(k('ok', '2026-09-03', 'Ben', 's'), applied, 'a refetch rebuilt the day and dropped the topic');
  assert.notStrictEqual(k('ok', '2026-09-04', 'Ben', 's'), applied, 'a date change kept the old scope');
  assert.notStrictEqual(k('ok', '2026-09-03', 'Someone', 's'), applied, 'an owner change kept the old scope');
  assert.notStrictEqual(k('ok', '2026-09-03', 'Ben', 'other'), applied, 'a site change kept the old scope');
  /* A missing site reads the same whether it came as false, undefined or ''. */
  assert.strictEqual(k('ok', '2026-09-03', 'Ben', false), k('ok', '2026-09-03', 'Ben', undefined));
});

test('8e the palette mount passes no scope, no context and no suggestions', () => {
  const src = fs.readFileSync(require.resolve('../scripts/composites/search-palette.js'), 'utf8');
  const at = src.indexOf('React.createElement(window.FieldSight.AskChat');
  assert.ok(at > 0, 'palette AskChat mount not found');
  const mount = src.slice(at, src.indexOf('}),', at));
  assert.doesNotMatch(mount, /\bscope:/);
  assert.doesNotMatch(mount, /\bcontext:/);
  assert.doesNotMatch(mount, /\bsuggestions:/);
  assert.doesNotMatch(mount, /\btopic_id:/);
});
