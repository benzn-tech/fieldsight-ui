'use strict';
/*
 * Review round for "own folder comes from the directory":
 *   1. Today (single-project path): the OWN report's owner folder is the
 *      directory folder, so own-report edit rights hold and the morning-brief
 *      "Read full brief" link carries Deandre__Alberts, not Deandre'_Alberts.
 *   2. session-bridge clears folder_name when the next sign-in has none.
 *   3. Today programme: no folder => nothing, except for admin-like callers.
 *   4. Photo keys for the caller's own report use the real folder.
 */
const test = require('node:test');
const assert = require('node:assert');

const REAL = 'Deandre__Alberts';
const GUESS = "Deandre'_Alberts";
const NAME = "Deandre' Alberts";

function loadReal(caller, mocks) {
  global.React = {};
  global.document = { addEventListener() {}, removeEventListener() {}, createElement() { return { style: {} }; } };
  global.window = {
    FieldSight: { fixtures: {} }, FS: {}, AuthMock: { currentUser: caller },
    location: { href: 'https://example.test/', search: '', hostname: 'example.test' },
    addEventListener() {}, removeEventListener() {},
  };
  const idx = require.resolve('../scripts/api/index.js');
  delete require.cache[idx];
  require(idx);
  global.window.FS.api.useMocks = !!mocks;
  return global.window.FS.api;
}

function load(f) {
  const p = require.resolve('../scripts/api/' + f);
  delete require.cache[p];
  require(p);
}

const REPORT = {
  report_date: '2026-10-06', site: 'S', user_name: NAME, executive_summary: ['Brief'],
  safety_observations: [],
  topics: [{ topic_id: 1, topic_title: 'T', action_items: [{ action: 'a', responsible: null }] }],
};

/* ---- 1. Today, single-project path ------------------------------------------ */

test("Today: Deandre's own report is owned by Deandre__Alberts and the brief link says so", () => {
  const api = loadReal({ name: NAME, role: 'worker', folder_name: REAL });
  load('mine-team.js');
  load('today-adapter.js');
  const out = api.todayAdapter.adapt(REPORT, { currentUserName: NAME });   /* no idPrefix: single-project path */
  assert.strictEqual(out.morningBrief.userFolder, REAL);
  const items = out.myTasks.concat(out.teamTasks);
  assert.ok(items.length >= 1);
  items.forEach((i) => assert.strictEqual(i.folder, REAL));
  /* own-report edit rights: the page compares callerFolder() to item.folder */
  items.forEach((i) => assert.strictEqual(api.callerFolder(), i.folder));
  /* and the unassigned item on his own report is Mine */
  assert.strictEqual(out.myTasks.length, 1);
  assert.ok(!JSON.stringify(out).includes(GUESS));
});

test("Today: someone else's report keeps the derived folder (nothing better is known)", () => {
  const api = loadReal({ name: NAME, role: 'pm', folder_name: REAL });
  load('mine-team.js');
  load('today-adapter.js');
  const out = api.todayAdapter.adapt(Object.assign({}, REPORT, { user_name: 'Ann One' }), { currentUserName: NAME });
  assert.strictEqual(out.morningBrief.userFolder, 'Ann_One');
});

test('reportOwnerFolder: a report that names its folder wins over any derivation', () => {
  const api = loadReal({ name: NAME, role: 'worker', folder_name: REAL });
  assert.strictEqual(api.reportOwnerFolder({ user: 'Z__Z', user_name: NAME }), 'Z__Z');
});

/* ---- 4. photo keys ---------------------------------------------------------- */

test('own-report photo rows carry the real folder, so photoKey() builds users/Deandre__Alberts/...', () => {
  const api = loadReal({ name: NAME, role: 'worker', folder_name: REAL });
  load('evidence-grouping.js');
  const rows = api.evidenceGrouping.photosForReport({
    user_name: NAME, topics: [{ topic_id: 1, topic_title: 'T', related_photos: ['a.jpg'] }], photo_filenames: ['b.jpg'] });
  assert.ok(rows.length === 2);
  rows.forEach((r) => assert.strictEqual(api.folderName(r.userDisplayName), REAL));
});

/* ---- 2. session bridge ------------------------------------------------------ */

function bridge(sessionUsers) {
  const updates = [];
  const handlers = [];
  global.window = {
    FS_ENV: { useMocks: false },
    FS: { session: { user: null, onChange: (h) => handlers.push(h) }, api: { useMocks: false } },
    AuthMock: { currentUser: {}, updateProfile(p) { updates.push(p); Object.assign(this.currentUser, p); } },
    addEventListener() {},
  };
  global.document = { addEventListener() {} };
  const p = require.resolve('../scripts/auth/session-bridge.js');
  delete require.cache[p];
  require(p);
  sessionUsers.forEach((u) => { global.window.FS.session.user = u; handlers.forEach((h) => h()); });
  return global.window.AuthMock.currentUser;
}

test('a later sign-in without a folder does not inherit the previous account folder', () => {
  const cur = bridge([
    { email: 'a@x.co', display_name: NAME, role: 'worker', folder_name: REAL },
    { email: 'b@x.co', display_name: 'Ann One', role: 'worker' },
  ]);
  assert.ok(!cur.folder_name, 'kept the previous folder: ' + cur.folder_name);
});

test('a sign-in with a folder carries it', () => {
  const cur = bridge([{ email: 'a@x.co', display_name: NAME, role: 'worker', folder_name: REAL }]);
  assert.strictEqual(cur.folder_name, REAL);
});

/* ---- 3. today programme: null folder --------------------------------------- */

function programmeApi(caller) {
  delete require.cache[require.resolve('../scripts/api/today-programme-adapter.js')];
  global.window = {
    FieldSight: { programmeSchedule: { computeCriticalPath: () => [] } },
    FS: { api: {
      addDaysISO: (iso, n) => { const p = iso.split('-').map(Number);
        return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10); },
      todayNZDT: () => '2026-05-01',
      folderName: (n) => n,
      callerFolder: () => caller.folder_name || null,
      pooledAll: (t) => Promise.all(t.map((f) => f())),
      org: { getOrgSites: async () => ({ sites: [{ site_id: 's1', name: 'Site 1' }] }) },
      programme: { getProgramme: async () => ({ programme: { start_date: '2026-01-01', end_date: '2026-12-31', leaves: [] ,
        tasks: [] } }) },
    } },
    AuthMock: { currentUser: caller },
  };
  global.window.window = global.window;
  let asked = 0;
  global.window.FS.api.org.getOrgSites = async () => { asked++; return { sites: [] }; };
  require('../scripts/api/today-programme-adapter.js');
  return { api: global.window.FS.api.todayProgramme, asked: () => asked };
}

test('programme: a non-admin with no folder is never sent on to the all-assignees path', async () => {
  const h = programmeApi({ name: NAME, role: 'pm' });
  const r = await h.api.getTodayProgrammeTasks({});
  const r2 = await h.api.getUpcomingProgrammeTasks({ from: '2026-04-01', to: '2026-05-10' });
  assert.deepStrictEqual(r.rows, []);
  assert.deepStrictEqual(r2.rows, []);
  assert.strictEqual(h.asked(), 0, 'it went on to read programmes');
});

test('programme: an admin with no folder still gets the all-assignees path', async () => {
  const h = programmeApi({ name: 'Ada', role: 'admin', isAdmin: true });
  await h.api.getTodayProgrammeTasks({});
  await h.api.getUpcomingProgrammeTasks({ from: '2026-04-01', to: '2026-05-10' });
  assert.strictEqual(h.asked(), 2);
});
