'use strict';

/*
 * Company management through the api layer. The body is built HERE from
 * named fields: this layer drops anything it does not name, which has
 * silently lost fields in this repo before -- so every assertion is on the
 * body handed to orgRequest, not on an intermediate object.
 */
const test = require('node:test');
const assert = require('node:assert');

let calls;
let reply;   // (path, opts) -> value | Error

function loadOrg() {
  calls = [];
  global.window = {
    FieldSight: { fixtures: {} },
    FS: {
      api: {
        useMocks: false, orgWrites: true, timelineSource: 'aurora',
        orgBaseUrl: 'https://org.example/prod/api',
        delay: function () { return Promise.resolve(); },
        orgRequest: function (p, opts) {
          calls.push({ path: p, method: opts && opts.method, body: opts && opts.body });
          var v = reply(p, opts || {});
          return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
        },
      },
    },
  };
  delete require.cache[require.resolve('../scripts/api/org.js')];
  require('../scripts/api/org.js');
  return global.window.FS.api.org;
}

function conflict(existing) {
  var e = new Error('a company named \'' + existing.name + '\' already exists');
  e.status = 409;
  e.body = { error: e.message, existing: existing };
  return e;
}

test('createCompany posts only the named fields', async () => {
  reply = function () { return { company: { id: 'c-1', name: 'Frequency' } }; };
  const org = loadOrg();
  const res = await org.createCompany({ name: 'Frequency', bogus: 1, company_id: 'x' });
  assert.deepStrictEqual(calls, [{ path: '/companies', method: 'POST', body: { name: 'Frequency' } }]);
  assert.deepStrictEqual(res, { company: { id: 'c-1', name: 'Frequency' } });
});

test('createCompany sends industry only when given', async () => {
  reply = function () { return { company: { id: 'c-1', name: 'F' } }; };
  const org = loadOrg();
  await org.createCompany({ name: 'F', industry: 'construction' });
  assert.deepStrictEqual(calls[0].body, { name: 'F', industry: 'construction' });
});

test('a 409 resolves to a conflict carrying the existing company, it does not throw', async () => {
  reply = function () { return conflict({ id: 'c-old', name: 'Frequency' }); };
  const org = loadOrg();
  const res = await org.createCompany({ name: 'frequency' });
  assert.strictEqual(res.conflict, true);
  assert.deepStrictEqual(res.existing, { id: 'c-old', name: 'Frequency' });
});

test('any other failure still rejects', async () => {
  reply = function () { var e = new Error('boom'); e.status = 500; return e; };
  const org = loadOrg();
  await assert.rejects(org.createCompany({ name: 'X' }));
});

test('renameCompany PATCHes the id with only the named fields', async () => {
  reply = function () { return { company: { id: 'c-1', name: 'New' } }; };
  const org = loadOrg();
  await org.renameCompany('c-1', { name: 'New', bogus: true });
  assert.deepStrictEqual(calls, [{ path: '/companies/c-1', method: 'PATCH', body: { name: 'New' } }]);
});

test('renameCompany passes a case-only change through untouched', async () => {
  reply = function () { return { company: { id: 'c-1', name: 'FREQUENCY' } }; };
  const org = loadOrg();
  const res = await org.renameCompany('c-1', { name: 'FREQUENCY' });
  assert.strictEqual(res.company.name, 'FREQUENCY');
  assert.strictEqual(calls.length, 1, 'no client-side pre-check may block it');
});

test('listCompanies reads the directory, sorted, and never falls back to the sites', async () => {
  reply = function (p) {
    if (p === '/companies') return { companies: [{ id: 'b', name: 'Zed' }, { id: 'a', name: 'Alpha' }] };
    throw new Error('unexpected ' + p);
  };
  const org = loadOrg();
  assert.deepStrictEqual(await org.listCompanies(), [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Zed' }]);
  assert.ok(!calls.some(function (c) { return c.path === '/sites'; }));
});

test('listCompanies is [] on denial, absence, junk or a throw', async () => {
  for (const r of [{ _accessDenied: true }, { _notFound: true }, { companies: 'x' }, new Error('x')]) {
    reply = function () { return r; };
    const org = loadOrg();
    assert.deepStrictEqual(await org.listCompanies(), [], 'for ' + JSON.stringify(r));
  }
});

test('in mock mode the writes refuse rather than pretend', async () => {
  reply = function () { return {}; };
  const org = loadOrg();
  window.FS.api.useMocks = true;
  await assert.rejects(org.createCompany({ name: 'X' }));
  await assert.rejects(org.renameCompany('c-1', { name: 'X' }));
  assert.strictEqual(calls.length, 0);
});
