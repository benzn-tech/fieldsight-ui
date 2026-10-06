'use strict';

/*
 * Done means the task is done.
 *
 * The legacy gateway's /actions overlay (DynamoDB tick map, readable and
 * writable by any signed-in user of any company) is gone from this client.
 * A task is done when its own action_items.status === 'done', read from the
 * org payload the page already has. These tests pin, reader by reader:
 *
 *   - an item with status 'done' and NO overlay is done;
 *   - an item with status 'open' is NOT done even when something is offering
 *     an overlay that says checked (each stub below THROWS if the old
 *     getActions / getActionsRange / lookupAction is called, so a regression
 *     that re-reads the overlay fails loudly rather than quietly agreeing);
 *   - no module issues /actions or /actions/toggle, and the legacy functions
 *     are not exported any more;
 *   - an item with no actionItemId renders read-only (no toggle), and a 403
 *     from the PATCH surfaces to the user and reverts the box instead of
 *     leaving a fake tick.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/* ---- shared harness ------------------------------------------------------ */

const toasts = [];
const busEvents = [];
let orgResult = null;
const orgCalls = [];

function boom(name) {
  return function () { throw new Error('legacy overlay call: ' + name); };
}

const REPORT_DATE = '2026-07-20';
const REPORT = {
  report_date: REPORT_DATE, site: 'Test Site', user_name: 'Jane Doe',
  executive_summary: [], safety_observations: [],
  topics: [{
    topic_id: 0, category: 'progress', topic_title: 'T', time_range: '08:00 – 08:30',
    participants: ['Jane Doe'],
    action_items: [
      { id: 'ai-done', action: 'done item', responsible: 'Jane Doe', status: 'done',
        updated_by_name: 'Sam Closer', updated_at: '2026-07-20T01:00:00Z' },
      { id: 'ai-open', action: 'open item', responsible: 'Jane Doe', status: 'open' },
      { id: 'ai-null', action: 'no status item', responsible: 'Jane Doe' },
    ],
  }],
};

global.window = {
  FieldSight: {},
  AuthMock: { currentUser: { name: 'Jane Doe', role: 'admin' } },
  FS: {
    toast: { show: function (t) { toasts.push(t); } },
    actionsBus: { emit: function (p) { busEvents.push(p); } },
    api: {
      useMocks: false, writeMocks: false,
      timelineSource: 'aurora', orgBaseUrl: 'https://org.example/api',
      delay: function () { return Promise.resolve(); },
      folderName: function (n) { return String(n || '').replace(/ /g, '_'); },
      callerFolder: function () { var u = (global.window.AuthMock && global.window.AuthMock.currentUser) || {}; return u.folder_name || (this.useMocks && u.name ? String(u.name).trim().replace(/\s+/g, '_') : null); },
      /* The tripwire: the legacy gateway. Nothing may call it. */
      request: boom('request'),
      orgRequest: function (p, o) { orgCalls.push({ path: p, method: o && o.method, body: o && o.body });
        return Promise.resolve(orgResult); },
      org: { getOrgSites: function () { return Promise.resolve({ sites: [] }); } },
      window: { getSpan: function () { return Promise.resolve({ dates: { [REPORT_DATE]: { hasReport: true } } }); } },
      dates: { getDates: function () { return Promise.resolve({ dates: { [REPORT_DATE]: { hasReport: true } } }); } },
      timeline: { getTimeline: function () { return Promise.resolve(REPORT); } },
      sites: { getUsers: function () { return Promise.resolve({ users: [] }); } },
      pooledAll: function (thunks) { return Promise.all(thunks.map(function (t) { return t(); })); },
    },
  },
};
global.React = {};
global.document = { addEventListener() {}, removeEventListener() {}, getElementById() { return null; } };

require('../scripts/api/mine-team.js');
require('../scripts/api/actions.js');
const A = global.window.FS.api.actions;
/* Poison the legacy readers even if something re-adds them. */
A.getActions = boom('getActions');
A.getActionsRange = boom('getActionsRange');
require('../scripts/api/today-adapter.js');
require('../scripts/api/tasks-aggregator.js');
require('../scripts/api/user-activity-aggregator.js');

