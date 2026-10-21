'use strict';

/*
 * AskChat keeps a conversation (spec 2026-10-22 ask-conversation-history §7,
 * plan task 8).
 *
 * - `threads: true` (the palette's AskChat only): the first question sends
 *   `new_thread: true`, every later one the `thread_id` the backend handed
 *   back in `result.thread`. A different id back (the old thread was evicted,
 *   expired or full) switches to it and says "Started a new conversation".
 * - `initialThread`: the stored turns render through the same builder a live
 *   answer uses (messageFromResult), with NO request; a follow-up sends the
 *   thread id and the history the seeded turns make.
 * - Stored answers say "Answered {date}" and carry "Ask again"; a withheld
 *   turn says the §6 sentence instead of an answer.
 * - Without `threads` the request body is exactly today's.
 */
const test = require('node:test');
const assert = require('node:assert');

const TID  = '0123456789abcdef0123456789abcdef';
const TID2 = 'fedcba9876543210fedcba9876543210';
const WITHHELD = 'A record behind this answer is no longer available to you.';
const OFFER_TEXT = "Your site records don't cover that.";
/* 2026-10-20 05:00 UTC, in epoch SECONDS (the backend is Python). */
const AT = Date.UTC(2026, 9, 20, 5, 0, 0) / 1000;

function flushMicrotasks() { return new Promise(r => setImmediate(r)); }
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

/* Same driven-component harness as tests/ask-web-offer.test.js. */
function mountAsk(apiFlags) {
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
  const api = Object.assign({ ask: { ask(body) {
    h.asks.push(body);
    const d = deferred();
    h.pending.push(d);
    return d.promise;
  } } }, apiFlags || {});
  global.window = { FieldSight: { renderMarkdown: s => s }, FS: { api: api } };
  require('../scripts/composites/ask-chat.js');
  const AskChat = global.window.FieldSight.AskChat;
  h.AskChat = AskChat;

  h.render = function (props) {
    si = 0; ri = 0; ei = 0;
    h.props = props;
    h.tree = AskChat(props);
    h.nodes().forEach(n => {
      if (n.props.ref && n.props.ref.current == null) {
        n.props.ref.current = { scrollIntoView() {}, focus() {}, querySelectorAll() { return []; } };
      }
    });
    h.effects.forEach(e => { if (e.changed) { e.changed = false; e.fn(); } });
    return h.tree;
  };
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
  h.byClass = cls => h.nodes().filter(n => String(n.props.className || '').split(' ').includes(cls));
  h.text = function (n) {
    return n.kids.map(function t(k) {
      if (Array.isArray(k)) return k.map(t).join('');
      if (k && typeof k === 'object') return h.text(k);
      return k == null || k === false ? '' : String(k);
    }).join('');
  };
  h.log = function () {
    return h.byClass('fs-ask-chat__msg').map(function (n) {
      if (String(n.props.className).includes('--pending')) return ['pending', h.text(n)];
      const body = (function find(x) {
        if (!x || typeof x !== 'object') return null;
        if (x.props && x.props.dangerouslySetInnerHTML) return x.props.dangerouslySetInnerHTML.__html;
        for (const k of x.kids.flat()) { const r = find(k); if (r != null) return r; }
        return null;
      })(n);
      return [n.props['data-role'], body != null ? body : h.text(n)];
    });
  };
  /* The message log as state holds it (msgs is AskChat's first useState). */
  h.msgs = () => h.states[0];
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
  h.askAgain = () => h.byClass('fs-ask-chat__ask-again');
  h.offerButtons = () => h.byClass('fs-ask-chat__web-offer');
  return h;
}

const RESULT = {
  answer: 'You poured the slab on Tuesday [1].',
  citations: [{ source_s3_key: 'reports/2026-10-20/ben_lin/daily_report.json', snippet: 's',
                report_date: '2026-10-20', site_name: 'Pod 3' }],
  basis: { chunks: 3, from: '2026-10-20', to: '2026-10-20', dates: ['2026-10-20'] },
  grounded: true,
  applied_scope: {},
  asked: 'When was the slab poured?',
};

function turn(question, result, request, extra) {
  return Object.assign({
    turn_id: 'turn-' + question, question: question, at: AT,
    request: Object.assign({ offer_web: false, web_intent: false, history_len: 0 }, request || {}),
    result: result,
  }, extra || {});
}

