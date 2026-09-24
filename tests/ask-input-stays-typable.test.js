'use strict';
const test = require('node:test');
const assert = require('node:assert');

/* Reported from the browser 2026-09-22: the Ask box goes dead the moment a
   question is sent, for the whole wait -- 8.6s at p90 on the plain path, 13-17s
   once corroboration runs. Two costs, and the second is the one that is easy to
   miss in a diff: `disabled` also drops focus, so when the answer lands the
   person is not back in the box, they have to click into it again.

   Nothing throws when this regresses. The box just goes back to being dead, so
   the property is pinned here rather than the line that implements it. */

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = () => new Promise(r => setImmediate(r));

function mount() {
  delete require.cache[require.resolve('../scripts/composites/ask-chat.js')];
  const h = { states: [], refs: [], effects: [], pending: [] };
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
    useEffect(fn, deps) { const i = ei++; h.effects[i] = { fn, deps }; },
  };
  global.document = { addEventListener() {}, removeEventListener() {} };
  global.window = {
    FieldSight: { renderMarkdown: s => s },
    FS: { api: { ask: { ask() { const d = deferred(); h.pending.push(d); return d.promise; } } } },
  };
  require('../scripts/composites/ask-chat.js');
  const AskChat = global.window.FieldSight.AskChat;

  h.render = function (props) {
    si = 0; ri = 0; ei = 0;
    h.tree = AskChat(props || {});
    return h.tree;
  };
  h.nodes = function () {
    const out = [];
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      out.push(n);
      (n.kids || []).forEach(walk);
    })(h.tree);
    return out;
  };
  h.byClass = c => h.nodes().filter(n =>
    n.props && String(n.props.className || '').split(' ').includes(c));
  h.input = () => h.byClass('fs-ask-chat__input')[0];
  h.send = () => h.byClass('fs-ask-chat__send')[0];
  return h;
}

test('the box stays typable while the previous question is still running', async () => {
  const h = mount();
  h.render({ user: 'Ben' });

  h.input().props.onChange({ target: { value: 'first question' } });
  h.render({ user: 'Ben' });
  h.tree.kids.flat(Infinity);
  const form = h.byClass('fs-ask-chat__form')[0];
  form.props.onSubmit({ preventDefault() {} });
  h.render({ user: 'Ben' });

  assert.strictEqual(h.pending.length, 1, 'the question was never sent');
  assert.strictEqual(h.send().kids[0], '…', 'the wait is not showing on the button');

  /* The point of the whole test. */
  assert.ok(!h.input().props.disabled,
    'the input is locked while an answer is in flight');

  /* And a send button that stays disabled is what keeps a second question from
     racing the first -- the lock belongs there, not on the box. */
  assert.strictEqual(h.send().props.disabled, true);
});

test('typing ahead during the wait is kept, not swallowed', async () => {
  const h = mount();
  h.render({ user: 'Ben' });
  h.input().props.onChange({ target: { value: 'first' } });
  h.render({ user: 'Ben' });
  h.byClass('fs-ask-chat__form')[0].props.onSubmit({ preventDefault() {} });
  h.render({ user: 'Ben' });

  /* Type the next one while the first is still out. */
  h.input().props.onChange({ target: { value: 'second question' } });
  h.render({ user: 'Ben' });
  assert.strictEqual(h.input().props.value, 'second question');

  /* An impatient Enter must not lose it: send() refuses while busy and only
     clears the box on a send that actually happened. */
  h.byClass('fs-ask-chat__form')[0].props.onSubmit({ preventDefault() {} });
  h.render({ user: 'Ben' });
  assert.strictEqual(h.pending.length, 1, 'a second request raced the first');
  assert.strictEqual(h.input().props.value, 'second question',
    'the typed-ahead question was cleared by an Enter that sent nothing');

  h.pending[0].resolve({ answer: 'a', citations: [] });
  for (let k = 0; k < 5; k++) await flush();
  h.render({ user: 'Ben' });
  assert.strictEqual(h.input().props.value, 'second question',
    'the typed-ahead question did not survive the answer landing');
  assert.strictEqual(h.send().kids[0], 'Ask');
});
