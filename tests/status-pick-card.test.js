'use strict';

/*
 * The Tasks-page pick card (spec 2026-11-12 §4.3): "Which task was this?",
 * the quote that was heard, one radio per live candidate, "Mark <status>" and,
 * when the caller may answer it, "None of these".
 *
 * The React fake below keeps hook state between renders and runs effects whose
 * deps changed, so a test can click, await the write, and re-render.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/* ---------- a React with real hook state ------------------------------ */

function makeReact() {
  let slots = [];
  let deps = [];
  let cleanups = [];
  let idx = 0;
  let queued = [];
  const React = {
    createElement(type, props, ...children) {
      const flat = [];
      (function push(list) {
        list.forEach(function (c) {
          if (Array.isArray(c)) push(c);
          else if (c !== null && c !== undefined && c !== false) flat.push(c);
        });
      })(children);
      return { type, props: props || {}, children: flat };
    },
    useState(init) {
      const i = idx++;
      if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init;
      return [slots[i], function (v) { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }];
    },
    useRef(v) { const i = idx++; if (!(i in slots)) slots[i] = { current: v }; return slots[i]; },
    useEffect(fn, d) {
      const i = idx++;
      const prev = deps[i];
      if (!prev || !d || d.some(function (x, k) { return x !== prev[k]; })) {
        deps[i] = d;
        queued.push(function () {
          if (cleanups[i]) cleanups[i]();
          cleanups[i] = fn();
        });
      }
    },
    useContext() { return null; },
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn; },
    createContext() { return { Provider: 'Provider' }; },
    Fragment: 'Fragment',
  };
  React.render = function (Comp, props) {
    idx = 0;
    queued = [];
    const tree = Comp(props);
    queued.forEach(function (f) { f(); });
    return tree;
  };
  return React;
}

function walk(node, visit) {
  if (node === null || node === undefined) return;
  if (typeof node !== 'object') { visit(node); return; }
  visit(node);
  (node.children || []).forEach(function (c) { walk(c, visit); });
}
function texts(tree) {
  const out = [];
  walk(tree, function (n) { if (typeof n === 'string' || typeof n === 'number') out.push(String(n)); });
  return out;
}
function find(tree, pred) {
  const out = [];
  walk(tree, function (n) { if (n && typeof n === 'object' && pred(n)) out.push(n); });
  return out;
}
function buttonByText(tree, label) {
  return find(tree, function (n) { return n.type === 'button' && texts(n).join('') === label; })[0];
}
const flush = () => new Promise(function (r) { setImmediate(r); });

/* ---------- load the composite --------------------------------------- */

let decideReply;
let decideCalls;
let listCalls;
let listReply;
let timers;

function load() {
  const React = makeReact();
  global.React = React;
  decideCalls = [];
  listCalls = [];
  timers = [];
  const fakeSetTimeout = function (fn) { timers.push(fn); return timers.length; };
  global.document = { getElementById() { return null; } };
  global.window = {
    FieldSight: {},
    setTimeout: fakeSetTimeout, clearTimeout: function () {},
    FS: {
      api: {
        actions: {
          decidePickCard: async function (id, body) { decideCalls.push({ id, body }); return decideReply; },
          listPickCards:  async function (site) { listCalls.push(site); return listReply; },
        },
      },
    },
  };
  for (const f of ['../scripts/composites/action-item-row.js',
                   '../scripts/composites/status-pick-card.js']) {
    delete require.cache[require.resolve(f)];
    require(f);
  }
  return React;
}

function card(over) {
  return Object.assign({
    id: 'c1', site_id: 's1', site_name: 'Hobson St', status: 'done',
    quote: 'that one is done', created_at: '2026-11-12T00:00:00Z', can_dismiss: true,
    candidates: [
      { stable_id: 'sa', action_item_id: 'a1', text: 'Send the RFI', status: 'open',
        responsible: 'Sarah', task_no: 12, can_choose: true },
      { stable_id: 'sb', action_item_id: 'a2', text: 'Book the crane', status: 'open',
        responsible: 'Tom', task_no: null, can_choose: false },
    ],
  }, over || {});
}

/* ---------- the card ---------------------------------------------------- */

test('card renders quote as text not HTML', () => {
  const React = load();
  const quote = 'it is <b>done</b> now';
  const tree = React.render(window.FieldSight.StatusPickCard, { card: card({ quote }), onDone() {} });
  assert.ok(texts(tree).includes(quote), 'the raw quote is a text child');
  assert.strictEqual(find(tree, function (n) { return n.props && n.props.dangerouslySetInnerHTML; }).length, 0);
  assert.ok(texts(tree).includes('Which task was this?'));
  assert.ok(texts(tree).includes('#12'));
  assert.ok(!texts(tree).some(function (t) { return t === '#null' || t === '#'; }), 'no number, no #');
});

test('candidate with can_choose false is disabled', () => {
  const React = load();
  const tree = React.render(window.FieldSight.StatusPickCard, { card: card(), onDone() {} });
  const radios = find(tree, function (n) { return n.type === 'input' && n.props.type === 'radio'; });
  assert.strictEqual(radios.length, 2);
  assert.strictEqual(!!radios[0].props.disabled, false);
  assert.strictEqual(radios[1].props.disabled, true);
  assert.strictEqual(texts(tree).filter(function (t) { return t === 'not yours to change'; }).length, 1);
});

test('None of these hidden without can_dismiss', () => {
  const React = load();
  let tree = React.render(window.FieldSight.StatusPickCard, { card: card(), onDone() {} });
  assert.ok(buttonByText(tree, 'None of these'));
  load();
  tree = global.React.render(window.FieldSight.StatusPickCard,
                             { card: card({ can_dismiss: false }), onDone() {} });
  assert.strictEqual(buttonByText(tree, 'None of these'), undefined);
});