function strip(m, keys) {
  const o = Object.assign({}, m);
  keys.forEach(k => delete o[k]);
  return o;
}

/* ---- one builder for live and stored -------------------------------------- */

test('H1 live send and seeded turn render the same message for the same result', async () => {
  const live = mountAsk();
  live.render({ threads: true });
  await live.ask('When did we pour?');
  await live.settle(0, Object.assign({ thread: { thread_id: TID, rolled_over: false } }, RESULT));
  const liveMsg = live.msgs().find(m => m.role === 'assistant');

  const seeded = mountAsk();
  seeded.render({ threads: true, initialThread: { thread_id: TID, scope: {}, turns: [turn('When did we pour?', RESULT)] } });
  const seededMsg = seeded.msgs().find(m => m.role === 'assistant');

  assert.deepStrictEqual(strip(seededMsg, ['id', 'stored', 'answeredAt']), strip(liveMsg, ['id']));
  /* And it is the exported builder that makes both. */
  const built = seeded.AskChat._messageFromResult('When did we pour?', RESULT,
    { offerWeb: false, sentHistory: [], scoped: false });
  assert.deepStrictEqual(strip(built, ['id']), strip(liveMsg, ['id']));
  /* `result.thread` is bookkeeping, never part of the message. */
  assert.ok(!('thread' in liveMsg));
  /* The rendered answer reads the same. */
  const ans = l => l.log().filter(r => r[0] === 'assistant').map(r => r[1]);
  assert.deepStrictEqual(ans(seeded), ans(live));
});

test('H2 a seeded thread makes no /ask/start call', () => {
  const h = mountAsk({ askAsync: true });
  h.render({ threads: true, initialThread: { thread_id: TID, scope: {}, turns: [turn('Q1', RESULT)] } });
  h.rerender();
  assert.strictEqual(h.asks.length, 0);
  assert.deepStrictEqual(h.log().map(r => r[0]), ['user', 'assistant']);
  /* The suggestions row is for an empty log; a seeded log is not empty. */
  assert.strictEqual(h.byClass('fs-ask-chat__suggestions').length, 0);
});

/* ---- the thread id on the wire -------------------------------------------- */

test('H3 the first question with threads sends new_thread:true; the next sends the id it got back', async () => {
  const h = mountAsk();
  h.render({ threads: true, user: 'Ben' });
  await h.ask('Q1');
  assert.strictEqual(h.asks[0].new_thread, true);
  assert.ok(!('thread_id' in h.asks[0]));
  await h.settle(0, { answer: 'A1', citations: [], thread: { thread_id: TID, rolled_over: false } });
  assert.ok(!h.log().some(r => r[0] === 'divider'), 'a first thread is not a switch');

  await h.ask('Q2');
  assert.strictEqual(h.asks[1].thread_id, TID);
  assert.ok(!('new_thread' in h.asks[1]));
  assert.deepStrictEqual(h.asks[1].history, [{ question: 'Q1', answer: 'A1' }]);
});

test('H4 a result with no thread (backend flag off, or the append failed) keeps asking for a new one', async () => {
  const h = mountAsk();
  h.render({ threads: true });
  await h.ask('Q1');
  await h.settle(0, { answer: 'A1', citations: [] });
  await h.ask('Q2');
  assert.strictEqual(h.asks[1].new_thread, true);
  assert.ok(!('thread_id' in h.asks[1]));
});

test('H5 a follow-up on a seeded thread sends its thread_id and the history its turns make', async () => {
  const h = mountAsk();
  h.render({ threads: true, initialThread: { thread_id: TID, scope: {}, turns: [
    turn('Q1', { answer: 'A1', citations: [] }),
    turn('Q2', { answer: 'A2', citations: [] }, { history_len: 1 }),
  ] } });
  await h.ask('Q3');
  assert.strictEqual(h.asks[0].thread_id, TID);
  assert.ok(!('new_thread' in h.asks[0]));
  assert.deepStrictEqual(h.asks[0].history, [
    { question: 'Q1', answer: 'A1' },
    { question: 'Q2', answer: 'A2' },
  ]);
});

