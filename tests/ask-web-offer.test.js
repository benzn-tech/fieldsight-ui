'use strict';

/*
 * Ask offers the web first (spec 2026-10-16 ask-screen-web-offer §5), behind
 * FS_ASK_WEB_OFFER -> window.FS_ENV.askWebOffer -> FS.api.askWebOffer.
 *
 * - Flag off: the body and the rendered log are exactly today's.
 * - Flag on: every question carries `offer_web: true`; an answer with
 *   `web_offer` renders "Search the web"; a click re-asks the same question
 *   with `web_intent: true` and the history the offer's own turn sent, adds
 *   no second user bubble, and the web answer lands right after the offer.
 * - History (controller ruling 2026-10-16): only a TAKEN offer is skipped,
 *   so Q pairs with the web answer; an offer nobody took pairs as a normal
 *   turn.
 * - Both body whitelists (requestBodyFor and api/ask.js ask()) carry the
 *   fields, on the sync AND the async transport.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OFFER_TEXT = "Your site records don't cover that.";

/* ---- flag wiring ---------------------------------------------------------- */

test('W1 the flag reaches FS.api from env, default off', () => {
  function flagFor(env) {
    global.window = { FS_ENV: env };
    delete require.cache[require.resolve('../scripts/api/index.js')];
    require('../scripts/api/index.js');
    return global.window.FS.api.askWebOffer;
  }
  assert.strictEqual(flagFor({}), false);
  assert.strictEqual(flagFor({ askWebOffer: false }), false);
  assert.strictEqual(flagFor({ askWebOffer: true }), true);
});

test('W2 the build emits askWebOffer from FS_ASK_WEB_OFFER, default false, same position in format and args', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'amplify.yml'), 'utf8').replace(/\r\n/g, '\n');
  const fmt = yml.match(/printf 'window\.FS_ENV = \{([^']*)\};\\n'/);
  assert.ok(fmt, 'printf format string not found');
  const keys = fmt[1].split(',').map(function (s) { return s.trim().split(':')[0]; });
  const argsLine = yml.slice(fmt.index + fmt[0].length).split('\n')[1];
  const args = argsLine.trim().match(/"[^"]*"/g);
  assert.strictEqual(keys.length, args.length, 'format keys and arguments out of step');
  const k = keys.indexOf('askWebOffer');
  assert.ok(k >= 0, 'askWebOffer missing from the format string');
  assert.strictEqual(args[k], '"${FS_ASK_WEB_OFFER:-false}"');
});

/* ---- requestBodyFor ------------------------------------------------------- */

function loadScope() {
  delete require.cache[require.resolve('../scripts/composites/ask-chat.js')];
  global.window = { FieldSight: {}, FS: { api: {} } };
  global.React = { createElement: function () { return null; } };
  global.document = { addEventListener() {}, removeEventListener() {} };
  require('../scripts/composites/ask-chat.js');
  return global.window.FieldSight.askScope;
}

test('W3 requestBodyFor adds the web keys only when exactly true', () => {
  const S = loadScope();
  assert.deepStrictEqual(S.requestBodyFor({}, 'q', []), { question: 'q' });
  assert.deepStrictEqual(S.requestBodyFor({}, 'q', [], {}), { question: 'q' });
  assert.deepStrictEqual(S.requestBodyFor({}, 'q', [], { offerWeb: 'true', webIntent: 1 }), { question: 'q' });
  assert.deepStrictEqual(S.requestBodyFor({}, 'q', [], { offerWeb: true }), { question: 'q', offer_web: true });
  assert.deepStrictEqual(S.requestBodyFor({}, 'q', [], { offerWeb: true, webIntent: true }),
    { question: 'q', offer_web: true, web_intent: true });
});