/* ---- 1. each former overlay reader computes done-ness from status alone --- */

test('tasks-aggregator: status done with no overlay is done; status open is not', async () => {
  const res = await global.window.FS.api.tasks.getActionsResolvedRange(
    { from: REPORT_DATE, to: REPORT_DATE, user: 'Jane_Doe' });
  const by = {};
  res.rows.forEach((r) => { by[r.actionItemId] = r; });

  assert.strictEqual(by['ai-done'].audit.checked, true);
  assert.strictEqual(by['ai-done'].audit.checked_by, 'Sam Closer', 'closer comes off the task row');
  assert.strictEqual(by['ai-done'].audit.checked_at, '2026-07-20T01:00:00Z');
  assert.strictEqual(by['ai-open'].audit.checked, false);
  assert.strictEqual(by['ai-open'].audit.checked_by, null);
  assert.strictEqual(by['ai-null'].audit.checked, false, 'a missing status is open, not a crash');
  assert.strictEqual(by['ai-done'].status, 'done');
});

test('tasks-aggregator: an overlay saying checked cannot make an open task done', async () => {
  /* Even if a stale map existed in the page, there is no reader for it. */
  const orig = A.lookupAction;
  A.lookupAction = function () { return { checked: true, checked_by: 'Stranger' }; };
  try {
    const res = await global.window.FS.api.tasks.getActionsResolvedRange(
      { from: REPORT_DATE, to: REPORT_DATE, user: 'Jane_Doe' });
    const open = res.rows.filter((r) => r.actionItemId === 'ai-open')[0];
    assert.strictEqual(open.audit.checked, false);
    assert.strictEqual(open.audit.checked_by, null);
  } finally {
    A.lookupAction = orig;
  }
});

test('tasks-aggregator no longer exposes the overlay-history reader', () => {
  assert.strictEqual(global.window.FS.api.tasks.getCrossDayAudit, undefined);
});

test('today-adapter: status done is Done with no overlay; open stays Open even if ctx carries a checked map', () => {
  const out = global.window.FS.api.todayAdapter.adapt(REPORT, {
    currentUserName: 'Jane Doe', nowMinutes: 16 * 60,
    /* the old overlay input — must be ignored */
    actionState: { 'Jane_Doe|0_1': { checked: true, checked_by: 'Stranger' },
                   'Jane_Doe|0_2': { checked: true, checked_by: 'Stranger' } },
  });
  const by = {};
  out.myTasks.concat(out.teamTasks).forEach((t) => { by[t.actionItemId] = t; });
  assert.strictEqual(by['ai-done'].status, 'Done');
  assert.strictEqual(by['ai-open'].status, 'Open', 'an overlay tick is not a tick');
  /* No status column at all: the old code fell back to the overlay here and
     read Done. Now it is open. */
  assert.strictEqual(by['ai-null'].status, 'Open');
});

test('deriveStatus takes the column alone', () => {
  const d = global.window.FS.api.deriveStatus;
  assert.strictEqual(d('done').status, 'Done');
  assert.strictEqual(d(null).status, 'Open');
  assert.strictEqual(d(null, true).status, 'Open', 'a second (overlay) argument is not honoured');
});

test('user-activity-aggregator: action events are checked by status, never by an overlay', async () => {
  global.window.AuthMock.currentUser = { name: 'Jane Doe', role: 'worker', folder_name: 'Jane_Doe' };
  try {
    const res = await global.window.FS.api.userActivity.getUserActivityRange(
      { from: REPORT_DATE, to: REPORT_DATE });
    const events = res.users[0].events.filter((e) => e.kind === 'action');
    const by = {};
    events.forEach((e) => { by[e.summary] = e; });
    assert.strictEqual(by['done item'].extra.checked, true);
    assert.strictEqual(by['done item'].extra.checked_at, '2026-07-20T01:00:00Z');
    assert.strictEqual(by['open item'].extra.checked, false);
    assert.strictEqual(by['open item'].extra.checked_at, null);
  } finally {
    global.window.AuthMock.currentUser = { name: 'Jane Doe', role: 'admin' };
  }
});

