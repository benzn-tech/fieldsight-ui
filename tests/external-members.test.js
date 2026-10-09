'use strict';

/*
 * A company admin (or platform_admin) adds an existing user of ANOTHER company
 * to one project by login email. The api layer owns the body whitelist, the
 * role gate and the error sentences; the pages are browser IIFEs with no
 * export, so their wiring is pinned by source (as the neighbouring page tests
 * do) and the behaviour is asserted on the api functions they call.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let calls, reply;
function loadOrg(live) {
  calls = [];
  global.window = {
    FieldSight: { fixtures: {} },
    FS: { api: {
      useMocks: !live, orgWrites: !!live, timelineSource: 'aurora',
      orgBaseUrl: live ? 'https://org.example/prod/api' : '',
      delay: function () { return Promise.resolve(); },
      orgRequest: function (p, opts) {
        calls.push({ path: p, method: opts && opts.method, body: opts && opts.body });
        return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
      },
    } },
  };
  delete require.cache[require.resolve('../scripts/api/org.js')];
  require('../scripts/api/org.js');
  return global.window.FS.api.org;
}
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'scripts', f), 'utf8').replace(/\r\n/g, '\n');
function httpErr(status, error) { const e = new Error(error); e.status = status; e.body = { error }; return e; }

test('the body is exactly {email, role}: extra fields never ride along', async () => {
  const org = loadOrg(true);
  reply = { external: true };
  await org.addExternalMember('site-1', { email: ' a@b.co ', role: 'pm', company_id: 'x', global_role: 'admin' });
  assert.strictEqual(calls[0].path, '/sites/site-1/external-members');
  assert.strictEqual(calls[0].method, 'POST');
  assert.deepStrictEqual(calls[0].body, { email: 'a@b.co', role: 'pm' });
});

test('mock mode returns a fake external row and makes no request', async () => {
  const org = loadOrg(false);
  const row = await org.addExternalMember('s', { email: 'jo@other.co', role: 'worker' });
  assert.strictEqual(row.external, true);
  assert.ok(row.home_company_name);
  assert.strictEqual(calls.length, 0);
});

test('403/404 envelopes become thrown errors carrying status and server text', async () => {
  const org = loadOrg(true);
  reply = { _notFound: true, status: 404, raw: { error: 'no FieldSight user with that email' } };
  await assert.rejects(org.addExternalMember('s', { email: 'x@y.z', role: 'worker' }),
    (e) => e.status === 404 && /no FieldSight user/.test(e.body.error));
  reply = { _accessDenied: true, status: 403, error: 'Access denied.' };
  await assert.rejects(org.addExternalMember('s', { email: 'x@y.z', role: 'worker' }), (e) => e.status === 403);
});

test('error mapping: 404 user, 404 site, 400 same-company, 400 other, 409, 403', () => {
  const org = loadOrg(true);
  const m = org.externalMemberErrorMessage;
  assert.strictEqual(m(httpErr(404, 'no FieldSight user with that email')), 'No FieldSight user with that email');
  assert.strictEqual(m(httpErr(404, 'site not found')), 'Project not found');
  assert.strictEqual(m(httpErr(400, 'use the normal add member')), 'This person is already in your company — use Add member');
  assert.strictEqual(m(httpErr(400, 'invalid email')), 'invalid email');
  assert.strictEqual(m(httpErr(409, 'already a member')), 'Already a member of this project');
  assert.strictEqual(m(httpErr(403, 'x')), 'Only company admins can add external members');
  assert.strictEqual(m(new Error('boom')), 'Could not add external member');
});

test('only admin and platform_admin may add; gm/pm/site_manager/worker may not', () => {
  const org = loadOrg(true);
  assert.strictEqual(org.canAddExternalMember({ role: 'admin' }), true);
  assert.strictEqual(org.canAddExternalMember({ role: 'platform_admin' }), true);
  for (const r of ['gm', 'pm', 'site_manager', 'worker', undefined]) {
    assert.strictEqual(org.canAddExternalMember({ role: r }), false, String(r));
  }
  assert.strictEqual(org.canAddExternalMember(null), false);
});

test('badge text: "from {home company}" for external rows, nothing otherwise', () => {
  const org = loadOrg(true);
  assert.strictEqual(org.externalBadgeText({ external: true, home_company_name: 'Acme Ltd' }), 'from Acme Ltd');
  assert.strictEqual(org.externalBadgeText({ external: true }), 'external');
  assert.strictEqual(org.externalBadgeText({ name: 'Own' }), '');
});

test('external flags survive the member-list mapping', async () => {
  const org = loadOrg(true);
  reply = { members: [{ cognito_sub: 'a', first_name: 'Jo', global_role: 'worker', site_role: 'pm',
                        external: true, home_company_name: 'Acme Ltd' }] };
  const r = await org.getSiteMembers('s');
  assert.strictEqual(r.users[0].external, true);
  assert.strictEqual(r.users[0].home_company_name, 'Acme Ltd');
  assert.strictEqual(r.users[0].role, 'pm');
});

test('sites page: the button is gated on canAddExternalMember and the modal calls the api', () => {
  const s = src('pages/sites.js');
  assert.match(s, /canAddExternalMember\(caller\)\)\s*\? React\.createElement\('button'[\s\S]{0,200}'Add external member'/);
  assert.match(s, /orgApi\.addExternalMember\(props\.siteId, \{ email: email, role: role \}\)/);
  assert.match(s, /setMsg\(orgApi\.externalMemberErrorMessage\(err\)\)/);
  assert.match(s, /onAdded: function \(\) \{ setUsersTick/);
  assert.match(s, /\[sel && sel\.site_id, usersTick\]/);
});

test('every site-member list marks external people', () => {
  assert.match(src('pages/sites.js'), /u\.external && Badge[\s\S]{0,250}externalBadgeText\(u\)/);
  assert.match(src('pages/team.js'), /u\.external && Badge[\s\S]{0,250}externalBadgeText\(u\)/);
  for (const f of ['tasks', 'today', 'timeline']) {
    assert.match(src('pages/' + f + '.js'), /u\.external \? ' \(' \+ window\.FS\.api\.org\.externalBadgeText\(u\)/, f);
  }
});

test('no project picker filters by the caller\'s company (external sites come through /me and /sites)', () => {
  const dir = path.join(__dirname, '..', 'scripts');
  const hits = [];
  (function walk(d) {
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) { if (n.name !== 'mock') walk(p); }
      else if (n.name.endsWith('.js') && /company_?id\s*[!=]==?\s*\w*(caller|me|user)\w*\.company/i.test(fs.readFileSync(p, 'utf8'))) hits.push(n.name);
    }
  })(dir);
  assert.deepStrictEqual(hits, []);
});
