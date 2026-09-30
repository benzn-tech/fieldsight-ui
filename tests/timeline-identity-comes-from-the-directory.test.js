'use strict';
/*
 * Own-day identity comes from the directory, not from the display name.
 *
 * The page used to ask for "my day" by guessing a folder out of the caller's
 * display name (`Ben Lin` -> `Ben_Lin`). Display names are not unique and the
 * guess belongs to nobody in the Aurora directory, so org-api's ACL correctly
 * refused it -- and the page then fell through to the legacy gateway, whose
 * frozen user map answered "Access denied to this user".
 *
 * The aurora request for an own-day view now omits `user`, so org-api resolves
 * the caller's folder from the directory. `user: null` is NOT used for that:
 * on this page it already means the team view. What these pin:
 *   1. the request each scope produces, driven through the real page component
 *      and the real api/timeline.js (only the transport is faked);
 *   2. the legacy fallback still sends exactly what it always did;
 *   3. the subject the page shows comes from the response, not the guess;
 *   4. legacyReadFallback defaults to true when the build does not emit it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/* ---- a tiny hook runtime: enough to run the page's effects for real ------- */

function makeRuntime(Component, props) {
  const hooks = [];
  let idx = 0;
  let pending = [];
  let tree = null;
  let dirty = false;
  const React = {
    createElement(type, p, ...children) {
      const flat = [];
      (function push(list) {
        list.forEach(function (c) {
          if (Array.isArray(c)) push(c);
          else if (c !== null && c !== undefined && c !== false) flat.push(c);
        });
      })(children);
      return { type: type, props: p || {}, children: flat };
    },
    useState(init) {
      const i = idx++;
      if (!hooks[i]) {
        const cell = { v: typeof init === 'function' ? init() : init };
        cell.set = function (n) {
          const next = typeof n === 'function' ? n(cell.v) : n;
          if (next !== cell.v) { cell.v = next; dirty = true; }
        };
        hooks[i] = cell;
      }
      return [hooks[i].v, hooks[i].set];
    },
    useRef(v) { const i = idx++; if (!hooks[i]) hooks[i] = { current: v }; return hooks[i]; },
    useMemo(fn, deps) {
      const i = idx++;
      if (!hooks[i] || !deps || deps.some((d, k) => d !== hooks[i].deps[k])) hooks[i] = { v: fn(), deps: deps };
      return hooks[i].v;
    },
    useCallback(fn) { idx++; return fn; },
    useContext() { return null; },
    useLayoutEffect() { idx++; },
    useEffect(fn, deps) {
      const i = idx++;
      const prev = hooks[i];
      if (!prev || !deps || deps.some((d, k) => d !== prev.deps[k])) {
        pending.push(function () {
          if (prev && prev.cleanup) prev.cleanup();
          hooks[i] = { deps: deps, cleanup: fn() };
        });
      }
    },
    Fragment: 'Fragment', memo(c) { return c; },
  };
  global.React = React;
  return {
    async settle() {
      for (let round = 0; round < 40; round++) {
        dirty = false; idx = 0;
        tree = Component(props);
        const run = pending; pending = [];
        run.forEach(function (f) { f(); });
        await new Promise(function (r) { setImmediate(r); });
        if (!dirty && pending.length === 0) break;
      }
      return tree;
    },
  };
}

function find(node, pred, out) {
  out = out || [];
  if (!node || typeof node !== 'object') return out;
  if (pred(node)) out.push(node);
  (node.children || []).forEach(function (c) { find(c, pred, out); });
  return out;
}

/* ---- the page, mounted against the real api/timeline.js ------------------- */

const GUESS = 'Ben_Lin';                       /* what folderName('Ben Lin') gives */
const REAL  = 'Ben_Lin_admin';                 /* what the directory holds */

function goodReport(over) {
  return Object.assign({
    user_name: 'Ben Lin', user: REAL, report_date: '2026-09-29',
    topics: [{ topic_id: 1, topic_title: 'T' }],
  }, over || {});
}

