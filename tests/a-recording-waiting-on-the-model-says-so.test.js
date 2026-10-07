'use strict';

/*
 * Owner, 2026-10-07: a recording that uploaded fine while our AI model is down
 * must never fail silently. One banner per pending session on the caller's own
 * Timeline/Today day, an Expedite button, a 60 s re-poll, and a page refresh
 * when a session recovers (model-fallback spec D6).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const flush = () => new Promise((r) => setImmediate(r));

const SESSION = { session_id: 'sid1', date: '2026-10-07', time_range: '15:40–15:41',
  first_failed_at: '2026-10-07T02:41:00Z', attempts: 2, expedited_at: null };

/* ---- a tiny hook runtime (same shape other component tests here use) ---- */
function mount(opts) {
  opts = opts || {};
  const h = { states: [], refs: [], effects: [], intervals: [], cleaned: 0, store: {}, calls: [], warns: [] };
  let si = 0, ri = 0, ei = 0;
  global.React = {
    Fragment: 'Fragment',
    createElement(type, props, ...kids) { return { type, props: props || {}, kids }; },
    useState(init) {
      const i = si++;
      if (!(i in h.states)) h.states[i] = typeof init === 'function' ? init() : init;
      return [h.states[i], (v) => { h.states[i] = typeof v === 'function' ? v(h.states[i]) : v; }];
    },
    useRef(init) { const i = ri++; if (!(i in h.refs)) h.refs[i] = { current: init }; return h.refs[i]; },
    useEffect(fn, deps) { const i = ei++; h.effects[i] = { fn, deps }; },
  };
  global.setInterval = (fn, ms) => { h.intervals.push({ fn, ms, live: true }); return h.intervals.length; };
  global.clearInterval = (id) => { if (h.intervals[id - 1]) h.intervals[id - 1].live = false; };
  const org = {
    pending: opts.pending || [],
    getPendingSessions: async (o) => { h.calls.push(['pending', o.date]); return { sessions: org.pending }; },
    expediteSession: async (sid) => {
      h.calls.push(['expedite', sid]);
      if (opts.expedite) return opts.expedite(sid);
      return { ok: true, expedited_at: new Date().toISOString() };
    },
  };
  global.window = {
    FS: { api: { org } },
    localStorage: opts.noStorage ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }
      : { getItem: (k) => (k in h.store ? h.store[k] : null), setItem: (k, v) => { h.store[k] = String(v); } },
  };
  global.window.console = { warn: (...a) => h.warns.push(a.join(' ')) };
  delete require.cache[require.resolve('../scripts/composites/pending-notes-banner.js')];
  const mod = require('../scripts/composites/pending-notes-banner.js');
  h.org = org; h.mod = mod;
  h.recovered = [];
  h.props = { date: '2026-10-07', enabled: true, onRecovered: (ids) => h.recovered.push(ids) };
  h.render = (p) => {
    si = 0; ri = 0; ei = 0;
    h.tree = mod.PendingNotesBanners(Object.assign({}, h.props, p || {}));
    return h.tree;
  };
  /* run effects whose deps changed since the last run */
  h.prevDeps = [];
  h.runEffects = () => {
    h.effects.forEach((e, i) => {
      const prev = h.prevDeps[i];
      const same = prev && e.deps && prev.length === e.deps.length && prev.every((d, k) => d === e.deps[k]);
      if (same) return;
      if (h.cleanups && h.cleanups[i]) { h.cleanups[i](); h.cleaned++; }
      h.cleanups = h.cleanups || [];
      h.cleanups[i] = e.fn();
      h.prevDeps[i] = e.deps;
    });
  };
  h.cycle = async () => { h.render(); h.runEffects(); await flush(); h.render(); h.runEffects(); await flush(); return h.render(); };
  h.nodes = () => {
    const out = [];
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      out.push(n); (n.kids || []).forEach(walk);
    })(h.tree);
    return out;
  };
  h.text = () => h.nodes().filter((n) => n.type === 'button' || n.type === 'span' || (n.props && n.props.className === 'fs-pending-notes__text'))
    .map((n) => n.kids.filter((k) => typeof k === 'string').join('')).join(' | ');
  h.button = () => h.nodes().find((n) => n.type === 'button');
  return h;
}