test('H6 result.thread with a different id switches thread and says "Started a new conversation"', async () => {
  const h = mountAsk();
  h.render({ threads: true, initialThread: { thread_id: TID, scope: {}, turns: [turn('Q1', { answer: 'A1', citations: [] })] } });
  await h.ask('Q2');
  await h.settle(0, { answer: 'A2', citations: [], thread: { thread_id: TID2, rolled_over: true } });
  /* The notice sits where the new conversation begins: above the question
     that started it. */
  assert.deepStrictEqual(h.log().map(r => r[1]),
    ['Q1', 'A1', 'Started a new conversation', 'Q2', 'A2']);
  assert.strictEqual(h.log()[2][0], 'divider');

  await h.ask('Q3');
  assert.strictEqual(h.asks[1].thread_id, TID2);
  /* The conversation on screen is still the reader's context. */
  assert.deepStrictEqual(h.asks[1].history, [
    { question: 'Q1', answer: 'A1' },
    { question: 'Q2', answer: 'A2' },
  ]);
});

/* ---- stored turns --------------------------------------------------------- */

test('H7 a withheld turn renders the sentence and an Ask again button, and is no turn of history', async () => {
  const h = mountAsk();
  h.render({ threads: true, initialThread: { thread_id: TID, scope: {}, turns: [
    { turn_id: 'w', question: 'Q1', at: AT, request: { offer_web: false, web_intent: false, history_len: 0 }, withheld: true },
    turn('Q2', { answer: 'A2', citations: [] }),
  ] } });
  const log = h.log();
  assert.deepStrictEqual(log[1], ['assistant', WITHHELD]);
  const row = h.byClass('fs-ask-chat__msg')[1];
  assert.ok(String(row.props.className).includes('fs-ask-chat__msg--withheld'));
  const again = h.askAgain();
  assert.strictEqual(again.length, 2, 'every stored turn carries Ask again');
  assert.strictEqual(h.text(again[0]), 'Ask again');
  assert.strictEqual(again[0].type, 'button');

  await h.ask('Q3');
  assert.deepStrictEqual(h.asks[0].history, [{ question: 'Q2', answer: 'A2' }]);
});

test('H8 Ask again re-runs the question as a new turn with thread_id', async () => {
  const h = mountAsk();
  h.render({ threads: true, initialThread: { thread_id: TID, scope: {}, turns: [
    { turn_id: 'w', question: 'Q1', at: AT, request: {}, withheld: true },
    turn('Q2', { answer: 'A2', citations: [] }),
  ] } });
  h.askAgain()[0].props.onClick();
  h.rerender();
  assert.strictEqual(h.asks.length, 1);
  assert.strictEqual(h.asks[0].question, 'Q1');
  assert.strictEqual(h.asks[0].thread_id, TID);
  assert.deepStrictEqual(h.asks[0].history, [{ question: 'Q2', answer: 'A2' }]);
  /* A new turn: its own question bubble at the foot of the log. */
  const log = h.log();
  assert.deepStrictEqual(log[log.length - 2], ['user', 'Q1']);
  assert.strictEqual(log[log.length - 1][0], 'pending');
  /* Disabled while that is in flight. */
  assert.strictEqual(h.askAgain()[0].props.disabled, true);
});

test('H9 stored answers show "Answered {date}"; live answers do not', async () => {
  const h = mountAsk();
  h.render({ threads: true, initialThread: { thread_id: TID, scope: {}, turns: [turn('Q1', RESULT)] } });
  const lines = h.byClass('fs-ask-chat__answered');
  assert.strictEqual(lines.length, 1);
  /* The app's short-day format (the scope chips' 'Thu 3 Sep'), in the
     browser's own zone. */
  assert.strictEqual(h.text(lines[0]), 'Answered ' + h.AskChat._answeredDay(AT));
  assert.match(h.text(lines[0]), /^Answered (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} (Oct)$/);

  await h.ask('Q2');
  await h.settle(0, { answer: 'A2', citations: [] });
  assert.strictEqual(h.byClass('fs-ask-chat__answered').length, 1);
});