function mount(o) {
  o = o || {};
  const calls = { org: [], legacy: [], nav: [], meeting: [] };
  const report = o.report || goodReport();
  const api = {
    useMocks: false,
    timelineSource: 'aurora',
    orgBaseUrl: 'https://org.example',
    legacyReadFallback: o.legacy !== false,
    folderName: function (n) { return String(n || '').replace(/ /g, '_'); },
    todayNZDT: function () { return '2026-09-29'; },
    delay: function () { return Promise.resolve(); },
    cache: { cached: function (k, t, fn) { return fn(); } },
    orgRequest: function (p, opts) {
      calls.org.push({ path: p, params: opts && opts.params });
      if (o.orgHangs) return new Promise(function () {});
      return Promise.resolve(o.orgResponse || report);
    },
    request: function (p, opts) {
      calls.legacy.push({ path: p, params: opts && opts.params });
      return Promise.resolve(o.legacyResponse || report);
    },
    org: { getOrgSites: function () { return Promise.resolve({ sites: [] }); },
           getSessionsCached: function () { return Promise.resolve({ sessions: [] }); } },
    programme: { getSuggestions: function () { return Promise.resolve({ suggestions: [] }); } },
    actions: { getActions: function () { return Promise.resolve({ actions: {} }); } },
    meetings: { getMeetingMinutes: function (a) { calls.meeting.push(a); return Promise.resolve({ _notFound: true }); } },
    dates: { getDates: function () { return Promise.resolve({ dates: {} }); } },
  };
  global.document = { addEventListener() {}, removeEventListener() {}, createElement() { return { style: {} }; } };
  global.window = {
    FieldSight: { Card: Object.assign(function Card() {}, { Body: function () {} }),
                  AccessDenied: function AccessDenied() {} },
    FS: {
      api: api,
      can: function () { return true; }, P: function (a, b) { return a + ':' + b; },
      Router: {
        getCurrentRoute: function () { return { params: o.params || {} }; },
        subscribe: function () { return function () {}; }, navigate: function (u) { calls.nav.push(u); },
      },
    },
    AuthMock: { currentUser: { name: 'Ben Lin', role: o.role || 'pm' } },
    location: { href: 'https://example.test/#/timeline' },
    addEventListener() {}, removeEventListener() {},
  };
  delete require.cache[require.resolve('../scripts/api/timeline.js')];
  require('../scripts/api/timeline.js');
  delete require.cache[require.resolve('../scripts/pages/timeline.js')];
  require('../scripts/pages/timeline.js');
  const Middle = global.window.FieldSight.PAGES['/timeline'].Middle;
  const rt = makeRuntime(Middle, { selectedItem: null, onSelect: function () {} });
  return { rt: rt, calls: calls };
}

function header(tree) {
  return find(tree, function (n) { return typeof n.type === 'function' && n.type.name === 'PageHeader'; })[0];
}

function timelineCalls(list) { return list.filter(function (c) { return c.path === '/timeline'; }); }

/* True only when the key is really on the object (an `undefined` value would
   still serialise away, but a key present with null/'' would not). */
function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

/* ---- 1. what each scope sends -------------------------------------------- */

test('own-day by default: the aurora request omits user (the server decides)', async () => {
  const m = mount({ params: { date: '2026-09-29' } });
  await m.rt.settle();
  const c = timelineCalls(m.calls.org);
  assert.ok(c.length >= 1, 'no aurora /timeline call was made');
  c.forEach((x) => {
    assert.ok(!has(x.params, 'user'), 'the guessed folder leaked into the aurora request: ' + JSON.stringify(x.params));
    assert.strictEqual(x.params.date, '2026-09-29');
  });
});

test('an explicit ?user= is still sent, exactly as before', async () => {
  const m = mount({ params: { date: '2026-09-29', user: 'James_Lamb' } });
  await m.rt.settle();
  const c = timelineCalls(m.calls.org);
  assert.ok(c.length >= 1);
  c.forEach((x) => assert.deepStrictEqual(x.params, { date: '2026-09-29', user: 'James_Lamb' }));
});

test('?view=team stays the team view: user:null, and no "resolve self" request', async () => {
  const { resolveTimelineScope } = require('../scripts/pages/timeline.js');
  const s = resolveTimelineScope({ role: 'pm' }, { view: 'team' }, GUESS);
  assert.strictEqual(s.user, null, 'team view must still be user:null');
  assert.strictEqual(s.resolveSelf, false, 'team view must not ask the server to resolve self');
  const m = mount({ params: { date: '2026-09-29', view: 'team' } });
  await m.rt.settle();
  /* Whatever the team view fetches, it is never a self-resolving own-day one. */
  assert.strictEqual(timelineCalls(m.calls.org).filter((x) => !has(x.params, 'user')).length, 0,
    'the team view sent an own-day request (no user)');
});