test('itemState: a tick made this session wins, otherwise the status column decides', () => {
  const done = { status: 'done', updated_by_name: 'Sam', updated_at: 't' };
  const open = { status: 'open' };
  assert.deepStrictEqual(A.itemState(done), { checked: true, checked_by: 'Sam', checked_at: 't' });
  assert.deepStrictEqual(A.itemState(open), { checked: false, checked_by: null, checked_at: null });
  assert.strictEqual(A.itemState(done, { checked: false }).checked, false, 'an untick this session wins');
  assert.strictEqual(A.itemState(open, { checked: true, checked_by: 'Me', checked_at: 'x' }).checked, true);
  assert.strictEqual(A.itemState(null).checked, false);
});

test('isActionResolved is the status column alone', () => {
  assert.strictEqual(A.isActionResolved('done'), true);
  assert.strictEqual(A.isActionResolved('open', true), false);
});

/* ---- 2. nothing issues /actions or /actions/toggle ------------------------ */

function codeOf(file) {
  /* strip block + line comments so prose that mentions the retired routes
     does not trip the scan; only live code is checked. */
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'node_modules') walk(p, out); }
    else if (/\.js$/.test(e.name)) out.push(p);
  });
  return out;
}

test('no script requests /actions or /actions/toggle', () => {
  const offenders = [];
  walk(path.join(ROOT, 'scripts'), []).forEach((f) => {
    const code = codeOf(f);
    /* request('/actions..'), fetch(...'/actions'), base + '/actions', or a
       template ending in /actions: any quoted path that IS the retired
       route, whatever calls it. */
    if (/['"`]\/actions(['"`\/?]|\$\{)/.test(code) || /fetch\([^)]*\/actions/.test(code)) {
      offenders.push(path.relative(ROOT, f));
    }
  });
  assert.deepStrictEqual(offenders, []);
});

test('nothing calls the retired overlay API, and actions.js does not export it', () => {
  const gone = /\b(getActionsRange|toggleAction|createAction|getCrossDayAudit)\b|actions\.getActions\b/;
  const offenders = [];
  walk(path.join(ROOT, 'scripts'), []).forEach((f) => {
    if (gone.test(codeOf(f))) offenders.push(path.relative(ROOT, f));
  });
  assert.deepStrictEqual(offenders, []);

  const cjs = require('../scripts/api/actions.js');
  ['getActions', 'getActionsRange', 'toggleAction', 'createAction'].forEach((n) => {
    assert.strictEqual(cjs[n], undefined, n + ' must not be exported');
  });
});

test('the overlay fixture is gone and the demo reports carry the two ticks themselves', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'scripts', 'mock', 'actions.fixture.js')));
  const w = { FieldSight: {} };
  global.window.FieldSight = w.FieldSight;
  delete require.cache[require.resolve('../scripts/mock/daily-report.fixture.js')];
  require('../scripts/mock/daily-report.fixture.js');
  const rep = w.FieldSight.fixtures.reports['2026-04-29'].Jarley_Trainor;
  assert.strictEqual(rep.topics[0].action_items[0].status, 'done');
  assert.strictEqual(rep.topics[2].action_items[1].status, 'done');
});

/* ---- 3. id-less item is read-only; a 403 is shown, not swallowed ---------- */

let rowReact;
function loadRow() {
  const state = [];
  rowReact = {
    state,
    createElement: function (type, props) {
      return { type, props: props || {}, children: Array.prototype.slice.call(arguments, 2) };
    },
    Fragment: 'Fragment',
    useState: function (v) {
      const cell = { v };
      state.push(cell);
      return [v, function (nv) { cell.v = nv; cell.set = true; }];
    },
    useEffect: function () {},
    useRef: function (v) { return { current: v }; },
  };
  global.React = rowReact;
  global.window.FieldSight = { Badge: function Badge() {} };
  delete require.cache[require.resolve('../scripts/composites/action-item-row.js')];
  require('../scripts/composites/action-item-row.js');
  return global.window.FieldSight.ActionItemRow;
}

