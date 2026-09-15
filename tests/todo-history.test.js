'use strict';
const test = require('node:test');
const assert = require('node:assert');

global.window = { FieldSight: {}, FS: {} };
global.React = { createElement: () => null, useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }), Fragment: 'Fragment' };
const H = require('../scripts/composites/todo-history.js');

const SESSIONS = [{ session_id: 'Benl1_2026-04-29_07-00-00', started_at: '2026-04-29T07:00:00', ended_at: '2026-04-29T07:30:00', title: 'Morning Safety Briefing', topic_count: 1 }];

/* ---- 1: card spec acceptance 1-4 ---------------------------------------- */
test('1.1 extraction item: provenance shows title and start time, linkable', () => {
  assert.deepStrictEqual(
    H.provenanceFor({ sessionId: 'Benl1_2026-04-29_07-00-00', sessionKind: 'extraction' }, SESSIONS),
    { kind: 'extraction', text: 'From Morning Safety Briefing', time: 'Wed 7:00 am', sessionId: 'Benl1_2026-04-29_07-00-00' });
});
test('1.2 report item: From the daily report, no time, no link', () => {
  assert.deepStrictEqual(H.provenanceFor({ sessionId: null, sessionKind: 'report' }, SESSIONS),
    { kind: 'report', text: 'From the daily report', time: null, sessionId: null });
});
test('1.2b extraction id missing from sessions: no time, no link', () => {
  const p = H.provenanceFor({ sessionId: 'gone', sessionKind: 'extraction' }, SESSIONS);
  assert.strictEqual(p.time, null);
  assert.strictEqual(p.sessionId, null);
});
test('1.3 no edits: no version block', () => {
  assert.deepStrictEqual(H.versionsFor([], 'Order boards'), []);
});
test('1.4 history 404 loads identically to an empty list', async () => {
  const deps = (hist) => ({ org: { getSessionsCached: async () => ({ sessions: SESSIONS }) }, actions: { getContentHistory: async () => hist } });
  const props = { open: true, actionItemId: 'ai-1', sessionId: 'Benl1_2026-04-29_07-00-00', sessionKind: 'extraction', date: '2026-04-29', folder: 'Jarley_Trainor', currentText: 'Order boards' };
  const a = H.modelFor(props, await H.loadTodoHistory(props, deps({ _notFound: true })));
  const b = H.modelFor(props, await H.loadTodoHistory(props, deps({ edits: [] })));
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(a.versions, []);
});

/* ---- 2: fourth provenance state ----------------------------------------- */
test('2 unknown or absent kind with a null id: no provenance line', () => {
  assert.strictEqual(H.provenanceFor({ sessionId: null, sessionKind: 'unknown' }, SESSIONS), null);
  assert.strictEqual(H.provenanceFor({ sessionId: null }, SESSIONS), null);
  assert.strictEqual(H.provenanceFor({}, []), null);
});

/* ---- 3: open:false makes no request ------------------------------------- */
test('3 open:false for N hosts: neither getSessions nor getContentHistory called', () => {
  let calls = 0;
  const deps = { org: { getSessionsCached: () => { calls++; return Promise.resolve({}); } },
                 actions: { getContentHistory: () => { calls++; return Promise.resolve({}); } } };
  for (let i = 0; i < 35; i++) {
    assert.strictEqual(H.loadTodoHistory({ open: false, actionItemId: 'ai-' + i, sessionId: 's', date: 'd', folder: 'f' }, deps), null);
  }
  assert.strictEqual(H.loadTodoHistory({ open: true, actionItemId: null }, deps), null, 'legacy row: nothing');
  assert.strictEqual(calls, 0);
});

/* ---- 4: one sessions request per (date, folder), zero after Timeline ---- */
function loadRealApi() {
  const requests = [];
  global.window = { FieldSight: {}, FS: { api: {
    useMocks: false, timelineSource: 'aurora', orgBaseUrl: 'https://org.example/api', delay: () => Promise.resolve(),
    orgRequest: (p) => { requests.push(p); return Promise.resolve(p === '/sessions' ? { sessions: SESSIONS } : { edits: [] }); },
  } } };
  for (const m of ['../scripts/api/_cache.js', '../scripts/api/org.js']) { delete require.cache[require.resolve(m)]; require(m); }
  const deps = { org: window.FS.api.org, actions: { getContentHistory: () => { requests.push('/history'); return Promise.resolve({ edits: [] }); } } };
  return { requests, deps };
}
const OPEN = { open: true, actionItemId: 'ai-1', sessionId: 'Benl1_2026-04-29_07-00-00', sessionKind: 'extraction', date: '2026-04-29', folder: 'Jarley_Trainor' };

