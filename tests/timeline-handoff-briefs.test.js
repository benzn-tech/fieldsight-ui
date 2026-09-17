'use strict';

/*
 * The wire between the day view and the hand-off table.
 *
 * Three changes shipped before this one: the endpoint (getSessionBrief), the
 * model that builds rows out of a brief (buildPreviewModel), and the renderer
 * that draws the three columns. None of them was reachable in the running app,
 * because timeline.js passed no `briefs` — so `rowsSource` was always
 * 'action_items' and every test of the brief path was testing code no user
 * could get to.
 *
 * What these tests pin is the chain, link by link, because each link is
 * separately capable of being green while the feature is dead:
 *
 *   - BOTH PreviewEmailButton mounts carry the briefs. A control wired to one
 *     of several mounts, where the route under test renders a different one,
 *     is a defect this repo has already shipped once.
 *   - The modal's EXPLICIT prop list carries them. The forwarding above it is
 *     wholesale and looks sufficient; that list is what actually arrives.
 *   - The fetched shape is the shape the model reads. getSessionBrief resolves
 *     the ARTIFACT; buildPreviewModel reads `b.brief`. Hand one straight to
 *     the other and every row vanishes with no error anywhere.
 *   - A failed or half-loaded fetch falls back to action_items. The table the
 *     hand-off has always had is the floor; an empty table is never the answer.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs
  .readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'timeline.js'), 'utf8')
  .replace(/\r\n/g, '\n');

/* ---------- a recording React (same shape the other timeline tests use) --- */

function makeReact() {
  return {
    createElement(type, props, ...children) {
      const flat = [];
      (function push(list) {
        list.forEach(function (c) {
          if (Array.isArray(c)) push(c);
          else if (c !== null && c !== undefined && c !== false) flat.push(c);
        });
      })(children);
      return { type: type, props: props || {}, children: flat };
    },
    useState(v) { return [v, function () {}]; },
    useRef(v) { return { current: v }; },
    useEffect() {}, useLayoutEffect() {}, useContext() { return null; },
    useMemo(fn) { return fn(); }, useCallback(fn) { return fn; },
    Fragment: 'Fragment',
    memo(c) { return c; },
  };
}

function Modal() {}

function loadTimeline(org) {
  const React = makeReact();
  global.React = React;
  global.window = {
    FieldSight: {
      EmailPreviewModal: Modal,
      SessionReportModal: function SessionReportModal() {},
      Card: Object.assign(function Card() {}, { Body: function CardBody() {} }),
      Badge: function Badge() {}, Avatar: function Avatar() {},
      NavIcon: function NavIcon() {}, PhotoGrid: function PhotoGrid() {},
    },
    FS: {
      api: {
        folderName: function (n) { return String(n || '').replace(/ /g, '_'); },
        actions: { lookupAction: function () { return null; } },
        org: org || {},
      },
      can: function () { return true; },
      P: function (a, b) { return a + ':' + b; },
    },
    AuthMock: { currentUser: { name: 'Ben Lin', role: 'admin' } },
    location: { href: 'https://example.test/#/timeline' },
    addEventListener() {}, removeEventListener() {},
  };
  global.document = {
    addEventListener() {}, removeEventListener() {},
    createElement() { return { style: {} }; },
  };
  delete require.cache[require.resolve('../scripts/pages/timeline.js')];
  return require('../scripts/pages/timeline.js');
}

/* The model this all feeds. Loaded once, driven for real rather than restated:
   a test that re-implements the floor cannot notice when the floor moves.
   It attaches itself to window at load, so the globals have to exist first —
   loadTimeline replaces them afterwards, which is harmless once the module's
   exports are in hand. */
global.window = global.window || {};
global.document = global.document || {};
const { buildPreviewModel } = require('../scripts/composites/email-preview-modal.js');

/* ---------- fixtures ------------------------------------------------------ */

function topic(over) {
  return Object.assign({
    topic_id: 1, topic_title: 'Wall tolerance', time_range: '09:00 – 09:20',
    session_id: 's1',
    action_items: [{ action: 'Redo the west wall', responsible: 'John',
                     deadline: 'Wed', status: 'open' }],
    related_photos: [],
  }, over);
}