function findInput(n) {
  if (!n || typeof n !== 'object') return null;
  if (n.type === 'input' && n.props && n.props.type === 'checkbox') return n;
  const kids = (n.children || []).concat(n.props && n.props.children ? [].concat(n.props.children) : []);
  for (const k of kids) {
    const hit = Array.isArray(k) ? k.map(findInput).filter(Boolean)[0] : findInput(k);
    if (hit) return hit;
  }
  return null;
}

const ROW_PROPS = { date: REPORT_DATE, topicId: 0, actionIndex: 1, userFolder: 'Jane_Doe' };

test('a report-sourced item with no actionItemId renders read-only: the checkbox is disabled and does nothing', async () => {
  const Row = loadRow();
  orgCalls.length = 0; toasts.length = 0;
  const el = Row(Object.assign({ action: { action: 'no id', status: 'open' } }, ROW_PROPS));
  const input = findInput(el);
  assert.ok(input, 'checkbox rendered');
  assert.strictEqual(input.props.disabled, true);

  input.props.onChange({ target: { checked: true } });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(orgCalls.length, 0, 'nothing was sent');
  assert.strictEqual(busEvents.length, 0);
});

test('an item WITH an actionItemId is toggleable', () => {
  const Row = loadRow();
  const el = Row(Object.assign({ action: { id: 'ai-open', action: 'x', status: 'open' } }, ROW_PROPS));
  assert.ok(!findInput(el).props.disabled);
});

test('a 403 from PATCH /action-items/{id} is SHOWN and the optimistic tick is reverted', async () => {
  const Row = loadRow();
  orgCalls.length = 0; toasts.length = 0; busEvents.length = 0;
  orgResult = { _accessDenied: true, status: 403, error: "admin/gm, this site's pm/site_manager, or the assignee only" };

  const el = Row(Object.assign({ action: { id: 'ai-open', action: 'x', status: 'open' } }, ROW_PROPS));
  const input = findInput(el);
  input.props.onChange({ target: { checked: true } });
  await new Promise((r) => setTimeout(r, 5));

  assert.strictEqual(orgCalls.length, 1);
  assert.strictEqual(orgCalls[0].path, '/action-items/ai-open');
  assert.deepStrictEqual(orgCalls[0].body, { status: 'done' });
  assert.strictEqual(toasts.length, 1, 'the refusal reached the user');
  assert.strictEqual(toasts[0].tone, 'error');
  assert.match(toasts[0].message, /assignee only/, 'with the server\'s own reason');
  assert.strictEqual(busEvents.length, 0, 'a refused tick is never broadcast as truth');
  /* state[0] is the checked box: set true optimistically, then back to false. */
  assert.strictEqual(rowReact.state[0].v, false, 'the box is reverted, not left ticked');
});

test('a successful PATCH ticks and broadcasts', async () => {
  const Row = loadRow();
  orgCalls.length = 0; toasts.length = 0; busEvents.length = 0;
  orgResult = { id: 'ai-open', status: 'done', updated_by_name: 'Jane Doe', updated_at: 't' };

  const el = Row(Object.assign({ action: { id: 'ai-open', action: 'x', status: 'open' } }, ROW_PROPS));
  findInput(el).props.onChange({ target: { checked: true } });
  await new Promise((r) => setTimeout(r, 5));

  assert.strictEqual(toasts.length, 0);
  assert.strictEqual(busEvents.length, 1);
  assert.strictEqual(busEvents[0].checked, true);
  assert.strictEqual(rowReact.state[0].v, true);
});

test('resolveActionItem refuses an id-less item with a reason and writes nowhere', async () => {
  orgCalls.length = 0;
  const env = await A.resolveActionItem({ date: REPORT_DATE, topic_id: 0, action_index: 1, checked: true });
  assert.strictEqual(env.ok, false);
  assert.strictEqual(env.reason, 'no_id');
  assert.strictEqual(orgCalls.length, 0);
});

/* ---- 4. a tick survives into a pane mounted after it ---------------------- */

