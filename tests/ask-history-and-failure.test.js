'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

/* Task 11 (docs/superpowers/sdd/2026-09-17-ask-conversation-memory):
   - requestBodyFor carries `history` as [{question, answer}], omitted when
     there is nothing to send.
   - the clear-on-scope-change (ask-chat.js:696) also clears history, since
     history is built from the log the clear already empties -- pinned here
     because carrying a conversation across a site switch would retrieve
     site B with site A's referents.
   - `asked` renders as "Searched for: ..." only when present and different
     from what was typed; `web.refused` renders when present.
   - every failure class (timeout, any HTTP status, network) renders the
     SAME reassuring line, with no cause exposed on screen. err.timeout /
     err.status are still read, but only to pick a console.warn label.

   The backend half of this feature is on another branch and today ignores
   `history` and never returns `asked` -- so every assertion here must also
   hold against a response that has neither field, which the D-series tests
   already exercise for the rest of the component and this file does not
   repeat.
*/

const REASSURING = 'FieldSight is busy at the moment. Your question has not '
  + 'been lost — please try again shortly. If it keeps happening, contact '
  + 'the FieldSight team.';

/* ---- pure helpers: requestBodyFor(context, question, history) ----------- */

function loadScope() {
  delete require.cache[require.resolve('../scripts/composites/ask-chat.js')];
  global.window = { FieldSight: {}, FS: { api: {} } };
  global.React = { createElement: function () { return null; } };
  global.document = { addEventListener() {}, removeEventListener() {} };
  require('../scripts/composites/ask-chat.js');
  return global.window.FieldSight.askScope;
}

test('H1 history is omitted entirely when there is nothing to send', () => {
  const S = loadScope();
  const body = S.requestBodyFor({}, 'q');
  assert.ok(!('history' in body), 'history present with no prior turns');
  const body2 = S.requestBodyFor({}, 'q', []);
  assert.ok(!('history' in body2), 'an empty array must still omit the key');
  const body3 = S.requestBodyFor({}, 'q', undefined);
  assert.ok(!('history' in body3));
});

test('H2 history is sent as exactly {question, answer} objects, in order', () => {
  const S = loadScope();
  const history = [
    { question: 'first', answer: 'a1' },
    { question: 'second', answer: 'a2' },
  ];
  const body = S.requestBodyFor({}, 'third', history);
  assert.deepStrictEqual(body.history, history);
  /* Exactly those key names, nothing extra riding along. */
  body.history.forEach(function (turn) {
    assert.deepStrictEqual(Object.keys(turn).sort(), ['answer', 'question']);
  });
});

test('H3 history does not affect the rest of the body', () => {
  const S = loadScope();
  const withHist = S.requestBodyFor({ date: '2026-09-03' }, 'q', [{ question: 'x', answer: 'y' }]);
  const withoutHist = S.requestBodyFor({ date: '2026-09-03' }, 'q');
  const { history, ...rest } = withHist;
  assert.deepStrictEqual(rest, withoutHist);
});

/* No second, smaller client-side cap: whatever the log holds is what is
   offered. The server does its own 6-turn / 2000-char capping. */
test('H4 requestBodyFor does not truncate the history it is given', () => {
  const S = loadScope();
  const long = [];
  for (let i = 0; i < 40; i++) long.push({ question: 'q' + i, answer: 'a'.repeat(3000) });
  const body = S.requestBodyFor({}, 'q', long);
  assert.strictEqual(body.history.length, 40, 'requestBodyFor added a client-side cap');
  assert.strictEqual(body.history[39].answer.length, 3000, 'requestBodyFor truncated an answer');
});

/* ---- driven: the component builds history from its own log -------------- */

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
  /* Assistant text renders via dangerouslySetInnerHTML (window.FieldSight.
     renderMarkdown is present in this harness), so it carries no React
     children for h.text() to walk -- read the __html the renderer wrote. */
  h.assistantText = function (n) {
    if (n && n.props && n.props.dangerouslySetInnerHTML) {
      return n.props.dangerouslySetInnerHTML.__html;
    }
    return h.text(n);
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
  h.fail = async function (i, err) {
    h.pending[i].reject(err);
    for (let k = 0; k < 5; k++) await flushMicrotasks();
    h.rerender();
  };
  return h;
}

test('T1 the first question in a fresh conversation carries no history key', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: {} });
  await h.ask('what happened today');
  assert.ok(!('history' in h.asks[0]), 'history present on the first question');
});

test('T2 the second question carries the first turn as {question, answer}', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: {} });
  await h.ask('first question');
  await h.settle(0, { answer: 'first answer', citations: [] });
  await h.ask('second question');
  assert.deepStrictEqual(h.asks[1].history, [{ question: 'first question', answer: 'first answer' }]);
});

test('T3 a failed turn (the reassuring line) is not fed back as history', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: {} });
  await h.ask('first question');
  await h.fail(0, new Error('boom'));
  await h.ask('second question');
  assert.ok(!('history' in h.asks[1]),
    'a failed turn was sent back to the model as if it had answered');
});

test('T4 several turns accumulate in order, most-recent last', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: {} });
  await h.ask('q1');
  await h.settle(0, { answer: 'a1', citations: [] });
  await h.ask('q2');
  await h.settle(1, { answer: 'a2', citations: [] });
  await h.ask('q3');
  assert.deepStrictEqual(h.asks[2].history, [
    { question: 'q1', answer: 'a1' },
    { question: 'q2', answer: 'a2' },
  ]);
});

/* ---- pin: a scope change clears history along with the visible log ------ */

