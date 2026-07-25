'use strict';

/*
 * Unit tests for scripts/api/org.js's two compliance-resolution calls —
 * moving safety/quality "mark resolved" off the UNAUTHENTICATED legacy overlay
 * (POST /api/actions/toggle) onto the durable, ACL'd compliance_resolutions
 * endpoints (backend migration 0025):
 *   setComplianceResolution({domain, site, reportDate, userFolder, text, resolved})
 *     -> PATCH /compliance/resolution   (server computes the hash from text)
 *   getComplianceResolutions({from, to, site, domain})
 *     -> GET  /compliance/resolutions   (range read for the union aggregator)
 *
 * Covers: the request shape (snake_case body / params the backend expects),
 * the aurora + orgBaseUrl gate (copied verbatim from getSessions'
 * timelineSource==='aurora' && orgBaseUrl — NOT orgWrite()), the mock/kill
 * switch fallbacks, and that _accessDenied/_notFound envelopes pass straight
 * through untouched (a refused resolve must never be swallowed into a phantom
 * success). Plus a guard that the MANUAL-observation path (updateObservation)
 * is unchanged — the migration must not touch it.
 *
 * org.js is a browser IIFE that registers onto window.FS.api at load; a minimal
 * window stub is enough under Node (same posture as tests/session-picker.test.js).
 */
const test = require('node:test');
const assert = require('node:assert');

let orgCalls;
let orgResponse;

function loadOrg(overrides) {
  orgCalls = [];
  global.window = {
    FieldSight: { fixtures: {} },
    FS: {
      api: Object.assign({
        useMocks:       false,
        orgWrites:      true,
        timelineSource: 'aurora',
        orgBaseUrl:     'https://org.example/prod/api',
        delay:          function () { return Promise.resolve(); },
        orgRequest:     function (path, opts) {
          orgCalls.push({ path: path, method: opts && opts.method, body: opts && opts.body, params: opts && opts.params });
          return Promise.resolve(orgResponse);
        },
      }, overrides || {}),
    },
  };
  delete require.cache[require.resolve('../scripts/api/org.js')];
  require('../scripts/api/org.js');
  return global.window.FS.api.org;
}

const SITE_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/* ---- setComplianceResolution: request shape ------------------------------ */

test('setComplianceResolution PATCHes /compliance/resolution with the snake_case body the backend expects', async () => {
  const org = loadOrg();
  orgResponse = { resolved: true, resolved_by: 'Ben_UCPK', resolved_at: '2026-07-26T02:00:00+00:00',
                  content_hash: '534afd68', content_sample: 'loose handrail on level 3' };

  const res = await org.setComplianceResolution({
    domain: 'safety', site: SITE_UUID, reportDate: '2026-07-20',
    userFolder: 'Jarley_Trainor', text: 'Loose handrail on level 3', resolved: true,
  });

  assert.deepStrictEqual(orgCalls, [{
    path: '/compliance/resolution', method: 'PATCH', params: undefined,
    body: {
      domain: 'safety', site: SITE_UUID, report_date: '2026-07-20',
      user_folder: 'Jarley_Trainor', text: 'Loose handrail on level 3', resolved: true,
    },
  }]);
  assert.strictEqual(res.resolved_by, 'Ben_UCPK', 'the resolver comes back from the response, untouched');
});

test('setComplianceResolution sends `site` (the org UUID) and NEVER a client-computed hash', async () => {
  const org = loadOrg();
  orgResponse = { resolved: true };
  await org.setComplianceResolution({
    domain: 'quality', site: SITE_UUID, reportDate: '2026-07-20',
    userFolder: 'Jarley_Trainor', text: 'Rebar spacing check', resolved: true,
  });
  const body = orgCalls[0].body;
  assert.strictEqual(body.site, SITE_UUID);
  assert.strictEqual('content_hash' in body, false, 'the server hashes text; the client must never send a hash');
  assert.strictEqual('hash' in body, false);
});

test('setComplianceResolution coerces resolved to a boolean (reopen path)', async () => {
  const org = loadOrg();
  orgResponse = { resolved: false };
  await org.setComplianceResolution({ domain: 'safety', site: SITE_UUID, reportDate: '2026-07-20',
                                      userFolder: 'X', text: 'y', resolved: false });
  assert.strictEqual(orgCalls[0].body.resolved, false);
});

/* ---- setComplianceResolution: the aurora + orgBaseUrl gate ---------------- */

test('setComplianceResolution does NOT hit the backend when timelineSource is not aurora', async () => {
  const org = loadOrg({ timelineSource: 'report' });
  const res = await org.setComplianceResolution({ domain: 'safety', site: SITE_UUID, reportDate: '2026-07-20',
                                                  userFolder: 'X', text: 'y', resolved: true });
  assert.strictEqual(orgCalls.length, 0, 'no aurora timeline -> no durable endpoint to write');
  assert.strictEqual(res.resolved, true, 'benign optimistic echo, not a crash');
  assert.strictEqual(res.resolved_by, null);
});