test('a tick accepted earlier is what a LATER-mounted pane renders (no stale open row, no second PATCH)', async () => {
  orgCalls.length = 0; busEvents.length = 0;
  orgResult = { id: 'ai-open', status: 'done', updated_by_name: 'Jane Doe', updated_at: 't1' };
  const env = await A.resolveActionItem({ actionItemId: 'ai-open', date: REPORT_DATE, topic_id: 0,
    action_index: 1, user_folder: 'Jane_Doe', checked: true });
  assert.strictEqual(env.ok, true);

  /* The right pane mounts now: it seeds from ticksFor(date), exactly what
     timeline.js does, then derives the row from itemState. */
  const staleItem = REPORT.topics[0].action_items[1];   // payload still says open
  assert.strictEqual(staleItem.status, 'open');
  const seeded = A.ticksFor(REPORT_DATE);
  const st = A.itemState(staleItem, A.lookupAction(seeded, 'Jane_Doe', 0, 1));
  assert.strictEqual(st.checked, true);
  assert.strictEqual(st.checked_by, 'Jane Doe');

  const Row = loadRow();
  const el = Row(Object.assign({ action: staleItem, initialChecked: st.checked }, ROW_PROPS));
  assert.strictEqual(findInput(el).props.checked, true, 'renders done');

  /* An untick is remembered too, and another date is unaffected. */
  orgResult = { id: 'ai-open', status: 'open', updated_by_name: 'Jane Doe', updated_at: 't2' };
  await A.resolveActionItem({ actionItemId: 'ai-open', date: REPORT_DATE, topic_id: 0,
    action_index: 1, user_folder: 'Jane_Doe', checked: false });
  assert.strictEqual(A.lookupAction(A.ticksFor(REPORT_DATE), 'Jane_Doe', 0, 1).checked, false);
  assert.deepStrictEqual(A.ticksFor('2000-01-01'), {});
});