test('a pending session renders one banner with the owner wording and an Expedite button', async () => {
  const h = mount({ pending: [SESSION] });
  await h.cycle();
  const banners = h.nodes().filter((n) => n.props.className === 'fs-pending-notes__banner');
  assert.strictEqual(banners.length, 1);
  assert.match(h.text(), /Your recording \(15:40–15:41\) was uploaded safely and won’t be lost\. Our AI model is temporarily unavailable — we’re reconnecting automatically and will show your notes as soon as it recovers\./);
  assert.strictEqual(h.button().kids[0], 'Expedite');
  assert.ok(!h.button().props.disabled);
  assert.deepStrictEqual(h.calls[0], ['pending', '2026-10-07']);
});

test('two pending sessions render two banners', async () => {
  const h = mount({ pending: [SESSION, Object.assign({}, SESSION, { session_id: 'sid2', time_range: '16:00–16:02' })] });
  await h.cycle();
  assert.strictEqual(h.nodes().filter((n) => n.props.className === 'fs-pending-notes__banner').length, 2);
});

test('nothing renders when there is nothing pending', async () => {
  const h = mount({ pending: [] });
  const tree = await h.cycle();
  assert.strictEqual(tree, null);
  assert.strictEqual(h.intervals.length, 0, 'no polling when no banner shows');
});

test('nothing renders when the lookup fails (404/403/network) and nothing throws', async () => {
  const h = mount();
  h.org.getPendingSessions = async () => { throw new Error('network'); };
  const tree = await h.cycle();
  assert.strictEqual(tree, null);
  assert.ok(h.warns.some((w) => /poll failed/.test(w)));
});

test('not shown for another person\'s day, and no request is made', async () => {
  const h = mount({ pending: [SESSION] });
  h.props.enabled = false;
  const tree = await h.cycle();
  assert.strictEqual(tree, null);
  assert.strictEqual(h.calls.length, 0);
});

test('expedite success: button becomes the disabled notified text and is remembered', async () => {
  const h = mount({ pending: [SESSION] });
  await h.cycle();
  h.button().props.onClick();
  await flush(); await flush();
  h.render();
  assert.deepStrictEqual(h.calls.filter((c) => c[0] === 'expedite'), [['expedite', 'sid1']]);
  assert.strictEqual(h.button().kids[0], 'We’ve been notified and are on it');
  assert.strictEqual(h.button().props.disabled, true);
  const saved = JSON.parse(h.store['fs.pendingNotes.expedited']);
  assert.ok(Date.now() - saved.sid1 < 5000);
});

test('429 already expedited shows the notified state too', async () => {
  const h = mount({ pending: [SESSION], expedite: async () => { const e = new Error('already expedited'); e.status = 429; e.body = { error: 'already expedited', retry_after_s: 300 }; throw e; } });
  await h.cycle();
  h.button().props.onClick();
  await flush(); await flush();
  h.render();
  assert.strictEqual(h.button().kids[0], 'We’ve been notified and are on it');
  assert.strictEqual(h.button().props.disabled, true);
});

test('other errors say "Couldn’t reach us — try again" and keep the button', async () => {
  const h = mount({ pending: [SESSION], expedite: async () => { throw new Error('HTTP 500'); } });
  await h.cycle();
  h.button().props.onClick();
  await flush(); await flush();
  h.render();
  assert.match(h.text(), /Couldn’t reach us — try again/);
  assert.strictEqual(h.button().kids[0], 'Expedite');
  assert.ok(!h.button().props.disabled);
  assert.strictEqual(h.store['fs.pendingNotes.expedited'], undefined);
});

test('expedited within 10 min (server or this browser) loads in the notified state; older does not', async () => {
  const now = Date.now();
  const recent = mount({ pending: [Object.assign({}, SESSION, { expedited_at: new Date(now - 3 * 60000).toISOString() })] });
  await recent.cycle();
  assert.strictEqual(recent.button().kids[0], 'We’ve been notified and are on it');

  const old = mount({ pending: [Object.assign({}, SESSION, { expedited_at: new Date(now - 11 * 60000).toISOString() })] });
  await old.cycle();
  assert.strictEqual(old.button().kids[0], 'Expedite');

  const local = mount({ pending: [SESSION] });
  local.store['fs.pendingNotes.expedited'] = JSON.stringify({ sid1: now - 2 * 60000 });
  await local.cycle();
  assert.strictEqual(local.button().kids[0], 'We’ve been notified and are on it');

  const stale = mount({ pending: [SESSION] });
  stale.store['fs.pendingNotes.expedited'] = JSON.stringify({ sid1: now - 11 * 60000 });
  await stale.cycle();
  assert.strictEqual(stale.button().kids[0], 'Expedite');
});