test('H10 _answeredDay reads epoch seconds in the zone asked for', () => {
  const h = mountAsk();
  assert.strictEqual(h.AskChat._answeredDay(AT, 'UTC'), 'Tue 20 Oct');
  /* 2026-10-20 23:30 UTC is already the 21st in Auckland (NZDT, +13). */
  const late = Date.UTC(2026, 9, 20, 23, 30) / 1000;
  assert.strictEqual(h.AskChat._answeredDay(late, 'UTC'), 'Tue 20 Oct');
  assert.strictEqual(h.AskChat._answeredDay(late, 'Pacific/Auckland'), 'Wed 21 Oct');
  assert.strictEqual(h.AskChat._answeredDay(null), null);
});

test('H11 a stored offer turn\'s "Search the web" re-asks with the stored history', async () => {
  const h = mountAsk({ askWebOffer: true });
  h.render({ threads: true, initialThread: { thread_id: TID, scope: {}, turns: [
    turn('Q1', { answer: 'A1', citations: [] }, { offer_web: true }),
    turn('min cover for a slab', { answer: OFFER_TEXT, citations: [], web_offer: true },
         { offer_web: true, history_len: 1 }),
  ] } });
  const btn = h.offerButtons();
  assert.strictEqual(btn.length, 1);
  btn[0].props.onClick();
  h.rerender();
  assert.strictEqual(h.asks.length, 1);
  const re = h.asks[0];
  assert.strictEqual(re.question, 'min cover for a slab');
  assert.strictEqual(re.web_intent, true);
  assert.strictEqual(re.offer_web, true);
  assert.strictEqual(re.thread_id, TID);
  assert.deepStrictEqual(re.history, [{ question: 'Q1', answer: 'A1' }]);
  /* No second question bubble: the re-ask asks nothing new. */
  assert.strictEqual(h.log().filter(r => r[0] === 'user').length, 2);
});

test('H12 a stored offer that was taken renders as it did live: no button, no second bubble', () => {
  const h = mountAsk({ askWebOffer: true });
  h.render({ threads: true, initialThread: { thread_id: TID, scope: {}, turns: [
    turn('min cover for a slab', { answer: OFFER_TEXT, citations: [], web_offer: true }, { offer_web: true }),
    turn('min cover for a slab', { answer: 'web says 25mm', citations: [], from_web: true },
         { offer_web: true, web_intent: true }),
  ] } });
  assert.strictEqual(h.offerButtons().length, 0);
  assert.deepStrictEqual(h.log().map(r => r[1]), ['min cover for a slab', OFFER_TEXT, 'web says 25mm']);
});

/* ---- flag off / no threads prop: today's body ----------------------------- */

test('H13 without the threads prop the request body is byte-identical to today', async () => {
  for (const props of [{ user: 'Ben' }, { user: 'Ben', threads: false }]) {
    const h = mountAsk();
    h.render(props);
    await h.ask('Q1');
    assert.strictEqual(JSON.stringify(h.asks[0]), JSON.stringify({ question: 'Q1', user: 'Ben' }));
    await h.settle(0, { answer: 'A1', citations: [], thread: { thread_id: TID, rolled_over: false } });
    await h.ask('Q2');
    assert.strictEqual(JSON.stringify(h.asks[1]),
      JSON.stringify({ question: 'Q2', history: [{ question: 'Q1', answer: 'A1' }], user: 'Ben' }));
  }
  /* Scoped and offering the web, too. */
  const h = mountAsk({ askWebOffer: true });
  h.render({ user: 'Ben', context: { date: '2026-10-20', siteId: 's1' } });
  await h.ask('Q1');
  assert.strictEqual(JSON.stringify(h.asks[0]), JSON.stringify(
    { question: 'Q1', date: '2026-10-20', site_id: 's1', scoped: true, offer_web: true, user: 'Ben' }));
});

test('H14 a scope change drops the thread: the next question starts a new one', async () => {
  const h = mountAsk();
  h.render({ threads: true, context: {} });
  await h.ask('Q1');
  await h.settle(0, { answer: 'A1', citations: [], thread: { thread_id: TID, rolled_over: false } });
  h.render({ threads: true, context: { date: '2026-10-20' } });
  h.rerender();
  await h.ask('Q2');
  assert.strictEqual(h.asks[1].new_thread, true);
  assert.ok(!('thread_id' in h.asks[1]));
});
