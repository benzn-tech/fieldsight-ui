'use strict';
/*
 * "My folder" is an identity key from the directory, never a display name.
 *
 * Prod 2026-10-07: Deandre's display name is "Deandre' Alberts" (the
 * apostrophe is intentional) and his recording folder is "Deandre__Alberts".
 * Pages derived "my folder" from the display name ("Deandre'_Alberts"), asked
 * the backend for that folder, and were refused their OWN day (403).
 *
 * Rule pinned here: window.FS.api.callerFolder() returns
 * AuthMock.currentUser.folder_name; only MOCK mode may fall back to the name;
 * live mode without a folder_name returns null and the callers omit `user`.
 * Driven through the real api/index.js and the real aggregators/adapters; only
 * the transports (timeline, dates, sites) are faked.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REAL = 'Deandre__Alberts';
const GUESS = "Deandre'_Alberts";
const DEANDRE = { name: "Deandre' Alberts", role: 'worker', folder_name: REAL };

const requested = [];       /* every `user` any fake transport was asked for */

function load(caller, o) {
  o = o || {};
  requested.length = 0;
  global.document = { addEventListener() {}, createElement() { return { style: {} }; } };
  global.window = {
    FieldSight: { fixtures: {} },
    FS: {},
    AuthMock: { currentUser: caller },
    location: { href: 'https://example.test/', search: '', hostname: 'example.test' },
    addEventListener() {}, removeEventListener() {},
  };
  const idx = require.resolve('../scripts/api/index.js');
  delete require.cache[idx];
  require(idx);
  const api = global.window.FS.api;
  api.useMocks = !!o.mocks;                   /* the mode is the point of the test */
  api.delay = function () { return Promise.resolve(); };
  api.pooledAll = function (thunks) { return Promise.all(thunks.map(function (t) { return t(); })); };
  return api;
}

function loadModule(f) {
  const p = require.resolve('../scripts/api/' + f);
  delete require.cache[p];
  require(p);
}

/* ---- 1. the helper itself --------------------------------------------------- */

test('callerFolder is the directory folder, not the display name', () => {
  const api = load(DEANDRE);
  assert.strictEqual(api.callerFolder(), REAL);
  assert.notStrictEqual(api.callerFolder(), GUESS);
});

test('live mode without a folder_name returns null (callers omit user), never a guess', () => {
  const api = load({ name: "Deandre' Alberts", role: 'worker' });
  assert.strictEqual(api.callerFolder(), null);
});

test('mock mode keeps deriving from the name when there is no folder_name', () => {
  const api = load({ name: 'Jarley Trainor', role: 'worker' }, { mocks: true });
  assert.strictEqual(api.callerFolder(), 'Jarley_Trainor');
});

test('mock mode still prefers a real folder_name when one is carried', () => {
  const api = load(DEANDRE, { mocks: true });
  assert.strictEqual(api.callerFolder(), REAL);
});

test('no caller at all is null in both modes', () => {
  assert.strictEqual(load(null).callerFolder(), null);
  assert.strictEqual(load(null, { mocks: true }).callerFolder(), null);
});

/* ---- 4. folderName is idempotent on a value that is already a folder -------- */

test('folderName() leaves an existing folder alone (timeline/audio/meetings pass folders through it)', () => {
  const api = load(DEANDRE);
  assert.strictEqual(api.folderName(REAL), REAL);
  assert.strictEqual(api.folderName(api.folderName(REAL)), REAL);
  assert.strictEqual(api.folderName('Ben_Lin_admin'), 'Ben_Lin_admin');
});

/* ---- 2. every aggregator/adapter asks for the directory folder -------------- */

function wireFanout(api, report) {
  api.window = { getSpan: function () { return Promise.resolve({ dates: { '2026-10-06': { hasReport: true } } }); },
                 MONTHS_LOOKBACK: 3 };
  api.timeline = { getTimeline: function (a) {
    requested.push({ via: 'timeline', user: a.user });
    return Promise.resolve(report || { _notFound: true });
  } };
  api.org = { getOrgSites: function () { return Promise.resolve({ sites: [] }); },
              getComplianceResolutions: function () { return Promise.resolve({ resolutions: [] }); },
              getObservations: function () { return Promise.resolve({ observations: [] }); },
              getLiveItems: function () { return Promise.resolve({ topics: [] }); } };
  api.sites = { getUsers: function () { return Promise.resolve({ users: [] }); },
                getSiteUsers: function () { return Promise.resolve({ users: [] }); } };
  api.dates = { getDates: function (a) { requested.push({ via: 'dates', user: a.user });
                 return Promise.resolve({ dates: { '2026-10-06': { hasReport: true } } }); } };
}

const RANGE = { from: '2026-10-01', to: '2026-10-07' };

test('tasks aggregator asks for Deandre__Alberts (non-admin, live)', async () => {
  const api = load({ name: "Deandre' Alberts", role: 'pm', folder_name: REAL });
  wireFanout(api);
  loadModule('tasks-aggregator.js');
  await api.tasks.getActionsResolvedRange(RANGE);
  assert.ok(requested.length >= 1);
  requested.forEach((r) => assert.strictEqual(r.user, REAL));
});

