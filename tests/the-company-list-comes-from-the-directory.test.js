'use strict';

/*
 * The New Project company picker was populated by deriving distinct companies
 * from `GET /sites` -- the companies you can SEE a site in. That list can never
 * contain a company with no site yet, so a platform_admin could not create any
 * company's FIRST project: the one case where naming the company matters most.
 *
 * `GET /companies` (platform_admin only, the same gate that alone lets
 * target_company_id be honoured) is the directory answer. These tests pin that
 * it is PREFERRED, that the sites-derived list survives ONLY as a fallback for
 * the window where the frontend has shipped and the route has not, and that no
 * failure path can cost the form its ability to submit.
 */
const test = require('node:test');
const assert = require('node:assert');

let orgCalls;
let routes;          // path -> value | Error | undefined (undefined => 404-ish)

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
          orgCalls.push({ path: p, method: opts && opts.method });
          var v = routes[p];
          if (v instanceof Error) return Promise.reject(v);
          if (v === undefined) return Promise.resolve({ _notFound: true });
          return Promise.resolve(v);
        },
      },
    },
  };
  delete require.cache[require.resolve('../scripts/api/org.js')];
  require('../scripts/api/org.js');
  return global.window.FS.api.org;
}

const DIRECTORY = {
  companies: [
    { id: 'c-zulu', name: 'Zulu Construction' },
    { id: 'c-alpha', name: 'Alpha Build' },
    // The whole point: this one has NO site, so the old derivation could never
    // offer it and its first project could never be created.
    { id: 'c-newco', name: 'Newco Ltd' },
  ],
};

const SITES = {
  sites: [
    { id: 's1', company_id: 'c-zulu', company_name: 'Zulu Construction' },
    { id: 's2', company_id: 'c-zulu', company_name: 'Zulu Construction' },
    { id: 's3', company_id: 'c-alpha', company_name: 'Alpha Build' },
  ],
};

test('the directory is asked first, and it carries a company that has no site', async () => {
  routes = { '/companies': DIRECTORY, '/sites': SITES };
  const org = loadOrg();
  const list = await org.getCompanyChoices();

  assert.deepStrictEqual(list, [
    { id: 'c-alpha', name: 'Alpha Build' },
    { id: 'c-newco', name: 'Newco Ltd' },
    { id: 'c-zulu', name: 'Zulu Construction' },
  ], 'sorted by name, and Newco -- which owns no site -- must be present');

  assert.ok(orgCalls.some(function (c) { return c.path === '/companies'; }),
    '/companies must be consulted');
  assert.ok(!orgCalls.some(function (c) { return c.path === '/sites'; }),
    'the sites fallback must NOT run when the directory answered -- otherwise the '
    + 'route is live and nobody would notice the old path still deciding');
});

test('a 404 from the route falls back to the sites-derived list', async () => {
  // The real window this protects: the frontend deployed to an environment
  // where /companies does not exist yet. Losing the control entirely would be
  // a regression against what shipped in #383.
  routes = { '/companies': undefined, '/sites': SITES };
  const org = loadOrg();
  assert.deepStrictEqual(await org.getCompanyChoices(), [
    { id: 'c-alpha', name: 'Alpha Build' },
    { id: 'c-zulu', name: 'Zulu Construction' },
  ]);
});

test('a thrown request, a denial, and a junk body all fall back rather than break', async () => {
  for (const bad of [new Error('network'), { _accessDenied: true }, { companies: 'nope' }, {}]) {
    routes = { '/companies': bad, '/sites': SITES };
    const org = loadOrg();
    assert.deepStrictEqual(await org.getCompanyChoices(), [
      { id: 'c-alpha', name: 'Alpha Build' },
      { id: 'c-zulu', name: 'Zulu Construction' },
    ], 'fell back for ' + JSON.stringify(bad));
  }
});

test('both sources failing yields an empty list, never a throw', async () => {
  // An empty list hides the control and the form submits exactly as it did
  // before any of this existed. It must never reject: the modal awaits this.
  routes = { '/companies': new Error('x'), '/sites': new Error('y') };
  const org = loadOrg();
  assert.deepStrictEqual(await org.getCompanyChoices(), []);
});

test('a directory row without an id is dropped, not rendered as a blank choice', async () => {
  routes = { '/companies': { companies: [{ name: 'No Id Co' }, { id: 'c-ok', name: 'Ok Co' }] },
             '/sites': SITES };
  const org = loadOrg();
  assert.deepStrictEqual(await org.getCompanyChoices(), [{ id: 'c-ok', name: 'Ok Co' }]);
});

test('a nameless company falls back to its id rather than an empty option', async () => {
  routes = { '/companies': { companies: [{ id: 'c-bare' }] }, '/sites': SITES };
  const org = loadOrg();
  assert.deepStrictEqual(await org.getCompanyChoices(), [{ id: 'c-bare', name: 'c-bare' }]);
});

test('an empty directory is an answer, not a failure -- it does not fall back', async () => {
  // A real empty list and a missing route are different states. Treating the
  // first as the second would resurrect the derivation silently.
  routes = { '/companies': { companies: [] }, '/sites': SITES };
  const org = loadOrg();
  assert.deepStrictEqual(await org.getCompanyChoices(), []);
  assert.ok(!orgCalls.some(function (c) { return c.path === '/sites'; }),
    'an authoritative empty answer must not be second-guessed');
});

test('the page reads the directory helper, not the fallback', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'pages', 'sites.js'), 'utf8');
  assert.match(src, /orgApi\.getCompanyChoices\(\)/,
    'the modal must call getCompanyChoices');
  assert.ok(!/orgApi\.getSiteCompanies/.test(src),
    'nothing on the page may reach past it to the sites-derived fallback');
});