test('blocked localStorage never breaks the banner or the click', async () => {
  const h = mount({ pending: [SESSION], noStorage: true });
  await h.cycle();
  h.button().props.onClick();
  await flush(); await flush();
  h.render();
  assert.strictEqual(h.button().kids[0], 'We’ve been notified and are on it');
});

test('polling every 60 s removes a recovered banner and asks the page to refresh', async () => {
  const h = mount({ pending: [SESSION] });
  await h.cycle();
  const live = h.intervals.filter((i) => i.live);
  assert.strictEqual(live.length, 1);
  assert.strictEqual(live[0].ms, 60000);
  assert.deepStrictEqual(h.recovered, []);
  h.org.pending = [];                       /* the model came back, notes exist */
  live[0].fn();
  await flush();
  const tree = await h.cycle();
  assert.strictEqual(tree, null, 'banner gone');
  assert.deepStrictEqual(h.recovered, [['sid1']], 'page asked to reload its data');
  assert.strictEqual(h.intervals.filter((i) => i.live).length, 0, 'polling stops with the last banner');
});

test('a poll that still lists the session keeps the banner and does not refresh', async () => {
  const h = mount({ pending: [SESSION] });
  await h.cycle();
  h.intervals.filter((i) => i.live)[0].fn();
  await flush();
  h.render();
  assert.strictEqual(h.nodes().filter((n) => n.props.className === 'fs-pending-notes__banner').length, 1);
  assert.deepStrictEqual(h.recovered, []);
});

/* ---- org.js: mock mode, live paths, body whitelist ---- */
function loadOrg(apiOver) {
  const calls = [];
  global.window = { FS: { api: Object.assign({
    useMocks: false, orgBaseUrl: 'https://org', orgWrites: true,
    delay: async () => {},
    orgRequest: async (p, o) => { calls.push([p, o]); return {}; },
  }, apiOver || {}) }, console };
  global.window.FieldSight = {};
  delete require.cache[require.resolve('../scripts/api/org.js')];
  require('../scripts/api/org.js');
  return { org: global.window.FS.api.org, calls };
}

test('org.js mock mode: pending is empty, expedite is ok', async () => {
  const { org, calls } = loadOrg({ useMocks: true });
  assert.deepStrictEqual(await org.getPendingSessions({ date: '2026-10-07' }), { sessions: [] });
  const r = await org.expediteSession('sid1');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls.length, 0);
});

test('org.js live: GET asks for the day; 404/403 envelopes and errors mean none', async () => {
  const a = loadOrg({ orgRequest: async (p, o) => { a.calls.push([p, o]); return { sessions: [SESSION] }; } });
  const res = await a.org.getPendingSessions({ date: '2026-10-07' });
  assert.deepStrictEqual(res.sessions, [SESSION]);
  assert.deepStrictEqual(a.calls[0], ['/sessions/pending', { params: { date: '2026-10-07' } }]);

  const b = loadOrg({ orgRequest: async () => ({ _notFound: true, status: 404 }) });
  assert.deepStrictEqual(await b.org.getPendingSessions({ date: 'x' }), { sessions: [] });
  const c = loadOrg({ orgRequest: async () => ({ _accessDenied: true, status: 403 }) });
  assert.deepStrictEqual(await c.org.getPendingSessions({ date: 'x' }), { sessions: [] });
  const d = loadOrg({ orgRequest: async () => { throw new Error('network'); } });
  assert.deepStrictEqual(await d.org.getPendingSessions({ date: 'x' }), { sessions: [] });
});

