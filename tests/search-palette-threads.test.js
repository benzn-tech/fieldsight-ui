'use strict';

/*
 * The palette's "Recent conversations" (spec 2026-10-22 ask-conversation-history
 * D1/D7/§7, plan task 9), behind FS.api.askThreadsOn.
 *
 * - Flag on: up to five stored conversations (FS.api.askThreads.list) ABOVE
 *   the keyword "Recent searches"; opening one fetches it and seeds the inline
 *   AskChat (`initialThread`, `threads: true`, no auto-sent question); Delete
 *   removes the row and the thread. Asking no longer lands in
 *   fs.search.recent -- a conversation is re-read, a search is re-run.
 * - Flag off: no request, no section, and Ask still saves to recents exactly
 *   as today.
 * - A failed list hides the section; "Recent searches" stays.
 * - The docked Timeline AskChat never sends thread fields (D7).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TID = '0123456789abcdef0123456789abcdef';

function flush() { return new Promise(r => setImmediate(r)); }
async function settle(h) { for (let k = 0; k < 6; k++) await flush(); h.rerender(); }

function rows(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ thread_id: String(i).repeat(32),
               title: 'Conversation ' + i, updated_at: 1761000000 - i * 60, turns: 1 });
  }
  return out;
}

/* A hooks harness for SearchPalette: lazy useState (the palette reads
   sessionStorage in one), effects re-run on changed deps with cleanup. */
