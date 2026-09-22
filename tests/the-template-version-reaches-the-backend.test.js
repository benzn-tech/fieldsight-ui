'use strict';

/*
 * The generate request carries templateVersion, not just templateId.
 *
 * generateSessionReport builds its body as a WHITELIST -- opts are never
 * spread -- so any field not named there is dropped in silence. templateId was
 * named and templateVersion was not, and lambda_org_api._generation_request
 * reads both: given a templateId it does `int(body.get("templateVersion"))`
 * and answers 400 "templateVersion must be a number" when that is absent.
 *
 * So the modal would have sent a template, seen a 400 about a field it
 * believed it had sent, and pointed the search at the backend -- the one place
 * the bug was not.
 *
 * The other half of this file is the part that is easy to lose: a request that
 * names NO template must still be byte-identical to the one this function has
 * always sent. The fix is worthless if it changes every report generated
 * today, and `undefined` is only harmless because JSON.stringify drops such
 * keys (scripts/api/_fetch.js:258 is what does the encoding).
 */
const test = require('node:test');
const assert = require('node:assert');

let calls;

function loadOrg() {
  calls = [];
  global.window = {
    FieldSight: { fixtures: {} },
    FS: {
      api: {
        useMocks: false, orgWrites: true, timelineSource: 'aurora',
        orgBaseUrl: 'https://org.example/prod/api',
        delay: function () { return Promise.resolve(); },
        orgRequest: function (path, opts) {
          calls.push({ path: path, method: opts && opts.method, params: opts && opts.params, body: opts && opts.body });
          return Promise.resolve({ ok: true });
        },
      },
    },
  };
  delete require.cache[require.resolve('../scripts/api/org.js')];
  require('../scripts/api/org.js');
  return global.window.FS.api.org;
}

const BASE = { sessionId: 'sid1', date: '2026-09-10', user: 'James_Lamb', deliver: 'download' };

/* ---- THE test -------------------------------------------------------------- */

test('THE test: templateVersion travels when a template is named', async () => {
  const org = loadOrg();
  await org.generateSessionReport(Object.assign({}, BASE, {
    templateId: 'personal-meeting', templateVersion: 3,
  }));
  assert.strictEqual(calls[0].body.templateId, 'personal-meeting');
  assert.strictEqual(calls[0].body.templateVersion, 3);
});

test('the version survives JSON encoding as a number, not a string', async () => {
  /* _generation_request does int(...) on it, and rejects what int() cannot
     read. A version that arrived as "3" would still pass there, but one that
     arrived as null or "" would not -- so what matters is that the value is
     carried through untouched. */
  const org = loadOrg();
  await org.generateSessionReport(Object.assign({}, BASE, {
    templateId: 'personal-meeting', templateVersion: 3,
  }));
  const encoded = JSON.parse(JSON.stringify(calls[0].body));
  assert.strictEqual(encoded.templateVersion, 3);
  assert.strictEqual(typeof encoded.templateVersion, 'number');
});

test('version 1 is not mistaken for absent', async () => {
  const org = loadOrg();
  await org.generateSessionReport(Object.assign({}, BASE, {
    templateId: 'x', templateVersion: 1,
  }));
  assert.strictEqual(JSON.parse(JSON.stringify(calls[0].body)).templateVersion, 1);
});

/* ---- naming no template must not change ------------------------------------ */

test('no template named: neither field survives encoding', async () => {
  const org = loadOrg();
  await org.generateSessionReport(Object.assign({}, BASE));
  const encoded = JSON.parse(JSON.stringify(calls[0].body));
  assert.ok(!('templateId' in encoded), 'templateId must not be sent as null');
  assert.ok(!('templateVersion' in encoded), 'templateVersion must not be sent as null');
});

test('no template named: the encoded body is exactly what it always was', async () => {
  /* The whole request, spelled out. If this ever needs updating, the change
     reaches every report generated today -- which is the point of pinning it. */
  const org = loadOrg();
  await org.generateSessionReport(Object.assign({}, BASE, {
    title: 'Site walk', attendees: ['Ben'],
  }));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(calls[0].body)), {
    title: 'Site walk',
    attendees: ['Ben'],
    fields: {},
    deliver: 'download',
    recipients: [],
  });
});

test('a day report carries the template the same way a meeting does', async () => {
  const org = loadOrg();
  await org.generateSessionReport({
    scope: 'day', date: '2026-09-10', user: 'James_Lamb', deliver: 'download',
    templateId: 'personal-meeting', templateVersion: 3,
  });
  assert.strictEqual(calls[0].path, '/days/2026-09-10/report');
  assert.strictEqual(calls[0].body.templateVersion, 3);
});

/* ---- the whitelist itself -------------------------------------------------- */

test('a field nobody whitelisted is still dropped', async () => {
  /* Not a wish -- a guard. The bug this file is about was caused by the
     whitelist, and the fix must not turn it into a spread. */
  const org = loadOrg();
  await org.generateSessionReport(Object.assign({}, BASE, { somethingNew: 'x' }));
  assert.ok(!('somethingNew' in calls[0].body));
});