test('a worker is pinned to self and lets the server resolve it, whatever the URL says', async () => {
  const m = mount({ role: 'worker', params: { date: '2026-09-29', user: 'Someone_Else' } });
  await m.rt.settle();
  const c = timelineCalls(m.calls.org);
  assert.ok(c.length >= 1);
  c.forEach((x) => assert.ok(!has(x.params, 'user'), 'worker aurora request carried ' + JSON.stringify(x.params)));
});

test('resolveTimelineScope: resolveSelf only for the implicit own-day and for workers', () => {
  const { resolveTimelineScope: r } = require('../scripts/pages/timeline.js');
  assert.deepStrictEqual(r({ role: 'pm' }, {}, GUESS), { user: GUESS, selfDefaulted: true, resolveSelf: true });
  assert.deepStrictEqual(r({ role: 'pm' }, { user: 'X_Y' }, GUESS), { user: 'X_Y', selfDefaulted: false, resolveSelf: false });
  assert.deepStrictEqual(r({ role: 'pm' }, { view: 'team' }, GUESS), { user: null, selfDefaulted: false, resolveSelf: false });
  assert.deepStrictEqual(r({ role: 'worker' }, { user: 'X_Y' }, GUESS), { user: GUESS, selfDefaulted: false, resolveSelf: true });
});

/* ---- 2. the legacy fallback is untouched ---------------------------------- */

test('when aurora denies, the legacy fallback still sends the page\'s user, as before', async () => {
  const m = mount({ params: { date: '2026-09-29' }, orgResponse: { _accessDenied: true, error: 'no' } });
  await m.rt.settle();
  const legacy = timelineCalls(m.calls.legacy);
  assert.ok(legacy.length >= 1, 'the fallback never ran');
  legacy.forEach((x) => assert.deepStrictEqual(x.params, { date: '2026-09-29', user: GUESS }));
});

test('with the legacy fallback retired, a denial is final and nothing legacy is asked', async () => {
  const m = mount({ params: { date: '2026-09-29' }, legacy: false, orgResponse: { _accessDenied: true, error: 'no' } });
  await m.rt.settle();
  assert.strictEqual(timelineCalls(m.calls.legacy).length, 0);
});

/* ---- 3. the subject comes from the response ------------------------------- */

test('the header names the person the server returned, not the guessed folder', async () => {
  const m = mount({ params: { date: '2026-09-29' } });
  const tree = await m.rt.settle();
  const h = header(tree);
  assert.ok(h, 'no PageHeader rendered');
  assert.strictEqual(h.props.subjectName, 'Ben Lin');
  assert.strictEqual(h.props.user, REAL, 'follow-up calls must use the server\'s folder, not the guess');
});

test('a success body with only user_name (folder form) leaves the page on that folder, not the guess', async () => {
  const m = mount({ params: { date: '2026-09-29' },
    report: goodReport({ user: undefined, user_name: 'Ben_Lin_test2' }) });
  const tree = await m.rt.settle();
  const h = header(tree);
  assert.strictEqual(h.props.user, 'Ben_Lin_test2');
  assert.strictEqual(h.props.subjectName, 'Ben Lin test2');
});

test('before the server answers, the header does not name anyone', async () => {
  const m = mount({ params: { date: '2026-09-29' }, orgHangs: true });
  const tree = await m.rt.settle();
  const h = header(tree);
  assert.ok(h);
  assert.strictEqual(h.props.subjectName, '');
});

test('an access-denied own-day never names the guessed person', async () => {
  const m = mount({ params: { date: '2026-09-29' }, legacy: false,
    orgResponse: { _accessDenied: true, error: 'No directory folder for this account' } });
  const tree = await m.rt.settle();
  const ad = find(tree, function (n) { return typeof n.type === 'function' && n.type.name === 'AccessDenied'; })[0];
  assert.ok(ad, 'no AccessDenied rendered');
  assert.strictEqual(ad.props.scope, 'your daily report');
  assert.ok(!/Ben Lin/.test(ad.props.scope), 'named the guessed person');
});