test('T5 a site switch does not carry the old site\'s conversation into the new one\'s request', async () => {
  const SITE_A = { date: '2026-09-03', siteId: 'site-a', authorFolder: 'Ben' };
  const SITE_B = { date: '2026-09-03', siteId: 'site-b', authorFolder: 'Ben' };
  const h = mountAsk();
  h.render({ user: 'Ben', context: SITE_A });
  await h.ask('who is the site manager here');
  await h.settle(0, { answer: 'It is Dave', citations: [] });
  assert.strictEqual(h.byClass('fs-ask-chat__msg--user').length, 1);

  /* The scope change (siteId differs) fires the existing clear-on-scope-change
     effect (ask-chat.js:~696-767), which empties msgs -- and with it, the log
     history is built from. */
  h.render({ user: 'Ben', context: SITE_B });
  h.rerender();
  assert.strictEqual(h.byClass('fs-ask-chat__msg').length, 0, 'the log survived the site switch');

  await h.ask('who is the site manager here');
  assert.ok(!('history' in h.asks[1]),
    'site B\'s request carried site A\'s conversation -- "here" would resolve against the wrong site');
});

/* ---- asked: render only when present and different from what was typed -- */

test('A1 asked is not rendered when the backend omits it (today\'s backend)', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: {} });
  await h.ask('what happened yesterday');
  await h.settle(0, { answer: 'a', citations: [] });
  assert.strictEqual(h.byClass('fs-ask-chat__asked').length, 0);
});

test('A2 asked is not rendered when it equals what was typed', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: {} });
  await h.ask('what happened yesterday');
  await h.settle(0, { answer: 'a', citations: [], asked: 'what happened yesterday' });
  assert.strictEqual(h.byClass('fs-ask-chat__asked').length, 0);
});

test('A3 asked renders "Searched for: ..." when present and different', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: {} });
  await h.ask('what happened yesterday');
  await h.settle(0, { answer: 'a', citations: [], asked: 'What happened on 2026-09-17?' });
  const nodes = h.byClass('fs-ask-chat__asked');
  assert.strictEqual(nodes.length, 1);
  assert.strictEqual(h.text(nodes[0]), 'Searched for: What happened on 2026-09-17?');
});

/* ---- web.refused ---------------------------------------------------------- */

test('W1 web.refused is not rendered when absent', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: {} });
  await h.ask('q');
  await h.settle(0, { answer: 'a', citations: [], web: { sources: [] } });
  assert.strictEqual(h.byClass('fs-ask-chat__web-refused').length, 0);
});

test('W2 web.refused renders the sentence question_admission returned', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: {} });
  await h.ask('q');
  await h.settle(0, {
    answer: 'a', citations: [],
    web: { refused: 'This question asks about a named individual, which the web check will not run for.' },
  });
  const nodes = h.byClass('fs-ask-chat__web-refused');
  assert.strictEqual(nodes.length, 1);
  assert.strictEqual(h.text(nodes[0]),
    'This question asks about a named individual, which the web check will not run for.');
});

/* ---- the single reassuring failure message -------------------------------- */

test('F1 a timeout shows the reassuring line, not "took too long to answer"', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: {} });
  await h.ask('q');
  const err = new Error('timed out'); err.timeout = true; err.name = 'TimeoutError';
  await h.fail(0, err);
  const node = h.byClass('fs-ask-chat__msg-text--md')[0];
  assert.strictEqual(h.assistantText(node), REASSURING);
});

test('F2 an HTTP 504 shows the exact same reassuring line as the timeout', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: {} });
  await h.ask('q');
  const err = new Error('HTTP 504'); err.status = 504;
  await h.fail(0, err);
  const node = h.byClass('fs-ask-chat__msg-text--md')[0];
  assert.strictEqual(h.assistantText(node), REASSURING);
});

test('F3 a plain network error (no timeout, no status) shows the same line too', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: {} });
  await h.ask('q');
  const err = new TypeError('Failed to fetch');
  await h.fail(0, err);
  const node = h.byClass('fs-ask-chat__msg-text--md')[0];
  assert.strictEqual(h.assistantText(node), REASSURING);
});

test('F4 the old two-message copy is gone from the source', () => {
  const src = fs.readFileSync(require.resolve('../scripts/composites/ask-chat.js'), 'utf8');
  assert.ok(!/took too long to answer/.test(src), 'old timeout copy still present');
  assert.ok(!/Could not reach the agent/.test(src), 'old unreachable-agent copy still present');
  /* The rendered text is pinned exactly by F1-F3 (assembled at runtime); this
     only checks the source no longer branches into two different strings for
     the two old cases -- i.e. there is one `text:` value in the catch block,
     not a ternary picking between two. */
  const catchStart = src.indexOf('.catch(function (err) {');
  const catchBlock = src.slice(catchStart, src.indexOf('}).then(function () {', catchStart));
  assert.ok(!/err && err\.timeout\)\s*\n?\s*\?/.test(catchBlock),
    'the catch block still branches the DISPLAYED text on err.timeout');
  assert.ok(/FieldSight is busy at the moment/.test(catchBlock), 'new reassuring copy missing');
});

test('F5 err.timeout and err.status are still read (for reporting only)', () => {
  const src = fs.readFileSync(require.resolve('../scripts/composites/ask-chat.js'), 'utf8');
  assert.match(src, /err(\s*&&\s*err)?\.timeout/, 'err.timeout no longer referenced');
  assert.match(src, /err(\s*&&\s*err)?\.status/, 'err.status no longer referenced');
});