/* ---- api/ask.js forwards both, on both transports ------------------------- */

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
  test('W4 ask() forwards offer_web / web_intent only when true (' + route + ')', async () => {
    let L = loadAsk(asyncFlag);
    await L.ask({ question: 'q', tz: null, offer_web: true, web_intent: true });
    let body = L.seen.find(function (s) { return s.path === route; }).opts.body;
    assert.strictEqual(body.offer_web, true);
    assert.strictEqual(body.web_intent, true);

    L = loadAsk(asyncFlag);
    await L.ask({ question: 'q', tz: null, offer_web: 'true', web_intent: false });
    body = L.seen.find(function (s) { return s.path === route; }).opts.body;
    assert.ok(!('offer_web' in body), 'a non-true offer_web reached the wire');
    assert.ok(!('web_intent' in body), 'a non-true web_intent reached the wire');

    L = loadAsk(asyncFlag);
    await L.ask({ question: 'q', tz: null });
    body = L.seen.find(function (s) { return s.path === route; }).opts.body;
    assert.ok(!('offer_web' in body) && !('web_intent' in body));
  });
}

/* ---- driven component ----------------------------------------------------- */

function flushMicrotasks() { return new Promise(r => setImmediate(r)); }
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function mountAsk(flag) {
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
  const api = { ask: { ask(body) {
    h.asks.push(body);
    const d = deferred();
    h.pending.push(d);
    return d.promise;
  } } };
  if (flag !== undefined) api.askWebOffer = flag;
  global.window = { FieldSight: { renderMarkdown: s => s }, FS: { api: api } };
  require('../scripts/composites/ask-chat.js');
  const AskChat = global.window.FieldSight.AskChat;

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
  /* The log's message rows, in order, as [role, text]. */
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
  h.offerButtons = () => h.byClass('fs-ask-chat__web-offer');
  return h;
}

test('W5 flag off: no web keys on the wire, and no button even if a backend returned web_offer', async () => {
  const h = mountAsk(undefined);
  h.render({ user: 'Ben', context: {} });
  await h.ask('min cover for a slab');
  assert.deepStrictEqual(Object.keys(h.asks[0]).sort(), ['question', 'user']);
  await h.settle(0, { answer: OFFER_TEXT, citations: [], web_offer: true });
  assert.strictEqual(h.offerButtons().length, 0);
});

test('W6 flag on: offer_web on every question, not web_intent', async () => {
  const h = mountAsk(true);
  h.render({ user: 'Ben', context: {} });
  await h.ask('q1');
  assert.strictEqual(h.asks[0].offer_web, true);
  assert.ok(!('web_intent' in h.asks[0]));
});

test('W7 the button re-asks the same question with web_intent and the offer turn\'s own history; no second user bubble', async () => {
  const h = mountAsk(true);
  h.render({ user: 'Ben', context: {} });
  await h.ask('q1');
  await h.settle(0, { answer: 'a1', citations: [] });
  await h.ask('min cover for a slab');
  const sent = h.asks[1].history;
  assert.deepStrictEqual(sent, [{ question: 'q1', answer: 'a1' }]);
  await h.settle(1, { answer: OFFER_TEXT, citations: [], web_offer: true });

  const btn = h.offerButtons();
  assert.strictEqual(btn.length, 1);
  assert.strictEqual(btn[0].type, 'button');
  assert.strictEqual(h.text(btn[0]), 'Search the web');
  assert.strictEqual(btn[0].props.disabled, false);
  const usersBefore = h.log().filter(r => r[0] === 'user').length;

  btn[0].props.onClick();
  h.rerender();

  assert.strictEqual(h.asks.length, 3);
  const re = h.asks[2];
  assert.strictEqual(re.question, 'min cover for a slab');
  assert.strictEqual(re.web_intent, true);
  assert.strictEqual(re.offer_web, true);
  assert.deepStrictEqual(re.history, sent);
  assert.strictEqual(h.offerButtons().length, 0, 'the button survived the click');
  assert.strictEqual(h.log().filter(r => r[0] === 'user').length, usersBefore, 'a second user bubble appeared');
  /* The placeholder follows the offer message and says what it is doing. */
  const log = h.log();
  assert.deepStrictEqual(log[log.length - 1], ['pending', 'Searching the web…']);
  assert.strictEqual(log[log.length - 2][1], OFFER_TEXT);

  await h.settle(2, { answer: 'web says 25mm', citations: [], from_web: true });
  assert.strictEqual(h.offerButtons().length, 0);
  assert.strictEqual(h.log().filter(r => r[0] === 'pending').length, 0);

  /* Next turn: Q pairs with the web answer, the taken offer is skipped. */
  await h.ask('and for a wall?');
  assert.deepStrictEqual(h.asks[3].history, [
    { question: 'q1', answer: 'a1' },
    { question: 'min cover for a slab', answer: 'web says 25mm' },
  ]);
});