test('an explicit ?user= keeps deriving the subject from the URL', async () => {
  const m = mount({ params: { date: '2026-09-29', user: 'James_Lamb' },
    report: goodReport({ user_name: 'James Lamb', user: undefined }) });
  const tree = await m.rt.settle();
  const h = header(tree);
  assert.strictEqual(h.props.subjectName, undefined);
  assert.strictEqual(h.props.user, 'James_Lamb');
});

/* ---- 4. the legacy switch ------------------------------------------------- */

function apiFlagFor(env) {
  global.window = { FS_ENV: env, FieldSight: {} };
  delete require.cache[require.resolve('../scripts/api/index.js')];
  require('../scripts/api/index.js');
  return global.window.FS.api.legacyReadFallback;
}

test('legacyReadFallback defaults to true when the env key is absent; only an explicit false retires it', () => {
  assert.strictEqual(apiFlagFor({}), true);
  assert.strictEqual(apiFlagFor({ orgWrites: true }), true);
  assert.strictEqual(apiFlagFor({ legacyReadFallback: true }), true);
  assert.strictEqual(apiFlagFor({ legacyReadFallback: false }), false);
});

test('the build emits the key, defaulting to true, as the last positional value', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'amplify.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(/legacyReadFallback: %s \};/.test(yml), 'format string lacks the key');
  assert.ok(/"\$\{FS_NAV_DAILY_V2:-false\}" "\$\{FS_LEGACY_READ_FALLBACK:-true\}"\n/.test(yml),
    'the default must be true and sit right after navDailyV2, matching the format string order');
});

/* ---- 5. the date-less entry point, meeting minutes, the cache comment ------ */

test('a bare /timeline (no date) keeps the own-day implicit across its redirect', async () => {
  const m = mount({ params: {} });
  await m.rt.settle();
  assert.ok(m.calls.nav.length >= 1, 'the bootstrap never redirected');
  m.calls.nav.forEach((u) => {
    assert.ok(/^\/timeline\?date=2026-09-29/.test(u), u);
    assert.ok(!/user=/.test(u), 'the guessed folder was written into the URL: ' + u);
  });
});

test('the site-anchored bootstrap redirect keeps the own-day implicit too', async () => {
  const m = mount({ params: { site: 's1' } });
  await m.rt.settle();
  assert.ok(m.calls.nav.length >= 1, 'the site bootstrap never redirected');
  m.calls.nav.forEach((u) => assert.ok(!/user=/.test(u), u));
});

test('an explicit ?user= survives the bootstrap redirect', async () => {
  const m = mount({ params: { user: 'James_Lamb' } });
  await m.rt.settle();
  assert.ok(m.calls.nav.some((u) => /&user=James_Lamb/.test(u)), JSON.stringify(m.calls.nav));
});

test('meeting minutes on the own-day path use the folder the server resolved', async () => {
  const m = mount({ params: { date: '2026-09-29' } });
  await m.rt.settle();
  assert.ok(m.calls.meeting.length >= 1);
  m.calls.meeting.forEach((c) => assert.strictEqual(c.user, REAL));
});

test('meeting minutes fall back to the guess when the answer names no folder', async () => {
  const m = mount({ params: { date: '2026-09-29' }, report: goodReport({ user: undefined, user_name: undefined }) });
  await m.rt.settle();
  assert.ok(m.calls.meeting.length >= 1);
  m.calls.meeting.forEach((c) => assert.strictEqual(c.user, GUESS));
});

test('meeting minutes for an explicit ?user= still use that user', async () => {
  const m = mount({ params: { date: '2026-09-29', user: 'James_Lamb' } });
  await m.rt.settle();
  m.calls.meeting.forEach((c) => assert.strictEqual(c.user, 'James_Lamb'));
});

test('the cache-key comment in api/timeline.js says what the key contains', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/api/timeline.js'), 'utf8');
  assert.ok(!/includes only \(date, user\)/.test(src), 'stale: the key also carries resolveSelf');
  assert.ok(/:self/.test(src) && /resolveSelf/.test(src));
});
