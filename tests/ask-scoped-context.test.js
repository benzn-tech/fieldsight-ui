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
test('W4 the suggestion/placeholder overrides are wired', () => {
  const src = askSrc();
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

test('D-o suggestions are absent until the input is focused', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: SCOPED, variant: 'dock' });
  assert.strictEqual(h.byClass('fs-ask-chat__suggestion').length, 0,
    'the dock showed suggestions before the input was focused');

  h.byClass('fs-ask-chat__input')[0].props.onFocus();
  h.rerender();
  assert.strictEqual(h.byClass('fs-ask-chat__suggestion').length, 3,
    'focusing the input did not reveal the suggestions');

  await h.ask('what happened');
  assert.strictEqual(h.byClass('fs-ask-chat__suggestion').length, 0,
    'suggestions stayed once there was history, even though the input is still focused');

  /* The non-dock (search palette) mount must be byte-for-byte unaffected:
     suggestions still show on an empty log without focus (spec 2026-09-16
     §5 -- `focused` only narrows the dock's rule, it never widens anyone
     else's). */
  const p = mountAsk();
  p.render({ user: 'Ben', context: SCOPED });
  assert.strictEqual(p.byClass('fs-ask-chat__suggestion').length, 3,
    'the palette mount regressed: it now requires focus for suggestions');
});

test('D-p the message log is not rendered until there is something in it', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: SCOPED, variant: 'dock' });
  assert.strictEqual(h.byClass('fs-ask-chat__overlay').length, 0,
    'the dock rendered an overlay with nothing in it');

  await h.ask('what happened');
  assert.strictEqual(h.byClass('fs-ask-chat__overlay').length, 1,
    'asking a question did not open the overlay');
});

test('D-r focusing the input after Hide does not reopen the overlay; sending a new question does', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: SCOPED, variant: 'dock' });
  await h.ask('first question');
  await h.settle(0, { answer: 'a', citations: [], applied_scope: {} });
  assert.strictEqual(h.byClass('fs-ask-chat__overlay').length, 1, 'the answer did not open the overlay');

  h.byClass('fs-ask-chat__overlay-close')[0].props.onClick();
  h.rerender();
  assert.strictEqual(h.byClass('fs-ask-chat__overlay').length, 0, 'Hide did not close the overlay');

  h.byClass('fs-ask-chat__input')[0].props.onFocus();
  h.rerender();
  assert.strictEqual(h.byClass('fs-ask-chat__overlay').length, 0,
    'focusing the input after Hide reopened the overlay over the topic list');

  await h.ask('second question');
  assert.strictEqual(h.byClass('fs-ask-chat__overlay').length, 1,
    'sending a new question did not reopen the overlay');
});

/* M3 -- the suggestion row's onMouseDown preventDefault is what stops the
   input's blur from hiding the row before a click on a suggestion lands.
   Nothing in this harness fires a real blur on mousedown (there is no DOM,
   `onBlur` is only ever invoked directly by a test), so a test that just
   focuses, clicks a suggestion and asserts the question was sent would pass
   identically whether or not the preventDefault call is there -- it proves
   nothing about the guard it is meant to cover. Kept anyway as a basic
   regression for "clicking a suggestion sends it"; D-t below is the test
   that can actually go red on this specific guard, because it drives the
   handler itself rather than a downstream effect this harness can't
   reproduce. */
test('D-s clicking a suggestion after focusing the input sends it (does not exercise the blur race)', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: SCOPED, variant: 'dock' });
  h.byClass('fs-ask-chat__input')[0].props.onFocus();
  h.rerender();
  const btn = h.byClass('fs-ask-chat__suggestion')[0];
  assert.ok(btn, 'no suggestion button rendered while the input is focused');
  const question = h.text(btn);
  btn.props.onMouseDown({ preventDefault() {} });
  btn.props.onClick();
  assert.strictEqual(h.asks.length, 1, 'clicking the suggestion did not send it');
  assert.strictEqual(h.asks[0].question, question);
});

/* The guard itself, pinned directly: every rendered suggestion button's
   onMouseDown handler calls preventDefault when invoked. This is weaker
   than proving the row survives a real mousedown-then-blur-then-click
   sequence (this harness has no DOM and cannot reproduce that race), but
   unlike D-s it does drive the actual handler and fails if the
   preventDefault call is removed -- verified by temporarily deleting it and
   re-running this file (see task-3-fix-report.md). */
