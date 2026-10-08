'use strict';
/*
 * Rows carry the owner's FOLDER; the web must prefer it over a name derivation.
 *
 * Prod 2026-10-07: "Deandre' Alberts" derives to "Deandre'_Alberts" but the
 * recording folder is "Deandre__Alberts". org-api now sends `user_folder` on
 * topic rows (live-items) and `author_folder` on observations, and `user` on
 * the report body. Rule: use the field when present (null = no linked user,
 * stays null); derive from the name only when the field is ABSENT (old
 * backend / mock).
 */
const test = require('node:test');
const assert = require('node:assert');

const REAL = 'Deandre__Alberts';
const GUESS = "Deandre'_Alberts";
const NAME = "Deandre' Alberts";
const RANGE = { from: '2026-10-06', to: '2026-10-06' };

function load(extra) {
  global.document = { addEventListener() {}, createElement() { return { style: {} }; } };
  global.window = {
    FieldSight: { fixtures: {} }, FS: {},
    AuthMock: { currentUser: { name: 'Admin Person', role: 'admin', folder_name: 'Admin__Person' } },
    location: { href: 'https://example.test/', search: '', hostname: 'example.test' },
    addEventListener() {}, removeEventListener() {},
  };
  const idx = require.resolve('../scripts/api/index.js');
  delete require.cache[idx];
  require(idx);
  const api = global.window.FS.api;
  api.useMocks = false;
  api.delay = function () { return Promise.resolve(); };
  api.pooledAll = function (thunks) { return Promise.all(thunks.map(function (t) { return t(); })); };
  api.window = { getSpan: function () { return Promise.resolve({ dates: { '2026-10-06': { hasReport: true } } }); },
                 MONTHS_LOOKBACK: 3 };
  api.timeline = { getTimeline: function () { return Promise.resolve(extra.report || { _notFound: true }); } };
  api.org = {
    getOrgSites: function () { return Promise.resolve({ sites: [] }); },
    getComplianceResolutions: function () { return Promise.resolve({ resolutions: [] }); },
    getObservations: function () { return Promise.resolve({ observations: extra.observations || [] }); },
    getLiveItems: function () { return Promise.resolve({ topics: extra.topics || [] }); },
  };
  api.sites = { getUsers: function () { return Promise.resolve({ users: [{ name: NAME, folder_name: REAL, role: 'worker' }] }); },
                getSiteUsers: function () { return Promise.resolve({ users: [] }); } };
  api.dates = { getDates: function () { return Promise.resolve({ dates: { '2026-10-06': { hasReport: true } } }); } };
  ['compliance-aggregator.js', 'tasks-aggregator.js'].forEach(function (f) {
    const p = require.resolve('../scripts/api/' + f);
    delete require.cache[p];
    require(p);
  });
  return api;
}

function obs(extra) {
  return Object.assign({ id: 'o1', kind: 'safety', site_slug: 'site-a', report_date: '2026-10-06',
    author_sub: 's1', author_name: NAME, observation: 'Open edge', status: 'open' }, extra);
}
function liveTopic(extra) {
  return Object.assign({ id: 't1', site_name: 'Site A', user_name: NAME, category: 'safety',
    title: 'Edge', summary: '', report_date: '2026-10-06', action_items: [],
    safety_observations: [{ id: 'x1', observation: 'Unprotected edge', risk_level: 'high' }], is_live: true }, extra);
}

test('rowFolder: field wins, null stays null, absent derives', () => {
  const api = load({});
  assert.strictEqual(api.rowFolder({ user_folder: REAL, user_name: NAME }, 'user_folder', 'user_name'), REAL);
  assert.strictEqual(api.rowFolder({ user_folder: null, user_name: NAME }, 'user_folder', 'user_name'), null);
  assert.strictEqual(api.rowFolder({ user_name: NAME }, 'user_folder', 'user_name'), GUESS);
  assert.strictEqual(api.rowFolder({}, 'user_folder', 'user_name'), null);
});

test('manual observations use author_folder', async () => {
  const api = load({ observations: [obs({ author_folder: REAL })] });
  const res = await api.compliance.getSafetyRange(RANGE);
  const row = (res.rows || res.flags || []).filter((r) => r.source === 'manual')[0];
  assert.ok(row, 'manual row expected: ' + JSON.stringify(Object.keys(res)));
  assert.strictEqual(row.user_folder, REAL);
});

test('manual observations from an old backend (no author_folder) keep the name fallback', async () => {
  const api = load({ observations: [obs({})] });
  const res = await api.compliance.getSafetyRange(RANGE);
  const row = (res.rows || res.flags || []).filter((r) => r.source === 'manual')[0];
  assert.strictEqual(row.user_folder, GUESS);
});

test('manual observation with a null author_folder stays null', async () => {
  const api = load({ observations: [obs({ author_folder: null })] });
  const res = await api.compliance.getSafetyRange(RANGE);
  const row = (res.rows || res.flags || []).filter((r) => r.source === 'manual')[0];
  assert.strictEqual(row.user_folder, null);
});

test('live safety rows use topic.user_folder', async () => {
  const api = load({ topics: [liveTopic({ user_folder: REAL })] });
  const res = await api.compliance.getSafetyRange(RANGE);
  const row = (res.rows || res.flags || []).filter((r) => r.source === 'live')[0];
  assert.ok(row, 'live row expected');
  assert.strictEqual(row.user_folder, REAL);
});

test('live safety rows without user_folder (old backend) derive from the name', async () => {
  const api = load({ topics: [liveTopic({})] });
  const res = await api.compliance.getSafetyRange(RANGE);
  const row = (res.rows || res.flags || []).filter((r) => r.source === 'live')[0];
  assert.strictEqual(row.user_folder, GUESS);
});

test('reportOwnerFolder prefers the report body `user` over the name', () => {
  const api = load({});
  assert.strictEqual(api.reportOwnerFolder({ user: REAL, user_name: NAME }), REAL);
  assert.notStrictEqual(api.reportOwnerFolder({ user: REAL, user_name: NAME }), GUESS);
});

test('tasks/compliance rows from a report body use report.user, not user_name', async () => {
  const report = { user: REAL, user_name: NAME, site: 'Site A', report_date: '2026-10-06',
    topics: [{ topic_id: 1, topic_title: 'Edge', category: 'safety',
      safety_flags: ['Unprotected edge near stairs'], action_items: [{ action: 'Fence it', responsible: 'Sam' }] }] };
  const api = load({ report });
  const res = await api.compliance.getSafetyRange(RANGE);
  const rows = (res.rows || res.flags || []);
  assert.ok(rows.length >= 1);
  rows.forEach((r) => { assert.notStrictEqual(r.user_folder, GUESS); });
});