function readyBrief(tasks) {
  return { status: 'ready', headline: 'h', summary: 'h', sections: [], entities: [],
           tasks: tasks, open_todos: [], open_points: [], stats: {} };
}

const BRIEFS = [{ sessionId: 's1', brief: readyBrief([
  { text: 'Redo the west wall to line before the next pour', at: '09:12:00',
    assignee: 'John', due: 'Wed' },
]) }];

function findAll(node, pred, out) {
  out = out || [];
  if (!node || typeof node !== 'object') return out;
  if (pred(node)) out.push(node);
  (node.children || []).forEach(function (c) { findAll(c, pred, out); });
  return out;
}

const isPreview = (n) => typeof n.type === 'function' && n.type.name === 'PreviewEmailButton';

/* ---------- 0. the self-check -------------------------------------------- */

test('timeline.js exposes the pieces these tests drive', () => {
  const mod = loadTimeline();
  ['loadSessionBriefs', 'scopeBriefsToSession', 'DraftEmailButton', 'PreviewEmailButton']
    .forEach(function (name) {
      assert.strictEqual(typeof mod[name], 'function',
        name + ' is not exported — every assertion below would be vacuous');
    });
});

/* ---------- 1. both PreviewEmailButton mounts carry the briefs ----------- */

function draftProps(over) {
  return Object.assign({
    topics: [topic()], session: null, siteName: 'SB1108 Ellesmere',
    date: '2026-03-01', reportDate: '2026-03-01', userFolder: 'Ben_Lin',
    deepLink: 'https://example.test/#/timeline', briefs: BRIEFS,
  }, over);
}

test('the outstanding-items path hands the briefs to Preview & copy', () => {
  const { DraftEmailButton } = loadTimeline();
  const mounts = findAll(DraftEmailButton(draftProps()), isPreview);
  assert.strictEqual(mounts.length, 1, 'the normal path mounts it exactly once');
  assert.strictEqual(mounts[0].props.briefs, BRIEFS,
    'the normal path dropped the briefs on the way to the preview control');
});

test('the nothing-outstanding path hands them over too', () => {
  /* Most days are this one: every action item already ticked off. It renders a
     DIFFERENT PreviewEmailButton call, with an emptyReason spliced in, and a
     wiring that reached only the other call would look correct on the day it
     was demonstrated and be dead on most days after. */
  const { DraftEmailButton } = loadTimeline();
  const done = topic({ action_items: [{ action: 'Redo the west wall', status: 'done' }] });
  const tree = DraftEmailButton(draftProps({ topics: [done] }));
  const mounts = findAll(tree, isPreview);
  assert.strictEqual(mounts.length, 1, 'the empty path still mounts it — beside, not instead');
  assert.ok(mounts[0].props.emptyReason, 'and this really is the empty branch');
  assert.strictEqual(mounts[0].props.briefs, BRIEFS,
    'the empty path dropped the briefs — the control is disabled today, but the '
    + 'props it is given are what it will carry the moment it is not');
});

/* ---------- 2. the modal's explicit prop list ---------------------------- */

test("briefs reach the modal, not just PreviewEmailButton's props", () => {
  /* The forwarding in DraftEmailButton is wholesale (`props`,
     `Object.assign({}, props, …)`), so test 1 passes as soon as the day view
     supplies briefs at all. What reaches the modal is the hand-written prop
     list inside PreviewEmailButton, and nothing above it can make up for an
     omission there. */
  const { PreviewEmailButton } = loadTimeline();
  const tree = PreviewEmailButton(draftProps());
  const modals = findAll(tree, (n) => n.type === Modal);
  assert.strictEqual(modals.length, 1, 'the modal is mounted exactly once');
  assert.strictEqual(modals[0].props.briefs, BRIEFS,
    'the modal was mounted without briefs — buildPreviewModel reads opts.briefs '
    + 'off exactly this object, so the whole brief path stays dead');
});