test('D-t every suggestion button prevents default on mousedown, so a blur cannot hide the row first', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: SCOPED, variant: 'dock' });
  h.byClass('fs-ask-chat__input')[0].props.onFocus();
  h.rerender();
  const buttons = h.byClass('fs-ask-chat__suggestion');
  assert.ok(buttons.length > 0, 'no suggestion buttons rendered to check');
  buttons.forEach(function (btn) {
    assert.strictEqual(typeof btn.props.onMouseDown, 'function',
      'a suggestion button has no onMouseDown handler');
    let prevented = false;
    btn.props.onMouseDown({ preventDefault() { prevented = true; } });
    assert.ok(prevented,
      'onMouseDown did not call preventDefault -- the blur-before-click trap is back');
  });
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

test('6b the page registers a Provider, a Middle, a Right and a Footer', () => {
  const { page } = loadTimeline();
  assert.strictEqual(typeof page.Provider, 'function');
  assert.strictEqual(typeof page.Middle, 'function');
  assert.strictEqual(typeof page.Right, 'function');
  assert.strictEqual(typeof page.Footer, 'function',
    'the dock is not registered as the page Footer, so nothing mounts it');
});

test('6c the Provider holds only the ask fields', () => {
  const { page } = loadTimeline({ createContext() { return { Provider: 'AskCtxProvider' }; } });
  const el = page.Provider({ children: 'kids' });
  assert.strictEqual(el.type, 'AskCtxProvider');
  assert.deepStrictEqual(Object.keys(el.props.value).sort(),
    ['askContext', 'askReady', 'setAskContext', 'setAskReady']);
});

test('6e outside a Provider there is no hasAsk to gate on', () => {
  const { mod } = loadTimeline();
  const api = mod.useTimelineAsk();
  assert.ok(!('hasAsk' in api), 'hasAsk still exists outside a Provider');
  assert.doesNotThrow(() => api.setAskContext({}));
});