test('setComplianceResolution does NOT hit the backend when orgBaseUrl is empty (kill switch)', async () => {
  const org = loadOrg({ orgBaseUrl: '' });
  await org.setComplianceResolution({ domain: 'safety', site: SITE_UUID, reportDate: '2026-07-20',
                                      userFolder: 'X', text: 'y', resolved: true });
  assert.strictEqual(orgCalls.length, 0);
});

test('setComplianceResolution does NOT hit the backend in mock mode', async () => {
  const org = loadOrg({ useMocks: true });
  await org.setComplianceResolution({ domain: 'safety', site: SITE_UUID, reportDate: '2026-07-20',
                                      userFolder: 'X', text: 'y', resolved: true });
  assert.strictEqual(orgCalls.length, 0);
});

/* ---- setComplianceResolution: sentinels pass through --------------------- */

test('setComplianceResolution lets an _accessDenied envelope through untouched — never swallowed', async () => {
  const org = loadOrg();
  orgResponse = { _accessDenied: true, status: 403, error: "admin/gm or this site's pm/site_manager only" };
  const res = await org.setComplianceResolution({ domain: 'safety', site: SITE_UUID, reportDate: '2026-07-20',
                                                  userFolder: 'X', text: 'y', resolved: true });
  assert.strictEqual(res._accessDenied, true);
  assert.match(res.error, /pm\/site_manager only/);
});

test('setComplianceResolution lets a _notFound envelope through untouched', async () => {
  const org = loadOrg();
  orgResponse = { _notFound: true, status: 404 };
  const res = await org.setComplianceResolution({ domain: 'safety', site: SITE_UUID, reportDate: '2026-07-20',
                                                  userFolder: 'X', text: 'y', resolved: true });
  assert.strictEqual(res._notFound, true);
});

/* ---- getComplianceResolutions: request shape + gate + sentinels ---------- */

test('getComplianceResolutions GETs /compliance/resolutions with from/to/site/domain params', async () => {
  const org = loadOrg();
  orgResponse = { resolutions: [{ site_id: SITE_UUID, report_date: '2026-07-20', domain: 'safety',
                                  user_folder: 'Jarley_Trainor', content_hash: '534afd68',
                                  content_sample: 'loose handrail on level 3', resolved: true,
                                  resolved_by: 'Ben_UCPK', resolved_at: '2026-07-26T02:00:00+00:00' }] };
  const res = await org.getComplianceResolutions({ from: '2026-07-01', to: '2026-07-26', site: SITE_UUID, domain: 'safety' });
  assert.deepStrictEqual(orgCalls, [{
    path: '/compliance/resolutions', method: undefined, body: undefined,
    params: { from: '2026-07-01', to: '2026-07-26', site: SITE_UUID, domain: 'safety' },
  }]);
  assert.strictEqual(res.resolutions.length, 1);
});

test('getComplianceResolutions omits site/domain gracefully (the global Insights read)', async () => {
  const org = loadOrg();
  orgResponse = { resolutions: [] };
  await org.getComplianceResolutions({ from: '2026-07-01', to: '2026-07-26' });
  assert.deepStrictEqual(orgCalls[0].params, { from: '2026-07-01', to: '2026-07-26', site: undefined, domain: undefined });
});

test('getComplianceResolutions falls back to an empty list off-aurora / in mock mode (no crash)', async () => {
  assert.deepStrictEqual((await loadOrg({ timelineSource: 'report' })
    .getComplianceResolutions({ from: 'a', to: 'b' })).resolutions, []);
  assert.strictEqual(orgCalls.length, 0);
  assert.deepStrictEqual((await loadOrg({ orgBaseUrl: '' })
    .getComplianceResolutions({ from: 'a', to: 'b' })).resolutions, []);
  assert.deepStrictEqual((await loadOrg({ useMocks: true })
    .getComplianceResolutions({ from: 'a', to: 'b' })).resolutions, []);
});

test('getComplianceResolutions lets an _accessDenied envelope through untouched', async () => {
  const org = loadOrg();
  orgResponse = { _accessDenied: true, status: 403, error: 'no reach' };
  const res = await org.getComplianceResolutions({ from: 'a', to: 'b', site: SITE_UUID });
  assert.strictEqual(res._accessDenied, true);
});

/* ---- the manual-observation path is untouched by the migration ----------- */

test('updateObservation still routes to /observations (the manual path is NOT repointed)', async () => {
  const org = loadOrg();
  orgResponse = { id: 'obs-1', status: 'closed' };
  await org.updateObservation('obs-1', { status: 'closed' });
  assert.strictEqual(orgCalls[0].path, '/observations/obs-1');
  assert.strictEqual(orgCalls[0].method, 'PATCH');
  assert.strictEqual(orgCalls[0].path.indexOf('compliance'), -1,
    'manual observations must never route through the compliance-resolution endpoint');
});