test('Mark button disabled until a choice', async () => {
  const React = load();
  const props = { card: card(), onDone() {} };
  let tree = React.render(window.FieldSight.StatusPickCard, props);
  assert.strictEqual(buttonByText(tree, 'Mark Done').props.disabled, true);

  const radios = find(tree, function (n) { return n.type === 'input' && n.props.type === 'radio'; });
  radios[0].props.onChange({ target: { value: 'sa' } });
  tree = React.render(window.FieldSight.StatusPickCard, props);
  assert.strictEqual(buttonByText(tree, 'Mark Done').props.disabled, false);
});

test('choose posts the picked candidate and reports the result', async () => {
  const React = load();
  const done = [];
  const props = { card: card(), onDone(c, r) { done.push({ c, r }); } };
  let tree = React.render(window.FieldSight.StatusPickCard, props);
  find(tree, function (n) { return n.type === 'input'; })[0].props.onChange({});
  tree = React.render(window.FieldSight.StatusPickCard, props);
  decideReply = { ok: true, state: 'chosen', status: 'done', action_item_id: 'a1' };
  buttonByText(tree, 'Mark Done').props.onClick({ preventDefault() {}, stopPropagation() {} });
  await flush();
  assert.deepStrictEqual(decideCalls, [{ id: 'c1', body: { decision: 'choose', stable_id: 'sa' } }]);
  assert.strictEqual(done.length, 1);
  assert.strictEqual(done[0].r.action_item_id, 'a1');
});

test('conflict removes card with Already handled', async () => {
  const React = load();
  const done = [];
  const props = { card: card(), onDone(c, r) { done.push({ c, r }); } };
  let tree = React.render(window.FieldSight.StatusPickCard, props);
  decideReply = { ok: false, reason: 'conflict', status: 409, message: 'card already decided' };
  buttonByText(tree, 'None of these').props.onClick({ preventDefault() {}, stopPropagation() {} });
  await flush();
  assert.deepStrictEqual(decideCalls[0].body, { decision: 'none' });
  tree = React.render(window.FieldSight.StatusPickCard, props);
  assert.ok(texts(tree).includes('Already handled'));
  assert.strictEqual(buttonByText(tree, 'None of these'), undefined, 'the choices are gone');
  timers.forEach(function (f) { f(); });
  assert.strictEqual(done.length, 1, 'then the card is handed back for removal');
  assert.strictEqual(done[0].r.reason, 'conflict');
});

test('any other error stays inline and keeps the card', async () => {
  const React = load();
  const done = [];
  const props = { card: card(), onDone(c, r) { done.push(r); } };
  let tree = React.render(window.FieldSight.StatusPickCard, props);
  decideReply = { ok: false, reason: 'error', message: 'Only a PM can answer this.' };
  buttonByText(tree, 'None of these').props.onClick({ preventDefault() {}, stopPropagation() {} });
  await flush();
  tree = React.render(window.FieldSight.StatusPickCard, props);
  assert.ok(texts(tree).includes('Only a PM can answer this.'));
  assert.ok(buttonByText(tree, 'None of these'));
  assert.strictEqual(done.length, 0);
});

/* ---------- the Tasks page -------------------------------------------- */

function loadTasks() {
  const React = load();
  global.window.FS.api.isMineTask = function () { return false; };
  delete require.cache[require.resolve('../scripts/pages/tasks.js')];
  return { React, tasks: require('../scripts/pages/tasks.js') };
}

test('tasks page refetches pick cards on site change', async () => {
  const { React, tasks } = loadTasks();
  listReply = { ok: true, cards: [] };
  const ctx = { activeSite: 'site-A', state: { status: 'ok', rows: [] }, patchRow() {} };
  React.render(tasks.TasksPickCards, { ctx });
  await flush();
  React.render(tasks.TasksPickCards, { ctx });
  assert.deepStrictEqual(listCalls, ['site-A'], 'one read per site, not per render');
  React.render(tasks.TasksPickCards, { ctx: Object.assign({}, ctx, { activeSite: 'site-B' }) });
  await flush();
  assert.deepStrictEqual(listCalls, ['site-A', 'site-B']);

  /* The site comes from the provider's siteContext subscription. */
  const src = fs.readFileSync(path.join(__dirname, '../scripts/pages/tasks.js'), 'utf8');
  assert.match(src, /var ctx = \{[^}]*activeSite:\s*activeSite/);
  assert.match(src, /siteContext\.onChange\(setActiveSite\)/);
});

test('a successful choose patches the matching row and drops the card', async () => {
  const { React, tasks } = loadTasks();
  const patches = [];
  listReply = { ok: true, cards: [card(), card({ id: 'c2' })] };
  const ctx = { activeSite: null,
                state: { status: 'ok', rows: [{ id: 'r9', actionItemId: 'a1', status: 'open' }] },
                patchRow(id, p) { patches.push({ id, p }); } };
  let tree = React.render(tasks.TasksPickCards, { ctx });
  await flush();
  tree = React.render(tasks.TasksPickCards, { ctx });
  const cards = find(tree, function (n) { return n.type === window.FieldSight.StatusPickCard; });
  assert.strictEqual(cards.length, 2);
  cards[0].props.onDone(cards[0].props.card,
                        { ok: true, state: 'chosen', status: 'done', action_item_id: 'a1' });
  assert.deepStrictEqual(patches, [{ id: 'r9', p: { status: 'done', status_suggestion: null } }]);
  tree = React.render(tasks.TasksPickCards, { ctx });
  const left = find(tree, function (n) { return n.type === window.FieldSight.StatusPickCard; });
  assert.deepStrictEqual(left.map(function (n) { return n.props.card.id; }), ['c2']);
});