test('timeline.js seeds its three tick maps from ticksFor', () => {
  const src = codeOf(path.join(ROOT, 'scripts', 'pages', 'timeline.js'));
  assert.ok((src.match(/actions\.ticksFor\(/g) || []).length >= 3);
});

/* ---- 5. live mode has no "+ New task" entry point ------------------------- */

test('the /tasks "+ New task" button is only rendered in mock mode', () => {
  const src = codeOf(path.join(ROOT, 'scripts', 'pages', 'tasks.js'));
  assert.match(src, /CreateTaskModal && \(window\.FS\.api\.useMocks \|\| window\.FS\.api\.writeMocks\)/);
});

/* ---- 6. session tick cache never outlives a status change ------------------ */

test('a status change through updateAction drops the remembered tick for that task', async () => {
  orgResult = { id: 'ai-x', status: 'done', updated_by_name: 'Jane Doe', updated_at: 't1' };
  await A.resolveActionItem({ actionItemId: 'ai-x', date: '2026-08-01', topic_id: 3,
    action_index: 0, user_folder: 'Jane_Doe', checked: true });
  assert.strictEqual(A.lookupAction(A.ticksFor('2026-08-01'), 'Jane_Doe', 3, 0).checked, true);

  /* The Status editor on Today/Tasks writes straight through updateAction. */
  orgResult = { id: 'ai-x', status: 'open' };
  await A.updateAction('ai-x', { status: 'open' });
  assert.strictEqual(A.lookupAction(A.ticksFor('2026-08-01'), 'Jane_Doe', 3, 0), undefined,
    'the stale tick is gone, so the fresh payload decides');

  /* A refused change, or a non-status edit, leaves it alone. */
  orgResult = { id: 'ai-x', status: 'done', updated_at: 't2' };
  await A.resolveActionItem({ actionItemId: 'ai-x', date: '2026-08-01', topic_id: 3,
    action_index: 0, user_folder: 'Jane_Doe', checked: true });
  orgResult = { _accessDenied: true, status: 403, error: 'no' };
  await A.updateAction('ai-x', { status: 'open' });
  orgResult = { id: 'ai-x', priority: 'high' };
  await A.updateAction('ai-x', { priority: 'high' });
  assert.strictEqual(A.lookupAction(A.ticksFor('2026-08-01'), 'Jane_Doe', 3, 0).checked, true);
});

/* ---- 7. right pane: `sel` is declared before the effects that read it ------ */

test('timeline.js TimelineRightDetail declares `sel` above its seeding effect', () => {
  const src = codeOf(path.join(ROOT, 'scripts', 'pages', 'timeline.js'));
  const decl = src.indexOf('var sel = props.selectedItem;\n', src.indexOf('Declared BEFORE') > -1 ? 0 : 0);
  const raw = fs.readFileSync(path.join(ROOT, 'scripts', 'pages', 'timeline.js'), 'utf8');
  const seed = raw.indexOf('setActions(window.FS.api.actions.ticksFor(sel.date))');
  const declAt = raw.lastIndexOf('var sel = props.selectedItem;', seed);
  assert.ok(seed > 0 && declAt > 0 && declAt < seed,
    'a var declared below the effect hoists as undefined and freezes its dependency array');
});

/* ---- 8. observations are created under the site's SLUG, never its UUID ----- */

const SITE_ROWS = [{ site_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', slug: 'sb1108-ellesmere', name: 'SB1108' },
                   { site_id: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'No slug row' }];

test('slugForSite maps a UUID (or a slug) to the row slug and leaves unknowns alone', () => {
  const slugFor = global.window.FS.api.sites && global.window.FS.api.sites.slugForSite
    || (require('../scripts/api/sites.js'), global.window.FS.api.sites.slugForSite);
  assert.strictEqual(slugFor(SITE_ROWS, SITE_ROWS[0].site_id), 'sb1108-ellesmere');
  assert.strictEqual(slugFor(SITE_ROWS, 'sb1108-ellesmere'), 'sb1108-ellesmere');
  assert.strictEqual(slugFor(SITE_ROWS, 'nope'), 'nope');
  assert.strictEqual(slugFor(SITE_ROWS, SITE_ROWS[1].site_id), SITE_ROWS[1].site_id, 'no slug on the row: unchanged');
  assert.strictEqual(slugFor(null, 'x'), 'x');
});

['quality', 'safety'].forEach((kind) => {
  test(kind + '-create-modal submits the site\'s slug as site_slug, not its UUID', async () => {
    require('../scripts/api/sites.js');
    const submitted = [];
    const api = global.window.FS.api;
    api.org = Object.assign({}, api.org, {
      createObservation: function (body) { submitted.push(body); return Promise.resolve({ id: 'o1', author_name: 'J' }); },
    });
    api.todayNZDT = function () { return '2026-08-01'; };
    /* Hooks stub: the sites list state is the only array state; the form
       state is the only object with an `observation` key. */
    global.React = {
      createElement: function (type, props) {
        return { type, props: props || {}, children: Array.prototype.slice.call(arguments, 2) };
      },
      Fragment: 'Fragment',
      useState: function (v) {
        if (Array.isArray(v)) v = SITE_ROWS;
        if (v && typeof v === 'object' && 'observation' in v) v = Object.assign({}, v, { observation: 'Loose board' });
        return [v, function () {}];
      },
      useEffect: function () {}, useRef: function (v) { return { current: v }; },
    };
    global.window.FieldSight = {};
    const file = '../scripts/composites/' + kind + '-create-modal.js';
    delete require.cache[require.resolve(file)];
    require(file);
    const Modal = global.window.FieldSight[kind === 'quality' ? 'QualityCreateModal' : 'SafetyCreateModal'];
    const el = Modal({ open: true, siteId: SITE_ROWS[0].site_id, onClose() {}, onSuccess() {} });
    (function find(n) {
      if (!n || typeof n !== 'object') return null;
      if (n.type === 'form') { n._f = true; found = n; return n; }
      (n.children || []).concat(n.props && n.props.children ? [].concat(n.props.children) : []).forEach(find);
    })(el);
    await found.props.onSubmit({ preventDefault() {} });
    assert.strictEqual(submitted.length, 1);
    assert.strictEqual(submitted[0].site_slug, 'sb1108-ellesmere');
    assert.notStrictEqual(submitted[0].site_slug, SITE_ROWS[0].site_id);
  });
});
var found;