function mountPalette(opts) {
  opts = opts || {};
  delete require.cache[require.resolve('../scripts/composites/search-palette.js')];
  const h = { states: [], refs: [], effects: [], calls: { list: 0, get: [], remove: [] },
              nav: [], toasts: [] };
  let si = 0, ri = 0, ei = 0;
  global.React = {
    Fragment: 'Fragment',
    createElement(type, props, ...kids) { return { type, props: props || {}, kids }; },
    useState(init) {
      const i = si++;
      if (!(i in h.states)) h.states[i] = typeof init === 'function' ? init() : init;
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
      h.effects[i] = { fn, deps, changed: changed || (prev && prev.changed),
                       cleanup: prev && prev.cleanup };
    },
  };
  const store = Object.assign({}, opts.session || {});
  h.store = store;
  global.sessionStorage = {
    getItem(k) { return k in store ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
  global.document = { addEventListener() {}, removeEventListener() {} };
  function AskChatStub() { return null; }
  AskChatStub._answeredDay = function () { return 'Tue 20 Oct'; };
  h.AskChat = AskChatStub;
  const T = {
    list() { h.calls.list++; return opts.list ? opts.list() : Promise.resolve([]); },
    get(id) { h.calls.get.push(id); return opts.get ? opts.get(id) : Promise.resolve(null); },
    remove(id) { h.calls.remove.push(id); return Promise.resolve(true); },
  };
  const api = {
    useMocks: false,
    todayNZDT: () => '2026-10-22',
    window: { getSpan: () => Promise.resolve({ earliest: '2026-10-01', latest: '2026-10-22' }) },
    sites: { getSites: () => Promise.resolve({ sites: [{ site_id: 's1', name: 'Pod 3', location: 'Chch' }] }),
             getUsers: () => Promise.resolve({ users: [] }) },
    tasks: { getActionsResolvedRange: () => Promise.resolve({ rows: [] }) },
    compliance: { getSafetyRange: () => Promise.resolve({ rows: [] }) },
    askThreads: T,
  };
  if (opts.flag !== undefined) api.askThreadsOn = opts.flag;
  /* Threads are stored only on the async turn (the sync /api/ask path drops
     the fields), so the palette's switch is askThreadsOn && askAsync. On
     unless a test says otherwise. */
  api.askAsync = opts.async !== undefined ? opts.async : true;
  global.window = {
    FieldSight: { AskChat: AskChatStub },
    FS: { api: api, Router: { navigate(u) { h.nav.push(u); } },
          toast: { show(t) { h.toasts.push(t); } } },
  };
  require('../scripts/composites/search-palette.js');
  const SearchPalette = global.window.FieldSight.SearchPalette;

  h.render = function (props) {
    si = 0; ri = 0; ei = 0;
    h.props = props || { onClose() { h.closed = true; } };
    h.tree = SearchPalette(h.props);
    h.nodes().forEach(n => {
      if (n.props.ref && n.props.ref.current == null) {
        n.props.ref.current = { focus() {}, querySelector() { return null; } };
      }
    });
    h.effects.forEach(e => {
      if (!e.changed) return;
      e.changed = false;
      if (typeof e.cleanup === 'function') e.cleanup();
      e.cleanup = e.fn();
    });
    return h.tree;
  };
  h.rerender = () => h.render(h.props);
  h.unmount = () => h.effects.forEach(e => { if (typeof e.cleanup === 'function') e.cleanup(); });
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
  h.groupLabels = () => h.byClass('fs-search-palette__group-label').map(h.text);
  h.convRows = () => h.byClass('fs-search-palette__conv');
  h.type = function (q) {
    h.byClass('fs-search-palette__input')[0].props.onChange({ target: { value: q } });
    h.rerender();
    h.rerender();   /* the query effect's setResults lands on the next render */
  };
  h.askRow = () => h.byClass('fs-search-palette__result').find(n => h.text(n).indexOf('Ask:') === 0);
  h.askChat = () => h.nodes().find(n => n.type === AskChatStub);
  return h;
}

test('P1 flag on: Recent conversations above Recent searches, up to 5, from askThreads.list', async () => {
  const h = mountPalette({ flag: true, session: { 'fs.search.recent': JSON.stringify(['slab pour']) },
                           list: () => Promise.resolve(rows(6)) });
  h.render();
  await settle(h);
  assert.strictEqual(h.calls.list, 1);
  assert.deepStrictEqual(h.groupLabels(), ['Recent conversations', 'Recent searches']);
  const convs = h.convRows();
  assert.strictEqual(convs.length, 5);
  assert.ok(h.text(convs[0]).includes('Conversation 0'));
  assert.ok(h.text(convs[0]).includes('Tue 20 Oct'), 'the row says when');
  h.unmount();
});

test('P1b flag on with conversations but no recent searches: the section still shows', async () => {
  const h = mountPalette({ flag: true, list: () => Promise.resolve(rows(2)) });
  h.render();
  await settle(h);
  assert.deepStrictEqual(h.groupLabels(), ['Recent conversations']);
  assert.strictEqual(h.byClass('fs-search-palette__hint').length, 0);
  h.unmount();
});

test('P2 asking no longer adds to fs.search.recent; keyword search still does', async () => {
  const h = mountPalette({ flag: true });
  h.render();
  await settle(h);
  h.type('when did we pour');
  h.askRow().props.onClick();
  h.rerender();
  assert.strictEqual(h.store['fs.search.recent'], undefined, 'an Ask question was saved as a recent search');
  const chat = h.askChat();
  assert.ok(chat, 'the inline AskChat did not open');
  assert.strictEqual(chat.props.initialQuestion, 'when did we pour');
  assert.strictEqual(chat.props.threads, true);
  assert.ok(!chat.props.initialThread);
  h.unmount();

  const k = mountPalette({ flag: true });
  k.render();
  await settle(k);           /* the client cache (sites) has loaded */
  k.type('Pod');
  const site = k.byClass('fs-search-palette__result').find(n => k.text(n).includes('Pod 3'));
  site.props.onClick();
  assert.deepStrictEqual(JSON.parse(k.store['fs.search.recent']), ['Pod']);
  k.unmount();
});

test('P3 clicking a conversation fetches it and opens AskChat with initialThread', async () => {
  const thread = { thread_id: TID, scope: {}, turns: [{ turn_id: 't', question: 'Q1', at: 1, request: {}, result: { answer: 'A1' } }] };
  const h = mountPalette({ flag: true,
    list: () => Promise.resolve([{ thread_id: TID, title: 'Q1', updated_at: 1, turns: 1 }]),
    get: () => Promise.resolve(thread) });
  h.render();
  await settle(h);
  h.byClass('fs-search-palette__conv-open')[0].props.onClick();
  await settle(h);
  assert.deepStrictEqual(h.calls.get, [TID]);
  const chat = h.askChat();
  assert.ok(chat, 'AskChat did not open');
  assert.strictEqual(chat.props.initialThread, thread);
  assert.strictEqual(chat.props.threads, true);
  assert.ok(!chat.props.initialQuestion, 'a stored conversation must not auto-send');
  assert.strictEqual(chat.props.key, TID);
  assert.strictEqual(h.text(h.byClass('fs-search-palette__ask-question')[0]), 'Q1');
  /* Opening is reading: nothing lands in recent searches. */
  assert.strictEqual(h.store['fs.search.recent'], undefined);
  h.unmount();
});

test('P3b a conversation that is gone by the time it is opened drops its row', async () => {
  const h = mountPalette({ flag: true,
    list: () => Promise.resolve([{ thread_id: TID, title: 'Q1', updated_at: 1, turns: 1 }]),
    get: () => Promise.resolve(null) });
  h.render();
  await settle(h);
  h.byClass('fs-search-palette__conv-open')[0].props.onClick();
  await settle(h);
  assert.ok(!h.askChat());
  assert.strictEqual(h.convRows().length, 0);
  assert.strictEqual(h.toasts.length, 1);
  h.unmount();
});

test('P4 Delete removes the row and calls askThreads.remove', async () => {
  const list = rows(3);
  const h = mountPalette({ flag: true, list: () => Promise.resolve(list) });
  h.render();
  await settle(h);
  const del = h.byClass('fs-search-palette__conv-delete');
  assert.strictEqual(del.length, 3);
  assert.strictEqual(del[1].type, 'button');
  assert.match(del[1].props['aria-label'], /^Delete conversation/);
  /* Not nested in the open button: two sibling controls. */
  assert.strictEqual(h.byClass('fs-search-palette__conv')[1].type, 'div');
  del[1].props.onClick({ stopPropagation() {} });
  await settle(h);
  assert.deepStrictEqual(h.calls.remove, [list[1].thread_id]);
  assert.deepStrictEqual(h.convRows().map(h.text).map(t => t.includes('Conversation 1')), [false, false]);
  assert.strictEqual(h.convRows().length, 2);
  h.unmount();
});

test('P5 flag off: no request, no section, today\'s behaviour', async () => {
  for (const flag of [undefined, false]) {
    const h = mountPalette({ flag: flag, session: { 'fs.search.recent': JSON.stringify(['slab pour']) },
                             list: () => Promise.resolve(rows(3)) });
    h.render();
    await settle(h);
    assert.strictEqual(h.calls.list, 0, 'the list was requested with the flag off');
    assert.deepStrictEqual(h.groupLabels(), ['Recent searches']);
    assert.strictEqual(h.convRows().length, 0);
    /* Asking still saves the question, as it does today. */
    h.type('when did we pour');
    h.askRow().props.onClick();
    h.rerender();
    assert.deepStrictEqual(JSON.parse(h.store['fs.search.recent']), ['when did we pour', 'slab pour']);
    const chat = h.askChat();
    assert.strictEqual(chat.props.initialQuestion, 'when did we pour');
    assert.ok(!chat.props.threads);
    assert.ok(!chat.props.initialThread);
    h.unmount();
  }
});

test('P6 list failure hides the section and keeps Recent searches', async () => {
  const warn = console.warn;
  console.warn = function () {};
  try {
    const h = mountPalette({ flag: true, session: { 'fs.search.recent': JSON.stringify(['slab pour']) },
                             list: () => Promise.reject(Object.assign(new Error('HTTP 502'), { status: 502 })) });
    h.render();
    await settle(h);
    assert.deepStrictEqual(h.groupLabels(), ['Recent searches']);
    assert.strictEqual(h.convRows().length, 0);
    h.unmount();
  } finally {
    console.warn = warn;
  }
});

test('P8 threads on but async off: the switch is off -- no list, Ask still saved to recents, no threads prop', async () => {
  for (const combo of [{ flag: true, async: false }, { flag: false, async: true }]) {
    const h = mountPalette(Object.assign({ session: { 'fs.search.recent': JSON.stringify(['slab pour']) },
                                           list: () => Promise.resolve(rows(3)) }, combo));
    h.render();
    await settle(h);
    assert.strictEqual(h.calls.list, 0, 'list requested for ' + JSON.stringify(combo));
    assert.deepStrictEqual(h.groupLabels(), ['Recent searches']);
    h.type('when did we pour');
    h.askRow().props.onClick();
    h.rerender();
    assert.deepStrictEqual(JSON.parse(h.store['fs.search.recent']), ['when did we pour', 'slab pour'],
      'the question vanished for ' + JSON.stringify(combo));
    assert.ok(!h.askChat().props.threads);
    h.unmount();
  }
  /* Both on: the switch is on. */
  const h = mountPalette({ flag: true, async: true, list: () => Promise.resolve(rows(1)) });
  h.render();
  await settle(h);
  assert.strictEqual(h.calls.list, 1);
  h.type('q');
  h.askRow().props.onClick();
  h.rerender();
  assert.strictEqual(h.askChat().props.threads, true);
  assert.strictEqual(h.store['fs.search.recent'], undefined);
  h.unmount();
});

test('P9 Back to search refreshes the list, so a conversation started in this open appears', async () => {
  let served = [];
  const h = mountPalette({ flag: true, list: () => Promise.resolve(served.slice()) });
  h.render();
  await settle(h);
  assert.strictEqual(h.calls.list, 1);
  assert.strictEqual(h.convRows().length, 0);
  h.type('when did we pour');
  h.askRow().props.onClick();
  h.rerender();
  /* The inline AskChat stores the turn server-side... */
  served = [{ thread_id: TID, title: 'when did we pour', updated_at: 1761000000, turns: 1 }];
  h.byClass('fs-search-palette__ask-back')[0].props.onClick();
  h.type('');
  await settle(h);
  assert.strictEqual(h.calls.list, 2, 'Back to search did not refresh the list');
  assert.strictEqual(h.convRows().length, 1);
  assert.ok(h.text(h.convRows()[0]).includes('when did we pour'));
  h.unmount();
});

test('P9b Back to search with the switch off makes no request', async () => {
  const h = mountPalette({ flag: true, async: false });
  h.render();
  await settle(h);
  h.type('q');
  h.askRow().props.onClick();
  h.rerender();
  h.byClass('fs-search-palette__ask-back')[0].props.onClick();
  await settle(h);
  assert.strictEqual(h.calls.list, 0);
  h.unmount();
});

/* ---- D7: the docked Timeline AskChat never stores --------------------------- */

test('P7 docked Timeline AskChat sends no thread fields', async () => {
  /* The mount itself names neither prop... */
  const src = fs.readFileSync(path.join(ROOT, 'scripts/pages/timeline.js'), 'utf8');
  const at = src.indexOf("React.createElement(AskChat, {");
  assert.ok(at > 0, 'the dock mount was not found');
  const mount = src.slice(at, src.indexOf('}),', at));
  assert.match(mount, /variant:\s*'dock'/);
  assert.doesNotMatch(mount, /\bthreads\s*:/);
  assert.doesNotMatch(mount, /\binitialThread\s*:/);

  /* ...and AskChat rendered the way the dock renders it sends none. */
  delete require.cache[require.resolve('../scripts/composites/ask-chat.js')];
  const st = []; const refs = []; const effects = []; const asks = [];
  let si = 0, ri = 0, ei = 0;
  global.React = {
    Fragment: 'Fragment',
    createElement(type, props, ...kids) { return { type, props: props || {}, kids }; },
    useState(init) { const i = si++; if (!(i in st)) st[i] = init; return [st[i], v => { st[i] = typeof v === 'function' ? v(st[i]) : v; }]; },
    useRef(init) { const i = ri++; if (!(i in refs)) refs[i] = { current: init }; return refs[i]; },
    useEffect(fn, deps) {
      const i = ei++; const prev = effects[i];
      effects[i] = { fn, deps, changed: !prev || !deps || deps.some((d, k) => d !== prev.deps[k]) };
    },
  };
  global.document = { addEventListener() {}, removeEventListener() {} };
  global.window = { FieldSight: { renderMarkdown: s => s }, FS: { api: {
    askThreadsOn: true, askWebOffer: true,
    ask: { ask(body) { asks.push(body); return new Promise(() => {}); } },
  } } };
  require('../scripts/composites/ask-chat.js');
  const AskChat = global.window.FieldSight.AskChat;
  const props = { variant: 'dock', user: 'Ben_Lin', context: { date: '2026-10-20' },
                  onContextChange() {}, initialQuestion: 'what happened today' };
  function render() {
    si = 0; ri = 0; ei = 0;
    const tree = AskChat(props);
    (function walk(n) {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      if (n.props.ref && n.props.ref.current == null) {
        n.props.ref.current = { scrollIntoView() {}, focus() {}, querySelectorAll() { return []; } };
      }
      n.kids.forEach(walk);
    })(tree);
    effects.forEach(e => { if (e.changed) { e.changed = false; e.fn(); } });
  }
  render();
  render();
  assert.strictEqual(asks.length, 1);
  assert.ok(!('thread_id' in asks[0]) && !('new_thread' in asks[0]),
    'the docked Ask sent a thread field: ' + JSON.stringify(asks[0]));
});