test('4a two opens with the same (date, folder): one sessions request', async () => {
  const { requests, deps } = loadRealApi();
  await H.loadTodoHistory(OPEN, deps);
  await H.loadTodoHistory(Object.assign({}, OPEN, { actionItemId: 'ai-2' }), deps);
  assert.strictEqual(requests.filter((r) => r === '/sessions').length, 1);
  assert.strictEqual(requests.filter((r) => r === '/history').length, 2, 'history is not cached');
});
test('4b after the Timeline day fetch populated the key, an open makes zero sessions requests', async () => {
  const { requests, deps } = loadRealApi();
  await window.FS.api.org.getSessionsCached('2026-04-29', 'Jarley_Trainor');   // what timeline.js:1791 now does
  const before = requests.filter((r) => r === '/sessions').length;
  await H.loadTodoHistory(OPEN, deps);
  assert.strictEqual(requests.filter((r) => r === '/sessions').length - before, 0);
});

/* ---- 5: {_notFound} = empty, no toast ------------------------------------ */
test('5 {_notFound} history: same output as empty, no toast', async () => {
  const toasts = [];
  global.window = { FieldSight: {}, FS: { toast: { show: (t) => toasts.push(t) } } };
  const deps = { org: {}, actions: { getContentHistory: async () => ({ _notFound: true }) } };
  const loaded = await H.loadTodoHistory({ open: true, actionItemId: 'ai-1' }, deps);
  assert.deepStrictEqual(loaded, { sessions: [], edits: [] });
  assert.strictEqual(toasts.length, 0);
});

/* ---- 6: NULL actor_name ------------------------------------------------- */
test('6 NULL actor_name renders edited by someone', () => {
  assert.strictEqual(H.editedBy({ actor_name: null }), 'edited by someone');
  assert.strictEqual(H.editedBy({ actor_name: 'Ben_UCPK2' }), 'edited by Ben_UCPK2');
  assert.strictEqual(H.versionsFor([{ field: 'status', after_text: 'done', actor_name: null }], 'x')[0].who, 'edited by someone');
});

/* ---- 7: §3.4 numbering -------------------------------------------------- */
test('7a edits [text, deadline, status] newest first -> v4..v2 then v1 as recorded', () => {
  const edits = [
    { field: 'text',     before_text: 'Book crane Wed', after_text: 'Book crane Thu', actor_name: 'A', created_at: '2026-09-15T03:00:00+00:00' },
    { field: 'deadline', before_text: null, after_text: '2026-09-18', actor_name: 'A', created_at: '2026-09-15T02:00:00+00:00' },
    { field: 'status',   before_text: 'open', after_text: 'done', actor_name: 'A', created_at: '2026-09-15T01:00:00+00:00' },
  ];
  const v = H.versionsFor(edits, 'Book crane Thu');
  assert.deepStrictEqual(v.map((x) => [x.heading, x.body]), [
    ['v4', 'Book crane Thu'],
    ['v3', 'deadline changed to Fri 18 Sep'],
    ['v2', 'status changed to done'],
    ['v1 · as recorded', 'Book crane Wed'],
  ]);
});
test('7b no text edit: v1 shows the current text', () => {
  const v = H.versionsFor([{ field: 'priority', after_text: 'high', actor_name: 'A' }], 'Order boards');
  assert.deepStrictEqual(v.map((x) => [x.heading, x.body]), [['v2', 'priority changed to high'], ['v1 · as recorded', 'Order boards']]);
});
test('7c v1 uses the OLDEST text edit before_text when there are several', () => {
  const v = H.versionsFor([
    { field: 'text', before_text: 'B', after_text: 'C' },
    { field: 'text', before_text: 'A', after_text: 'B' },
  ], 'C');
  assert.strictEqual(v[v.length - 1].body, 'A');
});
test('7d responsible edits from either endpoint read the same', () => {
  assert.strictEqual(H.fieldSentence({ field: 'responsible', after_text: 'Aaron' }), 'responsible changed to Aaron');
  assert.strictEqual(H.fieldSentence({ field: 'deadline', after_text: null }), 'deadline cleared');
});
test('formatWhen: zoned ISO is shown in NZ time', () => {
  assert.strictEqual(H.formatWhen('2026-09-15T22:23:00Z'), 'Wed 10:23 am');   // NZST +12
  assert.strictEqual(H.formatWhen(''), '');
});