test('the day view hands the fetched briefs to the draft controls', () => {
  /* Source-scanned rather than rendered: reaching this mount through the real
     component needs a settled report, a session list and a resolved owner. The
     assertion is only that the wire exists at the mount the day view renders. */
  const mount = SOURCE.match(/var _draftEl = React\.createElement\(DraftEmailButton, \{[\s\S]*?\n    \}\);/);
  assert.ok(mount, 'the day view\'s DraftEmailButton mount has moved or been renamed');
  assert.match(mount[0], /briefs:\s*scopeBriefsToSession\(dayBriefs, selectedSessionId\)/,
    'the day view must pass the briefs it fetched, narrowed to the meeting in '
    + 'scope — unscoped, picking one meeting would hand the table another '
    + "meeting's tasks");
});

/* ---------- 3. a failed fetch falls back, never to an empty table -------- */

test('a rejected brief fetch drops that session and nothing else', async () => {
  const { loadSessionBriefs } = loadTimeline({
    getSessionBrief: async (o) => {
      if (o.sessionId === 's1') throw new Error('network');
      return readyBrief([{ text: 'Order mesh', at: '14:05:00', assignee: '', due: '' }]);
    },
  });
  const out = await loadSessionBriefs([{ session_id: 's1' }, { session_id: 's2' }],
    { date: '2026-03-01', user: 'Ben_Lin' });
  assert.strictEqual(out.length, 1, 'the failure must not take the good brief with it');
  assert.strictEqual(out[0].sessionId, 's2');
  assert.ok(out.every(Boolean), 'a failure must leave no hole in the list');
});

test('a half-loaded brief set renders the action_items table, never an empty one', async () => {
  /* The floor in buildPreviewModel is doing the work here, and that is the
     point: a partial set is EXACTLY what it exists to catch, so the honest
     thing is to hand it over and let it refuse — not to dress a partial set up
     as a complete one. */
  const { loadSessionBriefs } = loadTimeline({
    getSessionBrief: async (o) => {
      if (o.sessionId === 's2') throw new Error('network');
      return readyBrief([{ text: 'Redo the west wall', at: '09:12:00', assignee: 'John', due: 'Wed' }]);
    },
  });
  const briefs = await loadSessionBriefs([{ session_id: 's1' }, { session_id: 's2' }],
    { date: '2026-03-01', user: 'Ben_Lin' });
  const model = buildPreviewModel({
    topics: [topic(), topic({ topic_id: 2, session_id: 's2', topic_title: 'Mesh',
      action_items: [{ action: 'Order mesh', status: 'open' }] })],
    briefs: briefs,
  });
  assert.strictEqual(model.rowsSource, 'action_items',
    'one brief cannot stand in for two meetings');
  assert.strictEqual(model.rows.length, 2,
    'both commitments stay on the table — a hand-off that drops one is worse '
    + 'than one that reads badly, and an empty one is worse than both');
});

test('a pending or denied brief is no brief, and neither is an error', async () => {
  const { loadSessionBriefs } = loadTimeline({
    getSessionBrief: async (o) => ({
      s1: { status: 'pending' },
      s2: { status: 'removed' },
      s3: { _accessDenied: true, status: 403 },
      s4: { _notFound: true, status: 404 },
      s5: readyBrief([{ text: 'Pour slab', at: '09:10:00', assignee: '', due: '' }]),
    }[o.sessionId]),
  });
  const out = await loadSessionBriefs(
    ['s1', 's2', 's3', 's4', 's5'].map((id) => ({ session_id: id })),
    { date: '2026-03-01', user: 'Ben_Lin' });
  assert.deepStrictEqual(out.map((b) => b.sessionId), ['s5'],
    'only a brief that says `ready` is a brief. 403 carries a NUMERIC status '
    + 'under the same key, so the envelope flags have to be tested first');
});

/* ---------- 4. one call per session, over the list already loaded -------- */

test('a brief is fetched per session, for the day and owner in scope', async () => {
  const seen = [];
  const { loadSessionBriefs } = loadTimeline({
    getSessionBrief: async (o) => { seen.push(o); return readyBrief([]); },
  });
  await loadSessionBriefs([{ session_id: 's1' }, { session_id: 's2' }, { block: 1 }],
    { date: '2026-03-01', user: 'Ben_Lin' });
  assert.deepStrictEqual(seen.map((o) => o.sessionId), ['s1', 's2'],
    'one read per session with an id, and none for a row that has none');
  seen.forEach((o) => {
    assert.strictEqual(o.date, '2026-03-01');
    assert.strictEqual(o.user, 'Ben_Lin');
  });
});

