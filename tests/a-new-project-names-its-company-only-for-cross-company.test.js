'use strict';

/*
 * A platform_admin who created a project through the UI watched it land in the
 * operator company instead of the customer's, because this frontend never sent
 * `target_company_id` and the server defaults to the caller's own company.
 *
 * The field has to survive THREE layers: the form state, the page's call, and
 * the api layer's explicit body whitelist (a field not named there is silently
 * dropped -- the trap that has bitten this repo repeatedly). So every
 * assertion on "reaches the request" is made on the body handed to
 * orgRequest, not on an intermediate object.
 *
 * And it is offered only to a caller the server would accept. is_cross_company
 * is platform_admin ONLY; a plain `admin` also has isAdmin=true and would be
 * refused 403, so isAdmin is not the gate.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let orgCalls;
let sitesResponse;

function loadOrg() {
  orgCalls = [];
  global.window = {
    FieldSight: { fixtures: {} },
    FS: {
      api: {
        useMocks: false, orgWrites: true, timelineSource: 'aurora',
        orgBaseUrl: 'https://org.example/prod/api',
        delay: function () { return Promise.resolve(); },
        orgRequest: function (p, opts) {
          orgCalls.push({ path: p, method: opts && opts.method, body: opts && opts.body });
          if (p === '/sites' && (!opts || !opts.method)) {
            return sitesResponse instanceof Error ? Promise.reject(sitesResponse) : Promise.resolve(sitesResponse);
          }
          return Promise.resolve({ id: 'new-site', name: 'x' });
        },
      },
    },
  };
  delete require.cache[require.resolve('../scripts/api/org.js')];
  require('../scripts/api/org.js');
  return global.window.FS.api.org;
}

const FORM = { name: 'SB1151 Waipuna Rise', location: 'Waipuna', client: 'Southbase',
               address: undefined, latitude: null, longitude: null };
const CUSTOMER = 'cccccccc-0000-0000-0000-000000000001';

/* What the page does on submit: one call, company chosen via the api helper. */
async function submitAs(org, caller, selected) {
  await org.createOrgSite(Object.assign({}, FORM,
    { targetCompanyId: org.companyChoiceFor(caller, selected) }));
  return orgCalls.filter(function (c) { return c.method === 'POST'; })[0].body;
}

test('a company admin naming a company sends NO company field (absent, not empty, not own id)', async () => {
  const org = loadOrg();
  const body = await submitAs(org, { role: 'admin', isAdmin: true }, CUSTOMER);
  assert.ok(!('target_company_id' in body), 'field must be absent, got ' + JSON.stringify(body));
});

test('every non-platform_admin role, and a cross-company caller who picked nothing, omit the field', async () => {
  const org = loadOrg();
  for (const c of [[{ role: 'gm' }, CUSTOMER], [{ role: 'pm' }, CUSTOMER], [{}, CUSTOMER],
                   [null, CUSTOMER], [{ role: 'platform_admin' }, ''], [{ role: 'platform_admin' }, undefined]]) {
    orgCalls = [];
    const body = await submitAs(org, c[0], c[1]);
    assert.ok(!('target_company_id' in body), JSON.stringify(c) + ' -> ' + JSON.stringify(body));
  }
});

test('a platform_admin selection reaches the body the api layer hands to orgRequest', async () => {
  const org = loadOrg();
  const body = await submitAs(org, { role: 'platform_admin', isAdmin: true }, CUSTOMER);
  assert.strictEqual(body.target_company_id, CUSTOMER);
  assert.strictEqual(body.name, FORM.name);
});

test('the api layer drops fields it does not name, so the whitelist is the thing under test', async () => {
  const org = loadOrg();
  await org.createOrgSite(Object.assign({}, FORM, { company_id: CUSTOMER, bogus: 1 }));
  const body = orgCalls[0].body;
  assert.ok(!('company_id' in body) && !('bogus' in body) && !('target_company_id' in body));
});

test('only platform_admin counts as cross-company (isAdmin does not)', () => {
  const org = loadOrg();
  assert.strictEqual(org.isCrossCompany({ role: 'platform_admin' }), true);
  assert.strictEqual(org.isCrossCompany({ role: 'admin', isAdmin: true }), false);
  assert.strictEqual(org.isCrossCompany(undefined), false);
});

test('the companies list is the distinct companies on the visible sites', async () => {
  const org = loadOrg();
  sitesResponse = { sites: [
    { id: 's1', company_id: 'b', company_name: 'Southbase' },
    { id: 's2', company_id: 'b', company_name: 'Southbase' },
    { id: 's3', company_id: 'a', company_name: 'Acme' },
    { id: 's4' } ] };
  assert.deepStrictEqual(await org.getSiteCompanies(),
    [{ id: 'a', name: 'Acme' }, { id: 'b', name: 'Southbase' }]);
});

test('when the companies lookup fails the form still submits, with no company field', async () => {
  const org = loadOrg();
  sitesResponse = new Error('network down');
  assert.deepStrictEqual(await org.getSiteCompanies(), []);
  sitesResponse = { _accessDenied: true };
  assert.deepStrictEqual(await org.getSiteCompanies(), []);
  const body = await submitAs(org, { role: 'platform_admin' }, '');
  assert.strictEqual(orgCalls.filter(function (c) { return c.method === 'POST'; }).length, 1);
  assert.ok(!('target_company_id' in body));
});

/* Wiring only -- the page is a browser IIFE with no export. The behaviour above
   is what matters; this pins that the page actually passes the choice on. */
test('the New project page passes the gated choice to createOrgSite', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'sites.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  assert.match(src, /targetCompanyId:\s*orgApi\.companyChoiceFor\(callerUser,\s*form\.company_id\)/);
  assert.match(src, /mayPickCompany && companies\.length > 0/);
});