/* ---- 10a: TodoHistory refreshes on a matching content:edited ------------- */
const fsx = require('node:fs');
const pathx = require('node:path');
const todoSrc = fsx.readFileSync(pathx.join(__dirname, '..', 'scripts', 'composites', 'todo-history.js'), 'utf8').replace(/\r\n/g, '\n');

test('10a SOURCE SCAN: TodoHistory subscribes via onContentEdited on its own id while open', () => {
  const b = todoSrc.slice(todoSrc.indexOf('function TodoHistory('));
  assert.match(b, /onContentEdited\('action_items', props\.actionItemId,/);
  assert.match(b, /if \(!props\.open \|\| !props\.actionItemId/);
});

test('10a matching id re-runs the loader, a different id does not (real FS.events)', async () => {
  const { createEvents } = require('../scripts/api/events.js');
  const ev = createEvents();
  let loads = 0;
  const reload = () => { loads++; };
  ev.onContentEdited('action_items', 'ai-1', reload);          // exactly what TodoHistory registers
  ev.emit('content:edited', { table: 'action_items', id: 'ai-2' });
  assert.strictEqual(loads, 0);
  ev.emit('content:edited', { table: 'action_items', id: 'ai-1' });
  assert.strictEqual(loads, 1);
});

test('TodoHistory statics exist on the window registration', () => {
  global.window = { FieldSight: {}, FS: {} };
  delete require.cache[require.resolve('../scripts/composites/todo-history.js')];
  require('../scripts/composites/todo-history.js');
  const T = window.FieldSight.TodoHistory;
  assert.strictEqual(typeof T, 'function');
  assert.strictEqual(typeof T.View, 'function');
  assert.strictEqual(typeof T.provenanceFor, 'function');
});

test('TodoHistory closed renders nothing without FS.api (components-preview posture)', () => {
  global.window = { FieldSight: {}, FS: {} };
  delete require.cache[require.resolve('../scripts/composites/todo-history.js')];
  require('../scripts/composites/todo-history.js');
  assert.strictEqual(window.FieldSight.TodoHistory({ open: false, actionItemId: 'x' }), null);
  assert.strictEqual(window.FieldSight.TodoHistory({ open: true }), null);
});

/* ---- review fix: drive the REAL component through a recording React ------
   10a's coverage above pins wiring only (a regex, and FS.events exercised
   directly without ever importing todo-history.js) — an emptied subscription
   callback, or `tick` dropped from the fetch effect's deps, would still pass
   both. This harness actually calls TodoHistory(props), runs the hooks it
   registers, and re-renders to pick up state changes and re-run effects
   whose deps changed — the same contract React itself gives components. */
function makeHookHarness() {
  const stateSlots = [];
  const refSlots = [];
  const effectSlots = []; // { deps, cleanup }
  let stateIdx, refIdx, effectIdx, pending;

  function shallowDiff(a, b) {
    if (!a || !b || a.length !== b.length) return true;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
    return false;
  }

  function render(Component, props) {
    stateIdx = 0; refIdx = 0; effectIdx = 0; pending = [];
    const HookReact = {
      createElement(type, p, ...children) { return { type: type, props: p || {}, children: children }; },
      Fragment: 'Fragment',
      useState(initial) {
        const i = stateIdx++;
        if (!(i in stateSlots)) stateSlots[i] = (typeof initial === 'function') ? initial() : initial;
        const setter = (updater) => {
          stateSlots[i] = (typeof updater === 'function') ? updater(stateSlots[i]) : updater;
        };
        return [stateSlots[i], setter];
      },
      useRef(v) {
        const i = refIdx++;
        if (!(i in refSlots)) refSlots[i] = { current: v };
        return refSlots[i];
      },
      useEffect(fn, deps) {
        const i = effectIdx++;
        const prev = effectSlots[i];
        const changed = !prev || shallowDiff(prev.deps, deps);
        pending.push({ i: i, fn: fn, deps: deps, changed: changed, prevCleanup: prev && prev.cleanup });
      },
    };
    global.React = HookReact;
    const tree = Component(props);
    pending.forEach(function (e) {
      if (!e.changed) return;
      if (e.prevCleanup) e.prevCleanup();
      const cleanup = e.fn();
      effectSlots[e.i] = { deps: e.deps, cleanup: cleanup };
    });
    return tree;
  }

  return { render: render };
}

async function flush() {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}

function loadDrivenTodoHistory(events, getContentHistory, getSessionsCached) {
  global.window = {
    FieldSight: {},
    FS: { api: { org: { getSessionsCached: getSessionsCached }, actions: { getContentHistory: getContentHistory } }, events: events },
  };
  delete require.cache[require.resolve('../scripts/composites/todo-history.js')];
  require('../scripts/composites/todo-history.js');
  return window.FieldSight.TodoHistory;
}

test('10b DRIVEN: matching content:edited re-runs the loader and re-fires onVersion; other id/table do not', async () => {
  const { createEvents } = require('../scripts/api/events.js');
  const events = createEvents();
  let historyCalls = 0, sessionsCalls = 0;
  const edits = [{ field: 'text', before_text: 'Order boards', after_text: 'Order replacement boards', actor_name: 'A', created_at: '2026-04-29T02:00:00+00:00' }];
  const getContentHistory = async () => { historyCalls++; return { edits: edits }; };
  const getSessionsCached = async () => { sessionsCalls++; return { sessions: [] }; };
  const TodoHistory = loadDrivenTodoHistory(events, getContentHistory, getSessionsCached);

  const versionCalls = [];
  const props = {
    open: true, actionItemId: 'ai-1', sessionId: 'S1', sessionKind: 'extraction',
    date: '2026-04-29', folder: 'Benl1', currentText: 'Order replacement boards',
    onVersion: (n) => versionCalls.push(n),
  };

  const h = makeHookHarness();
  h.render(TodoHistory, props);
  await flush();
  assert.strictEqual(historyCalls, 1, 'opening should call getContentHistory once');
  assert.deepStrictEqual(versionCalls, [1 + edits.length], 'onVersion must fire with 1 + edits.length after the initial load');

  events.emit('content:edited', { table: 'action_items', id: 'ai-1' });   // matching -> bumps tick
  h.render(TodoHistory, props);   // re-render: fetch effect deps include tick, must re-run
  await flush();
  assert.strictEqual(historyCalls, 2, 'a matching content:edited must re-run the loader');
  assert.deepStrictEqual(versionCalls, [1 + edits.length, 1 + edits.length]);

  events.emit('content:edited', { table: 'action_items', id: 'ai-2' });   // different id
  events.emit('content:edited', { table: 'topics', id: 'ai-1' });         // different table
  h.render(TodoHistory, props);
  await flush();
  assert.strictEqual(historyCalls, 2, 'a different id or table must not re-run the loader');
  assert.strictEqual(sessionsCalls, 2, 'sessions is fetched alongside history each real load, not on the no-op renders');
});

test('10b DRIVEN: open:false makes zero calls and subscribes to nothing', async () => {
  const { createEvents } = require('../scripts/api/events.js');
  const events = createEvents();
  let historyCalls = 0, sessionsCalls = 0;
  const getContentHistory = async () => { historyCalls++; return { edits: [] }; };
  const getSessionsCached = async () => { sessionsCalls++; return { sessions: [] }; };
  const TodoHistory = loadDrivenTodoHistory(events, getContentHistory, getSessionsCached);

  const h = makeHookHarness();
  h.render(TodoHistory, { open: false, actionItemId: 'ai-1', sessionId: 'S1', date: '2026-04-29', folder: 'Benl1' });
  await flush();
  assert.strictEqual(historyCalls, 0);
  assert.strictEqual(sessionsCalls, 0);

  /* No subscription: emitting a matching event must not cause a later
     re-render to see any additional calls (there is nothing to bump). */
  events.emit('content:edited', { table: 'action_items', id: 'ai-1' });
  h.render(TodoHistory, { open: false, actionItemId: 'ai-1', sessionId: 'S1', date: '2026-04-29', folder: 'Benl1' });
  await flush();
  assert.strictEqual(historyCalls, 0);
  assert.strictEqual(sessionsCalls, 0);
});
