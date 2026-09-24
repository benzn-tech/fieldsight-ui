'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

/* The web block used to render only the label and the source domain links --
 * never `web.answer` itself. That was invisible in production because
 * `res.answer` (the message's own text) WAS the web prose: the backend put
 * the same string in both places, so nothing was missing from the page.
 *
 * A backend change in flight (fieldsight-pipeline
 * feat/the-records-get-their-own-answer) makes `res.answer` the GROUNDED
 * answer instead, synthesised from the customer's own records, while the web
 * answer stays in `res.web.answer`. The instant that ships, the web prose
 * disappears from the page: label and links with no text under them.
 *
 * This file locks in the fix -- rendering `m.web.answer` inside the web
 * block -- and its guard against the transition period: this frontend change
 * ships BEFORE the backend one, so today `m.text` and `m.web.answer` are
 * still the same string, and printing both would show the web prose twice.
 */

const askChat = fs.readFileSync(
  require.resolve('../scripts/composites/ask-chat.js'), 'utf8');

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
      const d = new Promise(resolve => { h.pending.push({ resolve }); });
      return d;
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
        n.props.ref.current = { scrollIntoView() {}, focus() {}, querySelectorAll: () => [] };
      }
    });
    h.effects.forEach(e => { if (e.changed) { e.changed = false; e.fn(); } });
    return h.tree;
  };
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
    if (n.props && n.props.dangerouslySetInnerHTML) {
      return n.props.dangerouslySetInnerHTML.__html || '';
    }
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
    for (let k = 0; k < 5; k++) await new Promise(r => setImmediate(r));
    h.rerender();
  };
  return h;
}

test('same string in both fields (today\'s backend): web prose renders once, in the main text, not duplicated in the web block', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: {} });
  await h.ask('What cover does the spec require?');
  await h.settle(0, {
    answer: 'The vendor says 40mm cover.',
    from_web: true,
    web: { answer: 'The vendor says 40mm cover.',
           sources: [{ url: 'https://example.com/spec', title: 'Spec sheet' }] },
  });

  const mainText = h.text(h.byClass('fs-ask-chat__msg-text').slice(-1)[0]);
  assert.strictEqual(mainText, 'The vendor says 40mm cover.');

  const answerNodes = h.byClass('fs-ask-web__answer');
  assert.strictEqual(answerNodes.length, 0,
    'the web block must not repeat text already shown as the main answer');

  // Label and links still render.
  assert.ok(h.byClass('fs-ask-web')[0], 'the web block itself must still render');
  assert.match(h.text(h.byClass('fs-ask-web__label')[0]), /From the open web/);
  assert.ok(h.byClass('fs-ask-web__source')[0], 'source links must still render');
});

test('distinct strings (post-backend-change shape): web prose renders inside the web block, under the label', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: {} });
  await h.ask('What cover does the spec require?');
  await h.settle(0, {
    answer: 'Your team logged 40mm cover on site.',   // grounded answer
    from_web: true,
    web: { answer: 'The vendor spec calls for 40mm cover.',  // web prose, now different
           sources: [{ url: 'https://example.com/spec', title: 'Spec sheet' }] },
  });

  const mainText = h.text(h.byClass('fs-ask-chat__msg-text').slice(-1)[0]);
  assert.strictEqual(mainText, 'Your team logged 40mm cover on site.');

  const answerNodes = h.byClass('fs-ask-web__answer');
  assert.strictEqual(answerNodes.length, 1,
    'the distinct web prose must appear inside the web block');
  assert.strictEqual(h.text(answerNodes[0]), 'The vendor spec calls for 40mm cover.');

  // It must live INSIDE the web block, under the label -- not merged into the
  // grounded answer's own text, and not floating outside fs-ask-web.
  const webBlock = h.byClass('fs-ask-web')[0];
  assert.ok(webBlock.kids.some(k => k === answerNodes[0]) ||
             (function contains(n) {
               return n.kids.some(k => k === answerNodes[0] ||
                 (k && typeof k === 'object' && contains(k)));
             })(webBlock),
    'the web prose must be a descendant of the fs-ask-web block');

  const label = h.text(h.byClass('fs-ask-web__label')[0]);
  assert.match(label, /From the open web/);
});

test('web.answer missing or empty: label and links still render, nothing breaks', async () => {
  const h = mountAsk();
  h.render({ user: 'Ben', context: {} });
  await h.ask('What cover does the spec require?');
  await h.settle(0, {
    answer: 'Some grounded text.',
    from_web: true,
    web: { sources: [{ url: 'https://example.com/spec', title: 'Spec sheet' }] }, // no answer field
  });

  assert.strictEqual(h.byClass('fs-ask-web__answer').length, 0);
  assert.ok(h.byClass('fs-ask-web')[0], 'the web block must still render');
  assert.match(h.text(h.byClass('fs-ask-web__label')[0]), /From the open web/);
  assert.ok(h.byClass('fs-ask-web__source')[0], 'source links must still render');

  // Empty-string case, second message.
  const h2 = mountAsk();
  h2.render({ user: 'Ben', context: {} });
  await h2.ask('What cover does the spec require?');
  await h2.settle(0, {
    answer: 'Some grounded text.',
    from_web: true,
    web: { answer: '', sources: [{ url: 'https://example.com/spec', title: 'Spec sheet' }] },
  });

  assert.strictEqual(h2.byClass('fs-ask-web__answer').length, 0);
  assert.ok(h2.byClass('fs-ask-web')[0], 'the web block must still render for an empty answer too');
});

test('the comparison is the whole point: renderWebOrigin trims and compares before deciding', () => {
  const start = askChat.indexOf('function renderWebOrigin');
  const block = askChat.slice(start, start + 2000);
  assert.match(block, /\.trim\(\)/, 'no trimming guard against whitespace-only differences');
  assert.match(block, /webAnswer !== messageText/, 'no equality check against the duplicate case');
});