test('6d exactly one AskChat mount remains, and it is inside the dock', () => {
  const src = timelineSrc();
  const mounts = src.match(/React\.createElement\(AskChat\b/g) || [];
  assert.strictEqual(mounts.length, 1, 'found ' + mounts.length + ' AskChat mounts');
  const start = src.indexOf('function TimelineAskDock(');
  assert.ok(start > 0, 'function TimelineAskDock( not found');
  const end = src.indexOf('\n  function ', start + 1);
  assert.ok(end > start, 'no module-level function follows TimelineAskDock');
  assert.match(src.slice(start, end), /React\.createElement\(AskChat\b/,
    'the one AskChat mount is not inside TimelineAskDock');
});

test('6f nothing exported names a deleted function', () => {
  const { mod } = loadTimeline();
  Object.values(mod).forEach(v => assert.ok(v !== undefined));
});

test('6g the right detail no longer pins anything', () => {
  const src = timelineSrc();
  const right = src.slice(src.indexOf('function TimelineRightDetail('), src.indexOf('/* ---------- Register'));
  assert.doesNotMatch(right, /TopicAskButton/);
  assert.doesNotMatch(right, /pinTopicAsk\(/);
  assert.doesNotMatch(right, /hasAsk/);
  assert.strictEqual((right.match(/setAskContext\(/g) || []).length, 0,
    'the right detail must not set the context on selection');
});

test('6h useTimelineAsk outside a Provider is inert and complete', () => {
  const { mod } = loadTimeline();
  assert.deepStrictEqual(Object.keys(mod.useTimelineAsk()).sort(),
    ['askContext', 'askReady', 'setAskContext', 'setAskReady']);
});

/* ---- 7. topic scope helpers -------------------------------------------- */

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

/* ---- 8. day changes reset; palette hand-off is global ------------------ */

test('8a the loaded day builds a fresh context: no topic survives a day change', () => {
  const { mod } = loadTimeline();
  const report = { site_id: 'site-uuid', site: 'UC PK', user_name: 'Ben UCPK2' };
  const ctx = mod.askContextForDay(report, '2026-09-04', 'Ben_UCPK2');
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

/* 8c ("a question handed off from the palette stays global") is deleted: the
   palette rule moved out of askContextForLoadedDay (deleted with it) and into
   the dock itself, where 9c now pins it. */

test('8d the middle column still resets the day scope, and no longer owns the palette', () => {
  const src = timelineSrc();
  const mid = src.slice(src.indexOf('function TimelineMiddleColumn('), src.indexOf('function SessionPicker('));
  assert.match(mid, /askContextForDay\(/);
  const eff = mid.slice(mid.indexOf('askContextForDay('));
  const deps = eff.slice(eff.indexOf('}, [') , eff.indexOf(']);') + 1);
  assert.match(deps, /\bdate\b/, 'day change does not reset the context');
  assert.match(deps, /askOwner/, 'owner change does not reset the context');
  assert.match(mid, /dayKey === askDayKeyRef\.current\) return;/,
    'the reset does not compare against the last applied day');
  /* The palette hand-off moved into the dock. As a Footer SIBLING the dock
     first renders (and AskChat auto-sends) without this column's day-reset
     effect having any way to reach it in time, so a flag read or published
     here would arrive one commit too late and scope the question to the day. */
  assert.doesNotMatch(mid, /fs\.ask\.prefill/,
    'the middle column still reads the palette prefill');
  assert.doesNotMatch(mid, /askFromPaletteRef/,
    'the middle column still carries the palette flag');
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

/* ---- 9. the docked Ask (spec 2026-09-16 §1, §4) ----------------------- */

const DOCK_DAY = { date: '2026-09-03', siteId: 'site-uuid', siteName: 'UC PK',
                   authorFolder: 'Ben_UCPK2', authorName: 'Ben UCPK2' };

/* The dock reads its scope through useTimelineAsk(), so drive it with a stub
   context rather than a real Provider: the module only builds a context when
   React.createContext exists, so both overrides are needed together.

   `askReady` is the middle column's published "a day's content is resolved on
   screen" fact, so it has to be stubbed as deliberately as the context: the
   dock gates on it and must never re-derive it from the scope. */
function loadDock(askContext, askReady, extra) {
  const { mod } = loadTimeline(Object.assign({
    createContext() { return { Provider: 'AskCtxProvider' }; },
    useContext() {
      return { askContext: askContext, setAskContext() {},
               askReady: askReady, setAskReady() {} };
    },
  }, extra || {}));
  global.window.FieldSight.AskChat = 'AskChatStub';
  return mod;
}

function askElOf(el) {
  assert.ok(el, 'the dock rendered nothing');
  assert.strictEqual(el.props.className, 'fs-ask-dock');
  const ask = el.children.find(c => c && c.type === 'AskChatStub');
  assert.ok(ask, 'no AskChat inside the dock');
  return ask;
}

test('9a the dock\'s scope follows the selection', () => {
  const mod = loadDock(DOCK_DAY, true);
  const withTopic = askElOf(mod.TimelineAskDock({
    selectedItem: { kind: 'topic', topic: { topic_row_id: 't', topic_title: 'Crane' } },
  }));
  assert.strictEqual(withTopic.props.variant, 'dock');
  assert.strictEqual(withTopic.props.context.topicRowId, 't');
  assert.strictEqual(withTopic.props.context.topicTitle, 'Crane');
  assert.strictEqual(withTopic.props.context.date, '2026-09-03', 'the day scope was dropped');

  /* A meeting topic carries no topic_row_id -> the day context (spec §4). */
  const meeting = askElOf(mod.TimelineAskDock({
    selectedItem: { kind: 'meeting_topic', topic: { topic_id: 2, topic_title: 'Standup' } },
  }));
  assert.deepStrictEqual(meeting.props.context, DOCK_DAY);

  const none = askElOf(mod.TimelineAskDock({ selectedItem: null }));
  assert.deepStrictEqual(none.props.context, DOCK_DAY);
});

test('9b the dock renders nothing without a day', () => {
  const mod = loadDock({}, false);
  assert.strictEqual(mod.TimelineAskDock({ selectedItem: null }), null,
    'a bar with nothing to narrow to reads as a global Ask (controller ruling 1)');
  assert.strictEqual(mod.TimelineAskDock({
    selectedItem: { kind: 'topic', topic: { topic_row_id: 't', topic_title: 'Crane' } },
  }), null, 'a selection without a resolved day still rendered a bar');
});

test('9c a palette hand-off is asked unscoped', () => {
  const store = { 'fs.ask.prefill': 'what happened on the crane?' };
  global.sessionStorage = {
    getItem: k => (k in store ? store[k] : null),
    removeItem: k => { delete store[k]; },
  };
  try {
    const mod = loadDock(DOCK_DAY, true);
    const ask = askElOf(mod.TimelineAskDock({ selectedItem: null }));
    assert.deepStrictEqual(ask.props.context, {},
      'the palette question was sent with the day scope');
    assert.strictEqual(ask.props.initialQuestion, 'what happened on the crane?');
    assert.ok(!('fs.ask.prefill' in store),
      'the prefill was not cleared, so it replays on the next mount');
  } finally { delete global.sessionStorage; }
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

/* ---- 9d/9e. the site view's dock (spec 2026-09-16 §2.1) ---------------- */

test('9d the site view publishes a date + site scope with no author', () => {
  const { mod } = loadTimeline();
  const ctx = mod.askContextForSite('site-uuid', 'UC PK', '2026-09-04');
  assert.deepStrictEqual(ctx, { date: '2026-09-04', siteId: 'site-uuid', siteName: 'UC PK' });
  assert.ok(!('authorFolder' in ctx), 'the site view scoped the dock by author');

  /* No visible site name -> the id is omitted too (the #311 rule: never
     narrow by a project the chip cannot name — askContextForDay, above). */
  const noName = mod.askContextForSite('site-uuid', '', '2026-09-04');
  assert.ok(!('siteId' in noName));
  assert.ok(!('siteName' in noName));
  assert.deepStrictEqual(noName, { date: '2026-09-04' });
});

test('9e selecting another person\'s topic in the site view does not change the day keys', () => {
  const { mod } = loadTimeline();
  const siteCtx = { date: '2026-09-04', siteId: 'site-uuid', siteName: 'UC PK' };
  const topicOfPersonB = { topic_row_id: 't2', topic_title: 'Formwork' };
  const withTopic = mod.askContextWithTopic(siteCtx, topicOfPersonB, siteCtx);
  assert.strictEqual(withTopic.date, siteCtx.date);
  assert.strictEqual(withTopic.siteId, siteCtx.siteId);
  assert.strictEqual(withTopic.siteName, siteCtx.siteName);
  assert.strictEqual(withTopic.topicRowId, 't2');
  assert.strictEqual(withTopic.topicTitle, 'Formwork');
  assert.ok(!('authorFolder' in withTopic), 'a topic pin added an author to the site scope');
});

/* ---- 9f-9k. the dock only appears where a day's content is resolved ----

   The Task 4 review found the original `if (!context.date) return null` guard
   suppressed nothing: `askContextForDay` sets `ctx.date` from `date` alone,
   whatever the report is, and the fetch effect has resolved `date` long before
   these branches render. So the dock rendered a `{date}`-only bar — no site, no
   author — on three states that never had an Ask before the redesign.

   These drive the dock with the exact context each of those branches really
   publishes, which is the shape 9b (an EMPTY context) could not reach. */

const DAY_ONLY = { date: '2026-09-03' };

test('9f the project picker gets no dock', () => {
  /* Multi-project caller, no project chosen (SitePickerState). The day-reset
     effect has still published a date, so the scope looks "resolved" and is
     not: there is no project to narrow to and nothing on screen to ask about. */
  const mod = loadDock(DAY_ONLY, false);
  assert.strictEqual(mod.TimelineAskDock({ selectedItem: null }), null,
    'a {date}-only bar on the project picker reads as a global Ask (controller ruling 1)');
});

test('9g the admin available-users disambiguation gets no dock', () => {
  /* { date, available_users:[...] } is a disambiguation envelope, not a day:
     askReportReady is false, yet askContextForDay still published the date. */
  const mod = loadDock(DAY_ONLY, false);
  assert.strictEqual(mod.TimelineAskDock({ selectedItem: null }), null,
    'the user-picker screen rendered an Ask over a list of people');
  assert.strictEqual(mod.TimelineAskDock({
    selectedItem: { kind: 'topic', topic: { topic_row_id: 't', topic_title: 'Crane' } },
  }), null, 'a stale selection brought the dock back on the user picker');
});

test('9h first paint and a day still loading get no dock', () => {
  /* askDayResetKey returns null while loading, so the context is whatever the
     PREVIOUS day left behind — navigating to a new date leaves a stale
     {date} in place. Under the old guard that stale date rendered a dock
     scoped to the day the reader just left. */
  const stale = loadDock({ date: '2026-09-02' }, false);
  assert.strictEqual(stale.TimelineAskDock({ selectedItem: null }), null,
    'a day still loading kept a dock scoped to the previous day');

  const firstPaint = loadDock({}, false);
  assert.strictEqual(firstPaint.TimelineAskDock({ selectedItem: null }), null,
    'the first paint rendered a dock before any day existed');
});

test('9i a day with no report keeps its day-scoped dock', () => {
  /* The one state that LOOKS like the leaks and is not: the day resolved, it
     simply holds nothing. Spec intent is unchanged — the dock stays. */
  const { mod: pure } = loadTimeline();
  const noReport = pure.askContextForDay(null, '2026-09-03', 'Ben_UCPK2');
  assert.deepStrictEqual(noReport, { date: '2026-09-03', authorFolder: 'Ben_UCPK2' });

  const mod = loadDock(noReport, true);
  const ask = askElOf(mod.TimelineAskDock({ selectedItem: null }));
  assert.deepStrictEqual(ask.props.context, noReport,
    'the no-report day lost its day scope');
  assert.strictEqual(ask.props.user, 'Ben_UCPK2');
});

test('9j the aggregated site view keeps its dock, scoped date + site, no author', () => {
  /* Task 6 (commit 7d9b737) publishes this context; the readiness gate must
     not take the dock away again. */
  const { mod: pure } = loadTimeline();
  const siteCtx = pure.askContextForSite('site-uuid', 'UC PK', '2026-09-04');

  const mod = loadDock(siteCtx, true);
  const ask = askElOf(mod.TimelineAskDock({ selectedItem: null }));
  assert.strictEqual(ask.props.context.date, '2026-09-04');
  assert.strictEqual(ask.props.context.siteId, 'site-uuid');
  assert.strictEqual(ask.props.context.siteName, 'UC PK');
  assert.ok(!('authorFolder' in ask.props.context),
    'the aggregated view scoped the dock by author');
  assert.ok(!ask.props.user, 'the aggregated view passed an owner to AskChat');
});

test('9k askDockHasContent is the readiness rule, and it is about the SCREEN', () => {
  const { mod } = loadTimeline();
  const ready = mod.askDockHasContent;
  assert.strictEqual(typeof ready, 'function', 'the readiness rule is not exported');

  /* Not resolved: still loading, the project picker, the user picker. */
  assert.strictEqual(ready('loading', false, false), false);
  assert.strictEqual(ready('ok', true, false), false, 'the project picker was called resolved');
  assert.strictEqual(ready('ok', false, true), false, 'the user picker was called resolved');

  /* Resolved: an ordinary day (report or not) and the aggregated site view,
     both of which reach this with status 'ok' and neither picker showing. */
  assert.strictEqual(ready('ok', false, false), true, 'a resolved day lost its dock');
});

test('S10 the middle column publishes readiness from the same predicates it renders', () => {
  /* The dock must not guess, so the column has to publish the fact — and it
     has to be the SAME expression the branch renders from, or the two drift
     apart silently and the guard goes back to being decorative. */
  const src = timelineSrc();
  const mid = src.slice(src.indexOf('function TimelineMiddleColumn('),
                        src.indexOf('function SessionPicker('));

  assert.match(mid, /var showSitePicker\s*=/, 'the project-picker predicate is not named once');
  assert.match(mid, /var showUserPicker\s*=/, 'the user-picker predicate is not named once');
  assert.match(mid, /if \(showSitePicker\)/, 'the picker branch does not read the named predicate');
  assert.match(mid, /if \(showUserPicker\)/, 'the user-picker branch does not read the named predicate');
  assert.match(mid, /askDockHasContent\(/, 'readiness is not computed from the shared rule');
  assert.match(mid, /setAskReady\(/, 'the column never publishes readiness to the dock');

  /* The inline copies must be gone, or a later edit can change one and not
     the other. */
  assert.doesNotMatch(mid, /if \(!site && teamView && sitesList\.length > 1\)/,
    'the picker branch still carries its own copy of the condition');
  assert.doesNotMatch(mid, /if \(report && report\.available_users && !hasMeeting\)/,
    'the user-picker branch still carries its own copy of the condition');
});