test('W8 an offer nobody took pairs with its question as a normal turn', async () => {
  const h = mountAsk(true);
  h.render({ user: 'Ben', context: {} });
  await h.ask('min cover for a slab');
  await h.settle(0, { answer: 'Partly: the spec says 30mm.', citations: [{ n: 1 }], web_offer: true });
  assert.strictEqual(h.offerButtons().length, 1);
  await h.ask('next');
  assert.deepStrictEqual(h.asks[1].history, [
    { question: 'min cover for a slab', answer: 'Partly: the spec says 30mm.' },
  ]);
});

test('W9 an older offer taken later: the web answer lands right after that offer', async () => {
  const h = mountAsk(true);
  h.render({ user: 'Ben', context: {} });
  await h.ask('Q1');
  await h.settle(0, { answer: OFFER_TEXT, citations: [], web_offer: true });
  await h.ask('Q2');
  await h.settle(1, { answer: 'A2', citations: [] });
  h.offerButtons()[0].props.onClick();
  h.rerender();
  /* Placeholder under the offer, not at the foot of the log. */
  assert.deepStrictEqual(h.log().map(r => r[1]), ['Q1', OFFER_TEXT, 'Searching the web…', 'Q2', 'A2']);
  await h.settle(2, { answer: 'W1', citations: [], from_web: true });
  assert.deepStrictEqual(h.log().map(r => r[1]), ['Q1', OFFER_TEXT, 'W1', 'Q2', 'A2']);
  await h.ask('Q3');
  assert.deepStrictEqual(h.asks[3].history, [
    { question: 'Q1', answer: 'W1' },
    { question: 'Q2', answer: 'A2' },
  ]);
});

test('W10 a failed re-ask gives the button back and the offer pairs again', async () => {
  const h = mountAsk(true);
  h.render({ user: 'Ben', context: {} });
  await h.ask('Q1');
  await h.settle(0, { answer: OFFER_TEXT, citations: [], web_offer: true });
  h.offerButtons()[0].props.onClick();
  h.rerender();
  /* Disabled while anything is in flight -- here, nothing to click at all. */
  assert.strictEqual(h.offerButtons().length, 0);
  await h.fail(1, new Error('boom'));
  assert.strictEqual(h.offerButtons().length, 1);
  assert.strictEqual(h.offerButtons()[0].props.disabled, false);
  await h.ask('Q2');
  assert.deepStrictEqual(h.asks[2].history, [{ question: 'Q1', answer: OFFER_TEXT }]);
});

test('W11 the button is disabled while another question is in flight', async () => {
  const h = mountAsk(true);
  h.render({ user: 'Ben', context: {} });
  await h.ask('Q1');
  await h.settle(0, { answer: OFFER_TEXT, citations: [], web_offer: true });
  await h.ask('Q2');
  assert.strictEqual(h.offerButtons()[0].props.disabled, true);
  h.offerButtons()[0].props.onClick();
  h.rerender();
  assert.strictEqual(h.asks.length, 2, 'a click while busy sent a request');
});
