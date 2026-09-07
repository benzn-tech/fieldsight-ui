'use strict';

/*
 * Unit tests for the Team page's "Reassign to another site" action, which
 * until now was a lie the code admitted to in its own comment:
 *
 *   scripts/pages/team.js  "Mock-only mutation in Sprint 9 (no /api/users
 *   PATCH yet). Live path would: PATCH /api/users/{device_id} ..."
 *
 * Pressing Reassign ran a 200ms setTimeout, patched local React state and
 * showed a green "Reassigned to X" toast. No request was ever sent, so the
 * move was gone on the next refresh while the admin had been told it worked.
 *
 * The backend now has the routes it was waiting for (pipeline #786):
 *   PUT    /api/org/members/{sub}/memberships/{site_id}  {role}
 *   DELETE /api/org/members/{sub}/memberships/{site_id}
 *
 * These tests cover org.js's three new helpers for real, and pin that team.js
 * actually calls them -- a helper that is written, tested and never invoked is
 * the same dead path in a different place.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/* ---- harness ------------------------------------------------------------- */

let calls;

function loadOrg(apiOverrides) {
  calls = { req: [] };
  global.window = {
    FieldSight: { fixtures: { users: [], sites: [] } },
    FS: {
      api: Object.assign({
        useMocks: false,
        orgWrites: true,
        orgBaseUrl: 'https://org.example/prod/api',
        delay: function () { return Promise.resolve(); },
        orgRequest: function (p, opts) {
          calls.req.push({ path: p, method: (opts && opts.method) || 'GET',
                           body: opts && opts.body });
          return Promise.resolve({ membership: { site_id: 'x', role: 'worker' } });
        },
      }, apiOverrides || {}),
    },
  };
  global.window.FieldSight.api = global.window.FS.api;
  delete require.cache[require.resolve('../scripts/api/org.js')];
  require('../scripts/api/org.js');
  return global.window.FS.api.org;
}

/* ---- PUT: put someone on a project --------------------------------------- */

test('setMemberSite PUTs the per-site role to the membership route', async () => {
  const org = loadOrg();
  await org.setMemberSite('sub-2', 'site-9', 'pm');
  assert.deepStrictEqual(calls.req, [{
    path: '/members/sub-2/memberships/site-9',
    method: 'PUT',
    body: { role: 'pm' },
  }]);
});

test('setMemberSite escapes ids rather than pasting them into the path', async () => {
  const org = loadOrg();
  await org.setMemberSite('sub/2', 'site 9', 'worker');
  assert.strictEqual(calls.req[0].path, '/members/sub%2F2/memberships/site%209');
});

/* ---- DELETE: take someone off one project -------------------------------- */

test('removeMemberSite DELETEs that one membership', async () => {
  const org = loadOrg();
  await org.removeMemberSite('sub-2', 'site-1');
  assert.deepStrictEqual(calls.req, [{
    path: '/members/sub-2/memberships/site-1',
    method: 'DELETE',
    body: undefined,
  }]);
});

/* ---- the move ------------------------------------------------------------ */

test('moveMemberToSite adds the new project BEFORE removing the old one', async () => {
  /* Order is the whole safety argument. If the add fails after the remove,
     the person is on no project at all; this way a half-done move leaves them
     on both, which an admin can see and undo. */
  const org = loadOrg();
  await org.moveMemberToSite('sub-2', 'site-1', 'site-9', 'site_manager');
  assert.deepStrictEqual(calls.req.map(function (c) { return [c.method, c.path]; }), [
    ['PUT', '/members/sub-2/memberships/site-9'],
    ['DELETE', '/members/sub-2/memberships/site-1'],
  ]);
  assert.deepStrictEqual(calls.req[0].body, { role: 'site_manager' });
});

test('moveMemberToSite does not remove anything when the target is the current site', async () => {
  const org = loadOrg();
  await org.moveMemberToSite('sub-2', 'site-9', 'site-9', 'worker');
  assert.deepStrictEqual(calls.req.map(function (c) { return c.method; }), ['PUT']);
});

test('moveMemberToSite does not remove the old project when the add fails', async () => {
  const org = loadOrg({
    orgRequest: function (p, opts) {
      calls.req.push({ path: p, method: (opts && opts.method) || 'GET' });
      return Promise.reject(new Error('403'));
    },
  });
  await assert.rejects(function () {
    return org.moveMemberToSite('sub-2', 'site-1', 'site-9', 'worker');
  });
  assert.deepStrictEqual(calls.req.map(function (c) { return c.method; }), ['PUT']);
});

test('moveMemberToSite defaults to worker when no role is carried over', async () => {
  const org = loadOrg();
  await org.moveMemberToSite('sub-2', 'site-1', 'site-9');
  assert.deepStrictEqual(calls.req[0].body, { role: 'worker' });
});

/* ---- the write kill switch ----------------------------------------------- */

test('no request is sent while org writes are switched off', async () => {
  /* FS_ORGWRITES=false is how the dev site points at prod read-only. A
     staffing call must go to the mock branch there, not to prod. */
  const org = loadOrg({ orgWrites: false });
  await org.moveMemberToSite('sub-2', 'site-1', 'site-9', 'pm');
  assert.deepStrictEqual(calls.req, []);
});

/* ---- wiring: the page must actually call it ------------------------------ */

test('team.js reassign is wired to the API and no longer fakes the mutation', () => {
  /* A source check on purpose, and only for wiring: the modal is React and
     there is no renderer in this suite, so what is pinned here is that the
     helper is CALLED and that the mock-only path is gone -- not how the
     helper behaves, which the tests above drive for real. */
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'pages', 'team.js'), 'utf8');
  assert.ok(/moveMemberToSite\s*\(/.test(src),
    'team.js must call org.moveMemberToSite');
  assert.ok(!/Mock-only mutation/.test(src),
    'the mock-only reassign path must be gone, not merely bypassed');
  assert.ok(!/setTimeout\([^)]*onSubmit/.test(src),
    'reassign must not resolve on a timer');
});