test('the brief effect reuses the loaded session list rather than re-fetching it', () => {
  const effect = SOURCE.match(/var refBriefs\s*=[\s\S]*?\}, \[date, user, sessionsState\.status, sessionsState\.sessions\]\);/);
  assert.ok(effect, 'the brief effect has moved or been renamed');
  assert.match(effect[0], /sessionsState\.sessions/,
    'it must read the sessions already in state');
  assert.doesNotMatch(effect[0], /getSessions/,
    'a day whose session list is already in hand must not ask for it again');
  assert.strictEqual((SOURCE.match(/getSessionsCached\(/g) || []).length, 1,
    'there is still exactly one sessions request in this file');
});

test('what the fetcher returns is the shape the model reads', async () => {
  /* The seam that would otherwise fail silently: getSessionBrief resolves the
     ARTIFACT (status and tasks at the top level) and rowsFromBriefs reads
     `b.brief`. Hand one straight to the other and every row disappears, the
     floor waves the fallback through, and nothing anywhere reports a problem.
     Driven through the real model rather than asserted against a key name,
     and fed the FETCHER's own output rather than a hand-built wrapper — a
     restated shape is exactly the thing that was already agreeing with itself
     while the two ends disagreed. */
  const { loadSessionBriefs } = loadTimeline({
    getSessionBrief: async () => readyBrief([
      { text: 'Redo the west wall to line before the next pour', at: '09:12:00',
        assignee: 'John', due: 'Wed' },
    ]),
  });
  const briefs = await loadSessionBriefs([{ session_id: 's1' }],
    { date: '2026-03-01', user: 'Ben_Lin' });
  const model = buildPreviewModel({ topics: [], briefs: briefs });
  assert.strictEqual(model.rowsSource, 'brief');
  assert.strictEqual(model.rows.length, 1);
  assert.strictEqual(model.rows[0].text,
    'Redo the west wall to line before the next pour');
  assert.strictEqual(model.rows[0].assignee, 'John');
});

/* ---------- 5. scope ------------------------------------------------------ */

test('a topic with no session_id still reaches the table', async () => {
  /* Some topics carry no session_id at all — the report is the scope they
     have. "All day" is the scope the draft controls run in by default, and
     filtering there is what would quietly drop them. */
  const { filterTopicsBySession, loadSessionBriefs } = loadTimeline({
    getSessionBrief: async () => readyBrief([
      { text: 'Redo the west wall to line before the next pour', at: '09:12:00',
        assignee: 'John', due: 'Wed' },
    ]),
  });
  const loose = topic({ topic_id: 9, session_id: null, topic_title: 'Site walk',
    action_items: [{ action: 'Chase the producer statement', status: 'open' }] });
  assert.strictEqual(filterTopicsBySession([topic(), loose], null).length, 2,
    'All day must not filter on a field half the topics do not have');

  const briefs = await loadSessionBriefs([{ session_id: 's1' }],
    { date: '2026-03-01', user: 'Ben_Lin' });
  const model = buildPreviewModel({ topics: [topic(), loose], briefs: briefs });
  const texts = model.rows.map((r) => r.text);
  assert.ok(texts.indexOf('Chase the producer statement') !== -1,
    'the session-less topic lost its row the moment a brief was passed — the '
    + 'brief covers the sessions, and nothing covers this one');
  assert.strictEqual(model.rowsSource, 'action_items',
    'and the reason it survives is the floor, which is the whole point of it');
});

test('picking one meeting narrows the briefs the same way it narrows the topics', () => {
  const { scopeBriefsToSession } = loadTimeline();
  const day = [
    { sessionId: 's1', brief: readyBrief([{ text: 'a' }]) },
    { sessionId: 's2', brief: readyBrief([{ text: 'b' }]) },
  ];
  assert.strictEqual(scopeBriefsToSession(day, null).length, 2, 'All day keeps both');
  assert.deepStrictEqual(scopeBriefsToSession(day, 's2').map((b) => b.sessionId), ['s2'],
    "one meeting selected must not put the other meeting's tasks on the table");
  assert.deepStrictEqual(scopeBriefsToSession(null, 's2'), [],
    'and no briefs at all is an empty list, not a throw');
});