test('tasks aggregator, live worker without folder_name: no name-derived folder is sent', async () => {
  const api = load({ name: "Deandre' Alberts", role: 'worker' });
  wireFanout(api);
  loadModule('tasks-aggregator.js');
  await api.tasks.getActionsResolvedRange(RANGE);
  assert.ok(requested.length >= 1, 'the day should still be asked for (the server resolves self)');
  requested.forEach((r) => assert.ok(!r.user, 'sent ' + r.user));
});

test('tasks aggregator, mock mode unchanged: derives from the name', async () => {
  const api = load({ name: 'Jarley Trainor', role: 'worker' }, { mocks: true });
  wireFanout(api);
  loadModule('tasks-aggregator.js');
  await api.tasks.getActionsResolvedRange(RANGE);
  assert.ok(requested.length >= 1);
  requested.forEach((r) => assert.strictEqual(r.user, 'Jarley_Trainor'));
});

test('compliance aggregator asks for Deandre__Alberts (safety and quality)', async () => {
  const api = load({ name: "Deandre' Alberts", role: 'pm', folder_name: REAL });
  wireFanout(api);
  loadModule('compliance-aggregator.js');
  for (const fn of ['getSafetyRange', 'getQualityRange']) {
    assert.strictEqual(typeof api.compliance[fn], 'function', fn);
    requested.length = 0;
    await api.compliance[fn](RANGE).catch(function () {});
    const t = requested.filter((r) => r.via === 'timeline');
    assert.ok(t.length >= 1, fn + ' never asked for a day');
    t.forEach((r) => assert.strictEqual(r.user, REAL, fn));
  }
});

test('compliance aggregator, live without folder_name: no guessed folder', async () => {
  const api = load({ name: "Deandre' Alberts", role: 'pm' });
  wireFanout(api);
  loadModule('compliance-aggregator.js');
  for (const fn of ['getSafetyRange', 'getQualityRange']) {
    requested.length = 0;
    await api.compliance[fn](RANGE).catch(function () {});
    requested.filter((r) => r.via === 'timeline').forEach((r) => assert.ok(!r.user, fn + ' sent ' + r.user));
  }
});

test('task rows are owned by the folder that was asked for, not one derived from user_name', async () => {
  const api = load({ name: "Deandre' Alberts", role: 'pm', folder_name: REAL });
  wireFanout(api, { report_date: '2026-10-06', user_name: "Deandre' Alberts", site: 'S', topics: [
    { topic_id: 1, topic_title: 'T', action_items: [{ action: 'do it', responsible: 'Someone', status: 'open' }] }] });
  loadModule('tasks-aggregator.js');
  const res = await api.tasks.getActionsResolvedRange(RANGE);
  const blob = JSON.stringify(res);
  assert.ok(blob.includes(REAL), 'the row does not carry the real folder: ' + blob.slice(0, 300));
  assert.ok(!blob.includes(GUESS), 'a row carries the name-derived folder: ' + blob.slice(0, 300));
});

test('user-activity worker self is the directory folder; without one, nobody is invented', async () => {
  let api = load(DEANDRE);
  wireFanout(api);
  loadModule('user-activity-aggregator.js');
  await api.userActivity.getUserActivityRange({ from: '2026-10-06', to: '2026-10-06' }).catch(function () {});
  const t = requested.filter((r) => r.via === 'timeline');
  assert.ok(t.length >= 1);
  t.forEach((r) => assert.strictEqual(r.user, REAL));

  api = load({ name: "Deandre' Alberts", role: 'worker' });
  wireFanout(api);
  loadModule('user-activity-aggregator.js');
  const res = await api.userActivity.getUserActivityRange({ from: '2026-10-06', to: '2026-10-06' }).catch(function () { return {}; });
  requested.forEach((r) => assert.ok(!r.user, 'sent ' + r.user));
  assert.deepStrictEqual((res && res.users) || [], []);
});

/* ---- 3. other people: the members payload carries the real folder ----------- */

test('org.js: a member that carries folder_name keeps it, whatever the name looks like', async () => {
  const api = load({ name: 'Admin', role: 'admin', folder_name: 'Admin_One' });
  api.orgBaseUrl = 'https://org.example/api';
  api.orgRequest = function () { return Promise.resolve({ members: [
    { cognito_sub: 's1', first_name: "Deandre'", last_name: 'Alberts', global_role: 'worker', folder_name: REAL },
    { cognito_sub: 's2', first_name: 'Ann', last_name: 'One', global_role: 'worker' },
  ] }); };
  loadModule('org.js');
  const res = await api.org.getMembers();
  const by = {}; res.members.forEach((m) => { by[m.device_id] = m; });
  assert.strictEqual(by.s1.folder_name, REAL);
  assert.strictEqual(by.s2.folder_name, 'Ann_One');          /* absent -> derived, as before */
});

/* ---- wiring: nothing derives the caller's folder from the name any more ----- */

test('no script derives "my folder" from the caller name (callerFolder() is the one door)', () => {
  const offenders = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      if (!/\.js$/.test(e.name) || p.endsWith(path.join('api', 'index.js'))) return;
      fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach(function (line, i) {
        if (/^\s*(\/\*|\*|\/\/)/.test(line)) return;
        if (/folderName\(\s*(caller|rdCaller|u|currentUser|window\.AuthMock\.currentUser)\.name/.test(line)) {
          offenders.push(path.relative(ROOT, p) + ':' + (i + 1) + ': ' + line.trim());
        }
      });
    });
  })(path.join(ROOT, 'scripts'));
  assert.deepStrictEqual(offenders, []);
});
