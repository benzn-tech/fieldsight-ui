'use strict';

/*
 * Sites and users come from the org directory, never from the legacy gateway
 * and never from fixtures in live mode. Assertions are on the paths handed to
 * orgRequest and on the legacy request() (which must stay untouched).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';

let orgCalls, legacyCalls, reply, role;

function load(opts) {
  opts = opts || {};
  orgCalls = []; legacyCalls = [];
  global.window = {
    FieldSight: { fixtures: { sites: { sites: [{ site_id: 'fx-site', name: 'Fixture Site' }],
                                       users: [{ name: 'Fixture Person', folder_name: 'Fixture_Person', sites: ['fx-site'] }] } } },
    AuthMock: { currentUser: { role: role, name: 'Caller One' } },
    FS: { api: {
      useMocks: !!opts.mocks,
      orgBaseUrl: 'https://org.example/prod/api',
      delay: function () { return Promise.resolve(); },
      folderName: function (n) { return String(n).replace(/ /g, '_'); },
      request: function (p) { legacyCalls.push(p); return Promise.resolve({ sites: [], users: [] }); },
      orgRequest: function (p) {
        orgCalls.push(p);
        var v = reply(p);
        return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
      },
    } },
  };
  ['org.js', 'sites.js'].forEach(function (f) {
    var p = require.resolve('../scripts/api/' + f);
    delete require.cache[p];
    require(p);
  });
  return global.window.FS.api;
}

const SITES = { sites: [{ id: SITE_A, slug: 'site-a', name: 'Site A' }, { id: SITE_B, slug: 'site-b', name: 'Site B' }] };
const MEMBERS_A = { members: [{ cognito_sub: 's1', first_name: 'Ann', last_name: 'One', global_role: 'worker', site_role: 'pm' },
                              { cognito_sub: 's2', first_name: 'Bob', last_name: 'Two', global_role: 'worker', site_role: 'worker' }] };
const MEMBERS_B = { members: [{ cognito_sub: 's2', first_name: 'Bob', last_name: 'Two', global_role: 'worker', site_role: 'worker' },
                              { cognito_sub: 's3', first_name: 'Cy', last_name: 'Three', global_role: 'worker', site_role: 'worker' }] };

function directory(p) {
  if (p === '/sites') return SITES;
  if (p === '/members') return { members: MEMBERS_A.members.concat(MEMBERS_B.members.slice(1)) };
  if (p === '/sites/' + SITE_A + '/members') return MEMBERS_A;
  if (p === '/sites/' + SITE_B + '/members') return MEMBERS_B;
  return new Error('unexpected ' + p);
}

test('getSites reads GET /sites and keeps both the UUID site_id and the slug', async () => {
  role = 'admin'; reply = directory;
  const api = load();
  const res = await api.sites.getSites();
  assert.deepStrictEqual(orgCalls, ['/sites']);
  assert.deepStrictEqual(res.sites.map(function (s) { return [s.site_id, s.slug, s.name]; }),
    [[SITE_A, 'site-a', 'Site A'], [SITE_B, 'site-b', 'Site B']]);
  assert.deepStrictEqual(legacyCalls, []);
});

for (const r of ['admin', 'gm', 'platform_admin']) {
  test('getUsers as ' + r + ' reads GET /members once', async () => {
    role = r; reply = directory;
    const api = load();
    const res = await api.sites.getUsers();
    assert.deepStrictEqual(orgCalls, ['/members']);
    assert.deepStrictEqual(res.users.map(function (u) { return u.name; }), ['Ann One', 'Bob Two', 'Cy Three']);
    assert.strictEqual(res.users[0].folder_name, 'Ann_One');
    assert.ok(res.users[0].device_id, 'rows carry the legacy device_id');
    assert.deepStrictEqual(legacyCalls, []);
  });
}

test('getUsers as site_manager never touches /members: sites, then each site members, de-duplicated', async () => {
  role = 'site_manager'; reply = directory;
  const api = load();
  const res = await api.sites.getUsers();
  assert.deepStrictEqual(orgCalls.slice().sort(),
    ['/sites', '/sites/' + SITE_A + '/members', '/sites/' + SITE_B + '/members'].sort());
  assert.ok(orgCalls.indexOf('/members') < 0);
  assert.deepStrictEqual(res.users.map(function (u) { return u.device_id; }).sort(), ['s1', 's2', 's3']);
  assert.deepStrictEqual(legacyCalls, []);
});

test('getUsers as site_manager: one refused site is skipped, the other still supplies the roster', async () => {
  role = 'site_manager';
  reply = function (p) {
    if (p === '/sites/' + SITE_A + '/members') return { _accessDenied: true, status: 403, error: 'no' };
    return directory(p);
  };
  const api = load();
  const res = await api.sites.getUsers();
  assert.deepStrictEqual(res.users.map(function (u) { return u.device_id; }).sort(), ['s2', 's3']);
  reply = function (p) {
    if (p === '/sites/' + SITE_A + '/members') return new Error('boom');
    return directory(p);
  };
  assert.deepStrictEqual((await api.sites.getUsers()).users.map(function (u) { return u.device_id; }).sort(), ['s2', 's3']);
});

test('getUsers as site_manager: every site refused rejects; zero sites resolves empty', async () => {
  role = 'site_manager';
  reply = function (p) {
    return p === '/sites' ? SITES : { _accessDenied: true, status: 403, error: 'no' };
  };
  const api = load();
  await assert.rejects(api.sites.getUsers(), /failed \(403\)/);
  reply = function (p) { return p === '/sites' ? { sites: [] } : new Error('unexpected ' + p); };
  assert.deepStrictEqual(await api.sites.getUsers(), { users: [] });
});

test('getSiteUsers takes a UUID as-is', async () => {
  role = 'admin'; reply = directory;
  const api = load();
  const res = await api.sites.getSiteUsers(SITE_A);
  assert.deepStrictEqual(orgCalls, ['/sites/' + SITE_A + '/members']);
  assert.strictEqual(res.users[0].role, 'pm', 'role is the one held ON the site');
});

test('getSiteUsers resolves a legacy slug to the UUID through the directory', async () => {
  role = 'admin'; reply = directory;
  const api = load();
  await api.sites.getSiteUsers('site-b');
  assert.deepStrictEqual(orgCalls, ['/sites', '/sites/' + SITE_B + '/members']);
});

test('getSiteUsers returns an access-denied result as-is, with no legacy retry', async () => {
  role = 'admin';
  reply = function (p) { return p.indexOf('/members') > 0 ? { _accessDenied: true, status: 403, error: 'no' } : SITES; };
  const api = load();
  api.legacyReadFallback = true;   // the flag that used to route this to /site-users
  const res = await api.sites.getSiteUsers(SITE_A);
  assert.strictEqual(res._accessDenied, true);
  assert.deepStrictEqual(legacyCalls, []);
});

test('live: a failed /members rejects; it does not resolve to fixture people', async () => {
  role = 'admin';
  reply = function () { return new Error('boom'); };
  const api = load();
  await assert.rejects(api.sites.getUsers(), /boom/);
  reply = function () { return { _accessDenied: true, status: 403, error: 'no' }; };
  await assert.rejects(api.sites.getUsers(), /failed \(403\)/);
  await assert.rejects(api.sites.getSites(), /failed \(403\)/);
});

test('live: a rejected getUsers makes the user-activity roster reject, not fixture-filled', async () => {
  role = 'admin';
  reply = function () { return new Error('boom'); };
  const api = load();
  api.dates = { getDates: function () { return Promise.resolve({ dates: {} }); } };
  const p = require.resolve('../scripts/api/user-activity-aggregator.js');
  delete require.cache[p]; require(p);
  await assert.rejects(api.userActivity.getUserActivityRange({ from: '2026-10-01', to: '2026-10-02' }), /boom/);
});

test('mock mode is unchanged: fixtures, and no request of any kind', async () => {
  role = 'admin'; reply = function () { return new Error('must not be called'); };
  const api = load({ mocks: true });
  assert.deepStrictEqual((await api.sites.getSites()).sites.map(function (s) { return s.site_id; }), ['fx-site']);
  assert.deepStrictEqual((await api.sites.getUsers()).users.map(function (u) { return u.name; }), ['Fixture Person']);
  assert.deepStrictEqual((await api.sites.getSiteUsers('fx-site')).users.length, 1);
  assert.deepStrictEqual(orgCalls.concat(legacyCalls), []);
});

/* WIRING ONLY: source scan. These consumers each had a catch that swapped a
   failed live getUsers() for the fixture roster. */
test('wiring-only: no consumer substitutes fixture users for a failed getUsers()', () => {
  const root = path.join(__dirname, '..', 'scripts');
  ['api/compliance-aggregator.js', 'api/tasks-aggregator.js', 'pages/today.js', 'pages/evidence.js']
    .forEach(function (f) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
      const hits = code.split('\n').filter(function (l) {
        return /fixtures\.sites\.users|fx\.users/.test(l);
      });
      assert.deepStrictEqual(hits, [], f + ' still reads fixture users');
    });
});

test('wiring-only: sites.js makes no legacy read request and no legacy fallback', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'api', 'sites.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/legacyReadFallback/.test(code));
  /* Any request('/sites|/users|/site-users...') is a legacy call, whatever
     follows the path. The out-of-scope writers (createSite, createUser,
     updateUserRole) are excluded by FUNCTION scope: only their own bodies are
     blanked out, so a read added anywhere else is still caught. */
  const reads = code.replace(/async function (createSite|createUser|updateUserRole)[\s\S]*?\r?\n  \}\r?\n/g, '');
  assert.deepStrictEqual(reads.match(/request\(\s*['"`]\/(sites|users|site-users)/g), null);
});