test('org.js live: expedite POSTs a whitelisted body to the session; 429 is a result, 500 throws', async () => {
  const a = loadOrg({ orgRequest: async (p, o) => { a.calls.push([p, o]); return { ok: true, expedited_at: '2026-10-07T03:00:00Z' }; } });
  const r = await a.org.expediteSession('sid/1');
  assert.deepStrictEqual(r, { ok: true, expedited_at: '2026-10-07T03:00:00Z' });
  assert.strictEqual(a.calls[0][0], '/sessions/sid%2F1/expedite');
  assert.strictEqual(a.calls[0][1].method, 'POST');
  assert.deepStrictEqual(a.calls[0][1].body, { session_id: 'sid/1' });

  const e429 = Object.assign(new Error('already expedited'), { status: 429, body: { error: 'already expedited', retry_after_s: 120 } });
  const b = loadOrg({ orgRequest: async () => { throw e429; } });
  assert.deepStrictEqual(await b.org.expediteSession('s'), { ok: false, alreadyExpedited: true, retry_after_s: 120 });

  const c = loadOrg({ orgRequest: async () => { throw Object.assign(new Error('HTTP 500'), { status: 500 }); } });
  await assert.rejects(() => c.org.expediteSession('s'), /HTTP 500/);
});

/* ---- wiring: pinned at the source, both pages and the shell ---- */
test('both pages mount the banners, the Timeline only for the caller\'s own day, and the shell loads them', () => {
  const TL = read('scripts', 'pages', 'timeline.js');
  const TD = read('scripts', 'pages', 'today.js');
  const HTML = read('app-shell-preview.html');
  assert.match(TL, /Middle:   TimelineWithPendingNotes,/);
  assert.match(TL, /enabled: isOwnDayView\(caller, params, callerFolder\(\)\),/);
  assert.match(TL, /return !!\(scope\.user && me && scope\.user === me\);/);
  assert.match(TL, /TimelineMiddleColumn\(Object\.assign\(\{\}, props, \{ reloadTick: tk\[0\] \}\)\)/);
  assert.match(TL, /\}, \[date, user, retryCount, props\.reloadTick\]\);/);
  assert.match(TD, /Middle:   TodayWithPendingNotes,/);
  assert.match(TD, /if \(ctx && ctx\.reload\) ctx\.reload\(\);/);
  assert.match(TD, /reload: function \(\) \{ setRetry\(function \(n\) \{ return n \+ 1; \}\); \} \};/);
  assert.match(HTML, /scripts\/composites\/pending-notes-banner\.js\?v=\d+/);
  assert.ok(HTML.indexOf('pending-notes-banner.js') < HTML.indexOf('scripts/pages/today.js?v'));
});

test('the Timeline only offers the banners on the caller own day', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'pages', 'timeline.js'), 'utf8');
  assert.match(src, /isOwnDayView: isOwnDayView,/);
  /* load the real function from the page's own exports */
  const prevWin = global.window;
  global.window = { FS: { api: { callerFolder: () => 'Ben_Lin_admin' }, Router: {} }, FieldSight: {} };
  global.React = global.React || { createElement() {}, useState() { return [null, () => {}]; }, useEffect() {}, useRef() { return {}; } };
  delete require.cache[require.resolve('../scripts/pages/timeline.js')];
  let tl;
  try { tl = require('../scripts/pages/timeline.js'); } finally { global.window = prevWin; }
  const admin = { role: 'admin', isAdmin: true };
  const worker = { role: 'worker' };
  assert.strictEqual(tl.isOwnDayView(admin, {}, 'Ben_Lin_admin'), true, 'default landing is my own day');
  assert.strictEqual(tl.isOwnDayView(admin, { user: 'Ben_Lin_admin' }, 'Ben_Lin_admin'), true, 'explicitly my own folder');
  assert.strictEqual(tl.isOwnDayView(admin, { user: 'Ben_Lin_test2' }, 'Ben_Lin_admin'), false, 'an admin on someone else day');
  assert.strictEqual(tl.isOwnDayView(admin, { view: 'team' }, 'Ben_Lin_admin'), false, 'the team view');
  assert.strictEqual(tl.isOwnDayView(worker, { user: 'Someone_Else' }, 'Me'), true, 'a worker is pinned to self');
});

test('a pending session with no time range reads without empty brackets', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'scripts', 'composites', 'pending-notes-banner.js'), 'utf8');
  const m = src.match(/body: function \(range\) \{([\s\S]*?)\n    \}/);
  const body = new Function('range', m[1]);
  require('node:assert').strictEqual(body(''), body(null));
  require('node:assert').ok(!body('').includes('()'));
  require('node:assert').ok(body('15:40–15:41').includes('(15:40–15:41)'));
});
