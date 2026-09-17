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
 *   - A totally failed fetch (no brief loaded at all) falls back to
 *     action_items. A HALF-loaded fetch does not: the 2026-09-18
 *     handoff-sync plan (§0/§1.3) removed the row-count floor that used to
 *     force a fallback whenever a brief said less than the topics did — "if
 *     a brief exists, use it" is now unconditional. The two tests below
 *     that used to pin the floor's protection now pin its deliberate
 *     absence instead, so the new, more surprising behaviour (a session
 *     with no brief of its own silently drops out of the table the moment
 *     ANY session's brief exists) is visible rather than assumed away.
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
  ['loadSessionBriefs', 'scopeBriefsToSession', 'shouldLoadBriefs',
   'filterTopicsBySession', 'DraftEmailButton', 'PreviewEmailButton']
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
  assert.match(mount[0], /onNeedBriefs:[\s\S]*?setBriefsFor\(date\)/,
    'the day view must also hand down the way to ASK for them — without this '
    + 'wire nothing ever sets the wanted flag, shouldLoadBriefs never returns '
    + 'true, and the brief path is dead again in a new way');
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

test('a half-loaded brief set is still used whole — the floor that used to catch this is gone', async () => {
  /* 2026-09-18 handoff-sync plan §0/§1.3: "if a brief exists, use it. The
     row-count floor goes." Before that decision, buildPreviewModel refused a
     brief that said less than the topics' own action items, specifically to
     catch exactly this case — one session's brief loaded, the other's
     fetch failed, and the two-meeting day would otherwise read as
     one-meeting. That refusal is deliberately removed: a brief with at
     least one task now IS the source, full stop, even when it is missing a
     whole session's worth of commitments. This test used to pin the old
     refusal; it now pins the new, more surprising consequence, so the
     removal is a decision someone can see rather than a floor that quietly
     stopped existing. */
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
  assert.strictEqual(model.rowsSource, 'brief',
    'a brief with at least one task is the source, even a half-loaded set');
  assert.deepStrictEqual(model.rows.map((r) => r.text), ['Redo the west wall'],
    "s2's own action item is not merged in — there is no per-session mixing, "
    + 'only "brief entirely, or action_items entirely"');
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
  const effect = SOURCE.match(/var refBriefs\s*=[\s\S]*?\}, \[date, briefFolder, sessionsState\.status, sessionsState\.sessions, briefsFor\]\);/);
  assert.ok(effect, 'the brief effect has moved or been renamed');
  assert.match(effect[0], /sessionsState\.sessions/,
    'it must read the sessions already in state');
  assert.match(effect[0], /shouldLoadBriefs\(/,
    'the effect must ask shouldLoadBriefs whether to fetch — the deferral is '
    + 'that function, and an effect that fetches past it is the old behaviour '
    + 'with a helper sitting beside it');
  /* The effect BODY only — `briefFolder` is resolved during render, just
     above it, and that is the line allowed to read state.report. */
  const body = effect[0].slice(effect[0].indexOf('React.useEffect'));
  assert.doesNotMatch(body, /state\.report/,
    'the effect reads the RESOLVED owner folder, which its dependency list '
    + 'names. Reading state.report inside the body again would put an input '
    + 'back outside the list — the shape this effect already had once');
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
  /* Plan §0/§1.3 removed the row-count floor that used to keep this row on
     the table: "if a brief exists, use it", full stop. A brief covers the
     sessions it was written for, and nothing covers a session-less topic —
     so its action item is dropped from the action-row view the moment ANY
     usable brief exists, the same consequence pinned above for a
     half-loaded brief set. It also does not become a TOPIC row (§1.5),
     because it produced an action item; a topic row is only for one that
     produced none at all. This is the row that most needs a brief to
     succeed on every session, not just some of them — recorded here as a
     known, deliberate gap rather than a silent one. */
  assert.strictEqual(texts.indexOf('Chase the producer statement'), -1,
    'the session-less topic\'s row is gone now that a brief with at least '
    + 'one task exists — there is no floor left to keep it');
  assert.strictEqual(model.rowsSource, 'brief');
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

/* The test above is a list-shape test: it pins what scopeBriefsToSession
   RETURNS. It cannot tell two different defects apart, because both leave the
   mount passing something that is not the scoped list — and the only other
   thing holding the mount is a regex over the source text, which reds on a
   rename and stays green on a rewrite. The two tests below are the ones that
   watch the table. */

test('an unscoped brief set puts the other meeting\'s task on the table', () => {
  const { scopeBriefsToSession, filterTopicsBySession } = loadTimeline();
  const day = [
    { sessionId: 's1', brief: readyBrief([{ text: 'Redo the west wall to line',
        at: '09:12:00', assignee: 'John', due: 'Wed' }]) },
    { sessionId: 's2', brief: readyBrief([{ text: 'Order mesh for the slab',
        at: '14:05:00', assignee: 'Ana', due: 'Fri' }]) },
  ];
  const dayTopics = [topic(), topic({ topic_id: 2, session_id: 's2', topic_title: 'Mesh',
    action_items: [{ action: 'Order mesh', status: 'open' }] })];
  const scopedTopics = filterTopicsBySession(dayTopics, 's1');
  assert.strictEqual(scopedTopics.length, 1,
    'the fixture must really be one meeting, or the rest of this proves nothing');

  /* The defect, driven: one meeting's topics, the whole day's briefs. The
     brief set is then the LARGER of the two, so the thinner-brief floor waves
     it through and the table carries work from a meeting the user has just
     filtered away — with no error and nothing on screen saying so. */
  const unscoped = buildPreviewModel({ topics: scopedTopics, briefs: day });
  assert.strictEqual(unscoped.rowsSource, 'brief');
  assert.deepStrictEqual(unscoped.rows.map((r) => r.text),
    ['Redo the west wall to line', 'Order mesh for the slab'],
    'unscoped, the hand-off for ONE meeting lists both meetings');

  const scoped = buildPreviewModel({
    topics: scopedTopics, briefs: scopeBriefsToSession(day, 's1'),
  });
  assert.strictEqual(scoped.rowsSource, 'brief',
    'scoping must not knock the table off the brief path — one task against '
    + 'one open item is EQUALITY, which the floor admits');
  assert.deepStrictEqual(scoped.rows.map((r) => r.text), ['Redo the west wall to line'],
    "the selected meeting's hand-off must carry only the selected meeting");
});

test("the mount's own expression, evaluated, keeps the other meeting off", () => {
  /* Test 5 above asserts that the mount READS as scopeBriefsToSession(...).
     That is a regex over source text: it reds on a rename and it cannot tell
     an unscoped mount from one passing no briefs at all. This takes the
     expression the mount actually contains, evaluates it for real, and puts
     the result through the model — so a mount that hands over the whole day,
     or hands over nothing, fails HERE and fails differently. */
  const { scopeBriefsToSession, filterTopicsBySession } = loadTimeline();
  const mount = SOURCE.match(/var _draftEl = React\.createElement\(DraftEmailButton, \{[\s\S]*?\n    \}\);/);
  assert.ok(mount, 'the day view\'s DraftEmailButton mount has moved or been renamed');
  const expr = mount[0].match(/\n\s*briefs:\s*(.+?),\s*\n/);
  assert.ok(expr, 'the mount no longer passes a `briefs` prop at all');

  // eslint-disable-next-line no-new-func
  const evaluate = new Function('scopeBriefsToSession', 'dayBriefs', 'selectedSessionId',
    'return ' + expr[1] + ';');
  const day = [
    { sessionId: 's1', brief: readyBrief([{ text: 'Redo the west wall to line',
        at: '09:12:00', assignee: 'John', due: 'Wed' }]) },
    { sessionId: 's2', brief: readyBrief([{ text: 'Order mesh for the slab',
        at: '14:05:00', assignee: 'Ana', due: 'Fri' }]) },
  ];
  const scopedTopics = filterTopicsBySession(
    [topic(), topic({ topic_id: 2, session_id: 's2', topic_title: 'Mesh',
      action_items: [{ action: 'Order mesh', status: 'open' }] })], 's1');

  const model = buildPreviewModel({
    topics: scopedTopics,
    briefs: evaluate(scopeBriefsToSession, day, 's1'),
  });
  assert.strictEqual(model.rowsSource, 'brief',
    'the mount handed the model something that is not a usable brief set — if '
    + 'this is the fallback table, the mount is passing no briefs, which is a '
    + 'different defect from passing too many');
  assert.deepStrictEqual(model.rows.map((r) => r.text), ['Redo the west wall to line'],
    "the mount handed over the whole day: one meeting is selected and the "
    + "other meeting's task is on the table");
});

test('handing the table no briefs at all is a different failure, and looks different', () => {
  /* The other way the mount can be wrong. It has to be distinguishable from
     the unscoped one: they are opposite defects — one shows work that is out
     of scope, the other silently abandons the feature — and a single test
     that both reds cannot say which happened. */
  const none = buildPreviewModel({ topics: [topic()], briefs: [] });
  assert.strictEqual(none.rowsSource, 'action_items',
    'no briefs is the fallback table, not an empty one');
  assert.deepStrictEqual(none.rows.map((r) => r.text), ['Redo the west wall'],
    'and the row is the ACTION ITEM text — the brief wording never appears, '
    + 'which is what tells this apart from a scoping failure');
});

/* ---------- 6. the fetch waits for the hand-off to be opened ------------- */

test('nothing is fetched until the hand-off is actually opened', () => {
  /* This is the behaviour change. The effect used to fire on every day view,
     one GET /sessions/{id}/brief per session, before anyone had shown any
     interest — and on prod every one of them is a guaranteed miss.

     Driven through the decision itself rather than through the effect: a
     guard inside an effect is reachable only by rendering the whole page
     against a settled report, a session list and a resolved owner, which is
     why the rest of this file scans the source for that effect. */
  const { shouldLoadBriefs } = loadTimeline();
  const opened = {
    status: 'ok', sessions: [{ session_id: 's1' }], folder: 'Ben_Lin',
    date: '2026-03-01', wantedFor: '2026-03-01',
  };
  const but = (over) => Object.assign({}, opened, over);

  assert.strictEqual(shouldLoadBriefs(opened), true,
    'opened, on a settled day that has sessions: this is the one case that fetches');
  assert.strictEqual(shouldLoadBriefs(but({ wantedFor: null })), false,
    'a day view nobody has opened the hand-off on must issue no brief read at all');
  assert.strictEqual(shouldLoadBriefs(but({ wantedFor: '2026-02-28' })), false,
    'interest expires with the day it was expressed about — otherwise opening '
    + 'the hand-off once makes every later day eager again, which is the old '
    + 'behaviour reached one day late');

  /* The guards that were already there, kept under test because the deferral
     rewrote the line they used to live on. */
  assert.strictEqual(shouldLoadBriefs(but({ status: 'loading' })), false,
    'a session list still in flight is not a session list');
  assert.strictEqual(shouldLoadBriefs(but({ sessions: [] })), false,
    'a day with no recordings has no briefs to ask for');
  assert.strictEqual(shouldLoadBriefs(but({ folder: null })), false,
    'no owner folder means no path to a brief');
  assert.strictEqual(shouldLoadBriefs(but({ date: '' })), false);
  assert.strictEqual(shouldLoadBriefs(), false, 'and no arguments is not a fetch');
});

test('opening Preview & copy is what asks for them', () => {
  const { PreviewEmailButton } = loadTimeline();
  let asked = 0;
  const tree = PreviewEmailButton(draftProps({ onNeedBriefs: () => { asked += 1; } }));
  const btn = findAll(tree, (n) => n.type === 'button'
    && n.props && typeof n.props.onClick === 'function')[0];
  assert.ok(btn, 'the Preview & copy control has moved or lost its handler');
  assert.strictEqual(asked, 0,
    'RENDERING the control must ask for nothing — the control is on screen for '
    + 'every day view, which is the cost this change exists to remove');
  btn.props.onClick();
  assert.strictEqual(asked, 1, 'the click is the interest that pays for the fetch');
});

/* ---------- 7. briefs that arrive after the modal opened ---------------- */

/* A React whose useMemo honours its dependency list, which is the whole point
   here: under the recording React above (`useMemo(fn) { return fn(); }`) a
   memo with NO dependency list at all would pass, and that is exactly the
   defect this test exists to catch. One slot is enough — the modal has one
   memo — and calling the component twice against the same slots is what a
   re-render of the same instance is. */
function memoReact() {
  const slots = [];
  let i = 0;
  const React = {
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
    useMemo(fn, deps) {
      const slot = slots[i] || (slots[i] = {});
      i += 1;
      const same = slot.deps && deps && slot.deps.length === deps.length
        && slot.deps.every((d, k) => Object.is(d, deps[k]));
      if (same) return slot.value;
      slot.deps = deps;
      slot.value = fn();
      return slot.value;
    },
    useState(v) { return [v, function () {}]; },
    useRef(v) { return { current: v }; },
    useEffect() {}, useLayoutEffect() {}, useCallback(fn) { return fn; },
    Fragment: 'Fragment',
  };
  React.__render = function () { i = 0; };
  return React;
}

/* Joined rather than returned as a list: a table cell composes the action
   with its time range ("Redo the west wall (09:00 – 09:20)"), so what is
   asserted is that the text is PRESENT, not that a cell equals it. */
function allText(node, out) {
  out = out || [];
  (function walk(n) {
    if (typeof n === 'string') { out.push(n); return; }
    if (!n || typeof n !== 'object') return;
    (n.children || []).forEach(walk);
  }(node));
  return out.join('\n');
}

test('a brief that lands after the modal opened rebuilds the table', () => {
  /* Deferring the fetch creates a state that could not happen before: the
     modal is open and the briefs are still in flight. It opens on the
     action_items table — correctly, that is the floor — and it has to move
     when they arrive. Nothing on screen would say it had not: a stale table
     is a plausible table.

     What carries that is props.briefs in buildPreviewModel's memo
     dependencies. F3 put it there; this drives the real component to show it
     does the work, because a dependency list is only ever exercised by a
     SECOND render. */
  const prevWindow = global.window;
  const prevDocument = global.document;
  const prevReact = global.React;
  try {
    global.window = { FieldSight: { ModalOverlay: function ModalOverlay() {} }, FS: { api: {} } };
    global.document = {
      createElement() { return { style: {} }; },
      addEventListener() {}, removeEventListener() {},
    };
    delete require.cache[require.resolve('../scripts/composites/email-preview-modal.js')];
    require('../scripts/composites/email-preview-modal.js');
    const Modal = global.window.FieldSight.EmailPreviewModal;
    assert.strictEqual(typeof Modal, 'function', 'the modal is not on window');

    const React = memoReact();
    global.React = React;
    /* Same object identities across both renders except `briefs` — so the
       only thing that can make the table move is the one dependency under
       test. */
    const base = {
      open: true, onClose() {}, topics: [topic()], session: null,
      date: '2026-03-01', siteName: 'SB1108 Ellesmere',
      deepLink: 'https://example.test/#/timeline', userFolder: null,
    };
    const brieftext = 'Redo the west wall to line before the next pour';

    React.__render();
    const before = allText(Modal(Object.assign({}, base, { briefs: [] })));
    assert.ok(before.includes('Redo the west wall'),
      'the modal opens on the action_items table, which is the floor');
    assert.ok(!before.includes(brieftext),
      'and it cannot be showing a brief it was never given');

    React.__render();
    const after = allText(Modal(Object.assign({}, base, { briefs: BRIEFS })));
    assert.ok(after.includes(brieftext),
      'the briefs arrived and the table did not move — the memo returned its '
      + 'cached model, so the modal is sitting on action_items with nothing '
      + 'anywhere saying it is out of date');
  } finally {
    global.React = prevReact;
    global.window = prevWindow;
    global.document = prevDocument;
  }
});
